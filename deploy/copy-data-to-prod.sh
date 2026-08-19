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
# merging two histories.
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
[ "${1:-}" = "--force" ] && FORCE=true

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
if docker compose -f "${REPO_ROOT}/docker-compose.yml" ps --status running --format '{{.Service}}' | grep -qx postgres; then
    # --no-owner/--no-acl: the roles are different over there (here the app
    # usually runs as the cluster superuser; in production it does not).
    docker compose -f "${REPO_ROOT}/docker-compose.yml" exec -T postgres \
        pg_dump -U postgres --no-owner --no-acl "$LOCAL_DB" | gzip > "$DUMP"
    LOCAL_LISTINGS="$(docker compose -f "${REPO_ROOT}/docker-compose.yml" exec -T postgres \
        psql -U postgres -d "$LOCAL_DB" -tAc 'SELECT count(*) FROM listing' | tr -d '[:space:]')"
    ok "dumped $(du -h "$DUMP" | cut -f1), ${LOCAL_LISTINGS} listings"
else
    # Nothing to migrate is a legitimate state: the connectors repopulate.
    warn "the local stack is down — starting with an empty database"
    DUMP=""
    LOCAL_LISTINGS=""
fi

step "4. Create the database on the host"
remote "cd ${PROD_PATH} && docker compose -f docker-compose.prod.yml run --rm db-init" >/dev/null \
    || die "db-init failed"
ok "role and database ready"

tables="$(number "$(rpsql app "$DB_NAME" -tAc "\"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'\"" | tr -d '[:space:]')" "the tables in ${DB_NAME}")"
if [ "$tables" -gt 0 ]; then
    [ "$FORCE" = true ] || die "'${DB_NAME}' already has ${tables} tables on the host. Re-run with --force to replace it."
    warn "'${DB_NAME}' had ${tables} tables — dropping and recreating (--force)"
    APP_USER="$(remote_env POSTGRES_USER)"; APP_USER="${APP_USER:-inmotool}"
    rpsql admin postgres -c "'DROP DATABASE \"${DB_NAME}\" WITH (FORCE)'" >/dev/null
    rpsql admin postgres -c "'CREATE DATABASE \"${DB_NAME}\" OWNER \"${APP_USER}\"'" >/dev/null
    # The CONNECT revoke lives on the database object, so it goes with the drop.
    remote "cd ${PROD_PATH} && docker compose -f docker-compose.prod.yml run --rm db-init" >/dev/null
fi

if [ -n "$DUMP" ]; then
    step "5. Restore"
    # As the app's own role, so every object ends up owned by it — it owns the
    # database and its own migrations run against it on start.
    gunzip -c "$DUMP" | ssh "$PROD_HOST" \
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
