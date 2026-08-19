#!/usr/bin/env bash
#
# copy-data-to-prod.sh — seed the production host from this workstation.
# RUNS ON THE WORKSTATION. From the CLI:  ps prod copy-data [--force]
#
# In order:
#   1. The operator's config directory (~/.config/inmo-tool/config.yaml) —
#      both containers mount it, so without it the stack cannot start. Copied
#      with mode 0600: it holds API keys.
#   2. Secrets that live only in the workstation's .env (the Claude CLI token)
#      into the deployment's .env on the host.
#   3. The local `inmotool` database, dumped and restored.
#   4. Build and start the stack, then check what arrived matches what left.
#
# Re-runnable: --force drops the remote database and reloads it. Without
# --force it refuses to touch a database that already has tables, rather than
# merging two histories. --from-dump <file> seeds from a dump taken earlier,
# for when this workstation's stack cannot start.
#
# Host and paths come from PROD_HOST / PROD_PATH in ~/.config/inmo-tool/.env —
# never from this file. inmo-tool is a public repository.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${INMO_TOOL_CONFIG_DIR:-$HOME/.config/inmo-tool}"
DUMP_DIR="${REPO_ROOT}/data/backups"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
step() { echo -e "\n${CYAN}$*${NC}"; }
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}!${NC} $*"; }
die()  { echo -e "  ${RED}✗${NC} $*" >&2; exit 1; }

FORCE=false
FROM_DUMP=""
while [ $# -gt 0 ]; do
    case "$1" in
        --force)     FORCE=true; shift ;;
        # A dump taken earlier, for when this workstation's stack is not
        # running (its PostgreSQL publishes a fixed host port, so a second
        # checkout holding that port is enough to make `up` impossible).
        --from-dump) FROM_DUMP="${2:?--from-dump needs a file}"; shift 2 ;;
        *) die "unknown option '$1' (expected --force or --from-dump <file>)" ;;
    esac
done
[ -z "$FROM_DUMP" ] || [ -f "$FROM_DUMP" ] || die "no such dump: $FROM_DUMP"

[ -n "${PROD_HOST:-}" ] || die "PROD_HOST is not set — add it to ${CONFIG_DIR}/.env"
[ -n "${PROD_PATH:-}" ] || die "PROD_PATH is not set — add it to ${CONFIG_DIR}/.env"

# `bash -lc` so the remote PATH is the login one (Docker Desktop). Some login
# profiles write a tput warning to stderr when there is no TTY; that one line
# is filtered, everything else passes through.
remote() { ssh "$PROD_HOST" "bash -lc $(printf '%q' "$*")" 2> >(grep -v 'tput: No value for \$TERM' >&2); }
rpsql()  { remote "cd ${PROD_PATH} && ./deploy/prod-psql.sh $*"; }
unquote() { sed -e "s/^['\"]//" -e "s/['\"]\$//"; }
local_env()  { grep -E "^$1=" "${CONFIG_DIR}/.env" | head -1 | cut -d= -f2- | unquote; }
remote_env() { remote "grep -E '^$1=' ${PROD_PATH}/.env | head -1 | cut -d= -f2-" | unquote; }

# A failed psql prints nothing, and an empty string compared against "0" reads
# as "there is nothing there" instead of "I could not ask".
number() {
    case "$1" in
        ''|*[!0-9]*) die "could not query ${2} on the host (got: '${1}')" ;;
    esac
    echo "$1"
}

step "0. Checks"
[ -f "${CONFIG_DIR}/config.yaml" ] || die "no ${CONFIG_DIR}/config.yaml on this workstation"
remote "test -f ${PROD_PATH}/.env" || die "host not prepared — run 'ps prod install' first"
ok "host ready at ${PROD_PATH}"

DB_NAME="$(remote_env POSTGRES_DB)"; DB_NAME="${DB_NAME:-inmotool}"
[ -n "$(remote_env POSTGRES_ADMIN_PASSWORD)" ] || die "POSTGRES_ADMIN_PASSWORD is blank in ${PROD_PATH}/.env"
ok "target database '${DB_NAME}'"

step "1. Operator config → host"
remote "mkdir -p ~/.config/inmo-tool"
ssh "$PROD_HOST" "bash -lc 'cat > ~/.config/inmo-tool/config.yaml && chmod 600 ~/.config/inmo-tool/config.yaml'" \
    < "${CONFIG_DIR}/config.yaml"
ok "config.yaml copied (0600)"

step "2. Workstation-only secrets → host .env"
for var in CLAUDE_CODE_OAUTH_TOKEN OPENROUTER_API_KEY; do
    value="$(local_env "$var" || true)"
    if [ -z "$value" ]; then
        warn "$var is empty here — left as-is on the host"
        continue
    fi
    # Through stdin, never as an argument: ssh arguments show up in the host's
    # `ps` output and these are secrets.
    printf '%s' "$value" | remote "cd ${PROD_PATH} && ./deploy/set-env-var.sh ${var}"
    ok "$var"
done

step "3. Dump the local database"
mkdir -p "$DUMP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="${DUMP_DIR}/${DB_NAME}-${STAMP}.sql.gz"
LOCAL_DB="$(grep -E '^postgres.db:' "${CONFIG_DIR}/config.yaml" | head -1 | awk '{print $2}')"
LOCAL_DB="${LOCAL_DB:-inmotool}"
if [ -n "$FROM_DUMP" ]; then
    DUMP="$FROM_DUMP"
    # Counted from the dump itself: with no live database there is nothing
    # else to compare the restored row count against.
    LOCAL_LISTINGS="$(gunzip -c "$DUMP" | sed -n '/^COPY public.listing (/,/^\\\.$/p' | grep -vc '^COPY\|^\\\.' || true)"
    ok "using $DUMP ($(du -h "$DUMP" | cut -f1), ${LOCAL_LISTINGS} listings)"
elif docker compose -f "${REPO_ROOT}/docker-compose.yml" ps --status running --format '{{.Service}}' | grep -qx postgres; then
    # --no-owner/--no-acl: the roles are different over there (here the app
    # usually runs as the cluster superuser; in production it does not).
    docker compose -f "${REPO_ROOT}/docker-compose.yml" exec -T postgres \
        pg_dump -U postgres --no-owner --no-acl "$LOCAL_DB" | gzip > "$DUMP"
    LOCAL_LISTINGS="$(docker compose -f "${REPO_ROOT}/docker-compose.yml" exec -T postgres \
        psql -U postgres -d "$LOCAL_DB" -tAc 'SELECT count(*) FROM listing' | tr -d '[:space:]')"
    ok "dumped $(du -h "$DUMP" | cut -f1), ${LOCAL_LISTINGS} listings"
else
    # Nothing to migrate is a legitimate state: the connectors repopulate.
    warn "the local stack is down and no --from-dump given — starting empty"
    DUMP=""
    LOCAL_LISTINGS=""
fi

step "4. Create the database on the host"
remote "cd ${PROD_PATH} && docker compose -f docker-compose.prod.yml run --rm db-init" >/dev/null \
    || die "db-init failed"
ok "role and database ready"

# Counts the application's own objects. Two things would otherwise make a
# freshly created database look occupied: information_schema.tables also lists
# views, and db-init installs extensions whose views live in public. Hence
# relations and routines that no extension owns.
#
# Routines are counted too, and not as an afterthought: a restore that dies
# partway through leaves functions behind before it has created a single
# table, and a tables-only check called that database empty and skipped the
# drop — the next attempt then failed on "function ... already exists".
COUNT_OBJECTS_SQL="SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')) + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'))"

if [ "$FORCE" = true ]; then
    # Unconditional, deliberately: --force means "replace whatever is there",
    # and deciding from a count is what let a half-restored database through.
    warn "replacing '${DB_NAME}' from scratch (--force)"
    APP_USER="$(remote_env POSTGRES_USER)"; APP_USER="${APP_USER:-inmotool}"
    rpsql admin postgres -c "'DROP DATABASE IF EXISTS \"${DB_NAME}\" WITH (FORCE)'" >/dev/null
    rpsql admin postgres -c "'CREATE DATABASE \"${DB_NAME}\" OWNER \"${APP_USER}\"'" >/dev/null
    # The CONNECT revoke lives on the database object, so it went with the drop.
    remote "cd ${PROD_PATH} && docker compose -f docker-compose.prod.yml run --rm db-init" >/dev/null
else
    objects="$(number "$(rpsql app "$DB_NAME" -tAc "\"${COUNT_OBJECTS_SQL}\"" | tr -d '[:space:]')" "the contents of ${DB_NAME}")"
    [ "$objects" -eq 0 ] || die "'${DB_NAME}' already holds ${objects} object(s) on the host. Re-run with --force to replace it."
fi

if [ -n "$DUMP" ]; then
    step "5. Restore"
    # Every extension the dump needs, created first as the cluster admin.
    # db-init installs the two the schema always wants, but a database that
    # has been in use can carry more (the live one also uses unaccent, whose
    # text-search dictionary the restore references), and the app's role is
    # not allowed to create any of them. Reading the list from the dump means
    # this does not have to be kept in sync with the schema by hand.
    for ext in $(gunzip -c "$DUMP" | grep -oE '^CREATE EXTENSION IF NOT EXISTS [a-zA-Z0-9_]+' | awk '{print $NF}' | sort -u); do
        rpsql admin "$DB_NAME" -c "'CREATE EXTENSION IF NOT EXISTS \"${ext}\"'" >/dev/null \
            || die "could not create extension ${ext} in ${DB_NAME}"
        ok "extension ${ext}"
    done

    # Restored as the app's own role, so every object ends up owned by it: it
    # owns the database and its own migrations run against it on start.
    #
    # The extension statements are then dropped on the way through: they have
    # just been created above, as the admin, which makes the admin their owner,
    # and a dump's `COMMENT ON EXTENSION` would fail with "must be owner of
    # extension" — the app role cannot own an extension it is not allowed to
    # create. pg_dump writes these one per line, so a line filter is exact.
    gunzip -c "$DUMP" \
        | grep -vE '^(CREATE|COMMENT ON|ALTER) EXTENSION ' \
        | ssh "$PROD_HOST" \
        "bash -lc $(printf '%q' "cd ${PROD_PATH} && ./deploy/prod-psql.sh app ${DB_NAME} -q -o /dev/null")" \
        2> >(grep -v 'tput: No value for \$TERM' >&2) \
        || die "restore of ${DB_NAME} failed"
    ok "${DB_NAME} restored"
fi

step "6. Start the stack"
remote "cd ${PROD_PATH} && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d"
ok "containers started"

step "7. Verify"
if [ -n "$LOCAL_LISTINGS" ]; then
    PROD_LISTINGS="$(rpsql app "$DB_NAME" -tAc "'SELECT count(*) FROM listing'" | tr -d '[:space:]')"
    [ "$PROD_LISTINGS" = "$LOCAL_LISTINGS" ] && ok "listings: ${PROD_LISTINGS} = ${LOCAL_LISTINGS}" \
        || die "listings: ${PROD_LISTINGS} on the host vs ${LOCAL_LISTINGS} here"
fi

echo
echo -e "${GREEN}Done.${NC}"
echo -e "${DIM}Check it with: ps prod status${NC}"
