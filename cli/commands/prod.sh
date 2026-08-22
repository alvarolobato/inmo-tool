#!/usr/bin/env bash
# ps prod — drive the production deployment from this workstation over SSH.
#
# Production does NOT use docker-compose.yml. It uses docker-compose.prod.yml,
# which runs no PostgreSQL of its own: it connects to a cluster already
# running on the host and shared with other applications. See
# config/production.md.
#
# Everything host-specific comes from ~/.config/inmo-tool/.env, loaded by
# cli/commands/load-env.sh before this script runs — nothing about the
# deployment host is recorded in this public repository:
#
#   PROD_HOST        ssh target (user@host)                      required
#   PROD_PATH        deployment directory on the host            required
#   SHARED_NETWORK   Docker network the shared PostgreSQL is on  install only
#   POSTGRES_HOST    its name on that network                    install only
#   DASHBOARD_PORT   host port to publish the dashboard on       install only
#   ADMIN_ENV_FILE   file on the host holding the cluster admin
#                    credentials, if there is one                optional
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
DC_PROD="docker compose -f docker-compose.prod.yml"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'

usage() {
    cat <<'EOF'
Usage: ps prod <subcommand> [args]

Bring-up (once):
  install [--check-only]  Check the host, clone the repo, create data dirs and .env
  copy-data [--force] [--from-dump <file>]
                          Push operator config + secrets + the local database
                          (--force replaces a database that already has tables;
                           --from-dump seeds from a dump when the local stack
                           is not running)

Day to day:
  deploy                  git pull + rebuild + up -d on the host
  status                  Containers, deployed commit and health
  health                  Probe the dashboard endpoint
  logs [service]          Follow logs (e.g. ps prod logs etl)
  restart [service]       Restart everything, or one service
  psql <role> <db> ...    psql against the shared cluster (role: admin | app)
  backup                  pg_dump the database and download it here
  ssh                     Open a shell on the host

Configuration lives in ~/.config/inmo-tool/.env (PROD_HOST, PROD_PATH, ...) —
never in this repository, which is public.

Examples:
  ps prod status
  ps prod logs dashboard
  ps prod psql app inmotool -c 'SELECT count(*) FROM listing'
EOF
}

require_target() {
    [ -n "${PROD_HOST:-}" ] || { echo -e "${RED}ps prod: PROD_HOST is not set. Add it to ~/.config/inmo-tool/.env${NC}" >&2; exit 2; }
    [ -n "${PROD_PATH:-}" ] || { echo -e "${RED}ps prod: PROD_PATH is not set. Add it to ~/.config/inmo-tool/.env${NC}" >&2; exit 2; }
}

remote()     { require_target; ssh "$PROD_HOST" "bash -lc $(printf '%q' "$*")" 2> >(grep -v 'tput: No value for \$TERM' >&2); }
remote_tty() { require_target; ssh -t "$PROD_HOST" "bash -lc $(printf '%q' "$*")"; }
on_prod()    { remote "cd ${PROD_PATH} && $*"; }
# Reads one value from the host's .env, without the quotes some .env files put
# around values (docker compose strips them on read; `cut` does not).
remote_env() { remote "grep -E '^$1=' ${PROD_PATH}/.env | head -1 | cut -d= -f2-" | sed -e "s/^['\"]//" -e "s/['\"]\$//"; }

cmd_install() {
    require_target
    # The host settings are forwarded from this workstation's config, so the
    # installer needs no arguments and the repo needs no defaults for them.
    local fwd="INMO_PROD_HOME=$(printf %q "${PROD_PATH}")"
    for v in SHARED_NETWORK POSTGRES_HOST DASHBOARD_PORT ADMIN_ENV_FILE; do
        eval "local val=\${$v:-}"
        [ -n "$val" ] && fwd="$fwd $v=$(printf %q "$val")"
    done

    echo -e "${CYAN}Preparing ${PROD_HOST}${NC}"
    if remote "test -f ${PROD_PATH}/deploy/install-prod.sh"; then
        on_prod "git pull --ff-only origin main >/dev/null && env $fwd ./deploy/install-prod.sh $*"
    else
        # First run: there is no checkout yet, so the script travels over stdin.
        ssh "$PROD_HOST" "bash -lc $(printf '%q' "env $fwd bash -s -- $*")" \
            < "${REPO_ROOT}/deploy/install-prod.sh" \
            2> >(grep -v 'tput: No value for \$TERM' >&2)
    fi
}

cmd_copy_data() { exec "${REPO_ROOT}/deploy/copy-data-to-prod.sh" "$@"; }

# Stage the browser extension into the dashboard build context ON THE HOST, from
# the source that was just pulled. The dashboard image is built with context
# ./dashboard (docker-compose.prod.yml), so `browser-extension/` — a repo-root
# sibling — is NOT visible to the Dockerfile and the image can only ever contain
# whatever `dashboard/public/` held at build time. The host checkout does have
# the extension source; only the *build context* is narrowed, not the filesystem.
#
# This is the same post-pull/pre-build rule D-060 established for `ps stack`,
# which was never applied here. Without it every `ps prod deploy` rebuilt the
# image around the untracked artifacts some earlier hand-run had left on the
# host, which is how production served extension 0.14.9 — and reported
# servedVersion 0.14.9, so the update prompt never fired — for weeks after main
# had moved on (#693).
#
# Both guards run, because they fail on different things. The mtime guard is the
# one that would have caught #693: `git pull` rewrites the mtime of every file it
# changes, so a manifest bump leaves the source newer than a frozen zip and
# `find -newer` reports STALE. It was simply never invoked on this path. The
# content guard covers the narrower residue it cannot see — bytes that predate an
# un-versioned source edit behind a timestamp that does not.
#
# Failure policy, by consequence rather than by convenience:
#   - packaging fails but nothing stale is staged -> warn and continue. The
#     version file is simply absent, readServedExtensionVersion() yields null and
#     the CTA shows no update prompt. An unrelated backend fix should not be
#     blocked by a missing `zip` on the host.
#   - packaging fails AND a disagreeing artifact is still sitting there -> abort.
#     Building now would bake a version claim we know to be false, which is the
#     #693 bug itself. Better a refused deploy than a silent lie.
stage_extension_remote() {
    echo -e "${CYAN}Staging the browser extension from post-pull source${NC}"
    if ! on_prod "bash scripts/build-extension-zip.sh"; then
        echo -e "${YELLOW}warning: could not package the browser extension on the host.${NC}" >&2
    fi
    # Freshness (mtime): did the packager actually run over the source we just
    # pulled? This is the #693 shape — a bumped manifest sitting next to an
    # untouched zip — and the check that was missing from this path entirely.
    #
    # Gated on the zip existing, so the "nothing staged -> warn and continue"
    # policy above survives: the guard counts a MISSING zip as an error, but a
    # host with nothing staged is the safe degrade (servedVersion null, no
    # prompt), not a reason to refuse an unrelated backend deploy. A zip that IS
    # present and older than the pulled source is never safe.
    if ! on_prod "test ! -f dashboard/public/inmo-tool-extension.zip || bash scripts/check-extension-zip-fresh.sh"; then
        echo -e "${RED}ps prod deploy: the staged extension zip is older than browser-extension/.${NC}" >&2
        echo -e "${RED}Refusing to build — packaging did not run, or silently failed, over the pulled source.${NC}" >&2
        exit 1
    fi
    # Version content: the residue mtime cannot see — a staged artifact whose
    # bytes predate an un-versioned source edit but whose timestamp does not.
    if ! on_prod "bash scripts/check-extension-version-sync.sh"; then
        echo -e "${RED}ps prod deploy: the staged extension disagrees with browser-extension/manifest.json.${NC}" >&2
        echo -e "${RED}Refusing to build — the dashboard would report a wrong servedVersion and serve a stale zip.${NC}" >&2
        exit 1
    fi
}

cmd_deploy() {
    require_target
    echo -e "${CYAN}Deploying to ${PROD_HOST}:${PROD_PATH}${NC}"
    on_prod "git pull --ff-only origin main"
    # MUST come after the pull and before the build (D-060): staging pre-pull
    # source and then building is what shipped a stale extension in #334.
    stage_extension_remote
    # APP_GIT_DESCRIBE is computed there, on the commit just pulled: it is what
    # the dashboard reports as its version.
    on_prod "APP_GIT_DESCRIBE=\$(git describe --tags --always --dirty) ${DC_PROD} build"
    on_prod "APP_GIT_DESCRIBE=\$(git describe --tags --always --dirty) ${DC_PROD} up -d"
    echo -e "${GREEN}Deployed.${NC}"
    cmd_health
}

cmd_status() {
    echo -e "${CYAN}Containers${NC}";       on_prod "${DC_PROD} ps"
    echo -e "\n${CYAN}Deployed commit${NC}"; on_prod "git log -1 --format='%h %s (%cr)'"
    echo
    cmd_health
}

cmd_health() {
    local port code
    port="$(remote_env DASHBOARD_PORT)"
    [ -n "$port" ] || { echo -e "${RED}ps prod: DASHBOARD_PORT is not set in the host's .env${NC}" >&2; return 1; }
    echo -e "${CYAN}Health${NC}"
    code="$(remote "curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:${port}/api/health" || echo 000)"
    if [ "$code" = "200" ]; then
        echo -e "  ${GREEN}✓${NC} dashboard (port ${port})"
    else
        echo -e "  ${RED}✗${NC} dashboard (port ${port}) → HTTP ${code}"
        return 1
    fi
}

cmd_logs()    { remote_tty "cd ${PROD_PATH} && ${DC_PROD} logs -f --tail 100 $*"; }
cmd_restart() { on_prod "${DC_PROD} restart $*"; echo -e "${GREEN}Restarted.${NC}"; }
cmd_psql()    { remote_tty "cd ${PROD_PATH} && ./deploy/prod-psql.sh $*"; }
cmd_ssh()     { require_target; ssh -t "$PROD_HOST" "cd ${PROD_PATH} && exec \$SHELL -l"; }

cmd_backup() {
    require_target
    # Production data lives in a cluster this stack does not own, so a backup
    # is a logical dump — there is no data directory of ours to copy.
    local dest="${REPO_ROOT}/data/backups/prod" stamp db
    stamp="$(date +%Y%m%d-%H%M%S)"
    db="$(remote_env POSTGRES_DB)"; db="${db:-inmotool}"
    mkdir -p "$dest"
    echo -e "${DIM}dumping ${db}...${NC}"
    remote "cd ${PROD_PATH} && ./deploy/prod-pgdump.sh app ${db}" | gzip > "${dest}/${db}-${stamp}.sql.gz"
    echo -e "  ${GREEN}✓${NC} ${dest}/${db}-${stamp}.sql.gz ($(du -h "${dest}/${db}-${stamp}.sql.gz" | cut -f1))"
    echo -e "${YELLOW}Keep a copy off this machine.${NC}"
}

SUB="${1:-}"; shift || true
case "$SUB" in
    install)   cmd_install "$@" ;;
    copy-data) cmd_copy_data "$@" ;;
    deploy)    cmd_deploy "$@" ;;
    status)    cmd_status "$@" ;;
    health)    cmd_health "$@" ;;
    logs)      cmd_logs "$@" ;;
    restart)   cmd_restart "$@" ;;
    psql)      cmd_psql "$@" ;;
    backup)    cmd_backup "$@" ;;
    ssh)       cmd_ssh "$@" ;;
    ""|-h|--help|help) usage ;;
    *) echo -e "${RED}ps prod: unknown subcommand '${SUB}'${NC}" >&2; echo >&2; usage >&2; exit 1 ;;
esac
