#!/usr/bin/env bash
# ps connector — run/inspect registered site connectors (task 1.5, #13)
# Replaces the source project's `ps etl` group name — "connector" better
# matches this domain (etl.sh's generic table-sync framing doesn't apply;
# see docs/skills/connectors.md).
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Array, not a plain string — `$DC exec ...` would word-split and mangle a
# REPO_ROOT path containing spaces; `"${DC[@]}" exec ...` doesn't.
DC=(docker compose -f "${REPO_ROOT}/docker-compose.yml")
PG_USER="${POSTGRES_USER:-postgres}"
PG_DB="${POSTGRES_DB:-inmotool}"

usage() {
    cat <<EOF
Usage: ps connector <subcommand> [args]

Subcommands:
  list             Show registered connectors (name, rate limit)
  run [name]       Run one connector once, or all if name is omitted
  status           Show the most recent run per connector
  logs             Show ETL container logs (follow)
EOF
}

# True when the etl service has a *running* container — `docker compose ps
# --quiet` alone can still list an exited/stopped container on some Compose
# versions, which would route to `exec` (fails: nothing to exec into)
# instead of the `run --rm` fallback that actually works in that state.
_etl_container_running() {
    "${DC[@]}" ps --status running --quiet etl 2>/dev/null | grep -q .
}

# Runs a command inside the etl service/image — reuses the same container
# the real connectors run in, so this never depends on a local Python/venv
# being set up on the operator's machine (only Docker, which `ps stack`
# already requires). Single chokepoint for the exec-vs-run branch so
# cmd_list/cmd_run don't each reimplement it slightly differently.
_run_in_etl() {
    if _etl_container_running; then
        "${DC[@]}" exec -T etl "$@"
    else
        "${DC[@]}" run --rm etl "$@"
    fi
}

cmd_list() {
    echo -e "${CYAN}Registered connectors:${NC}"
    _run_in_etl python -c "
import etl.connectors
from etl import orchestrator
etl.connectors.register_all()
if not orchestrator.CONNECTORS:
    print('(none registered)')
for c in orchestrator.CONNECTORS:
    print(f'{c.name}\trate_limit={c.rate_limit_per_minute}/min\tcircuit_breaker_error_rate={c.circuit_breaker_error_rate}')
"
}

cmd_run() {
    local name="${1:-}"
    if [ -n "$name" ]; then
        echo -e "${CYAN}Running connector '${name}'...${NC}"
        _run_in_etl python -m etl.main --once --connector "$name"
    else
        echo -e "${CYAN}Running all registered connectors...${NC}"
        _run_in_etl python -m etl.main --once
    fi
}

cmd_status() {
    echo -e "${CYAN}Most recent run per connector:${NC}"
    "${DC[@]}" exec -T postgres psql \
        -U "${PG_USER}" \
        -d "${PG_DB}" \
        -v ON_ERROR_STOP=1 \
        -c "SELECT r.connector_name, r.status, r.discovered_count, r.fetched_count, r.skipped_count, r.error_count, to_char(r.finished_at, 'YYYY-MM-DD HH24:MI') AS finished_at FROM connector_run_results r WHERE r.finished_at = (SELECT max(r2.finished_at) FROM connector_run_results r2 WHERE r2.connector_name = r.connector_name) ORDER BY r.connector_name"
}

cmd_logs() {
    "${DC[@]}" logs -f etl
}

SUBCMD="${1:-}"
if [ -z "$SUBCMD" ] || [ "$SUBCMD" = "-h" ] || [ "$SUBCMD" = "--help" ]; then
    usage
    exit 0
fi
shift

case "$SUBCMD" in
    list)   cmd_list ;;
    run)    cmd_run "$@" ;;
    status) cmd_status ;;
    logs)   cmd_logs ;;
    *)
        echo -e "${RED}ps connector: unknown subcommand '${SUBCMD}'${NC}" >&2
        usage >&2
        exit 1
        ;;
esac
