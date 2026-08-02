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

DC="docker compose -f ${REPO_ROOT}/docker-compose.yml"
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

# Runs a short Python snippet inside the etl service/image — reuses the
# same container the real connectors run in, so this never depends on a
# local Python/venv being set up on the operator's machine (only Docker,
# which `ps stack` already requires).
_run_etl_python() {
    if $DC ps --quiet etl 2>/dev/null | grep -q .; then
        $DC exec -T etl python -c "$1"
    else
        $DC run --rm etl python -c "$1"
    fi
}

cmd_list() {
    echo -e "${CYAN}Registered connectors:${NC}"
    _run_etl_python "
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
        if $DC ps --quiet etl 2>/dev/null | grep -q .; then
            $DC exec -T etl python -m etl.main --once --connector "$name"
        else
            $DC run --rm etl python -m etl.main --once --connector "$name"
        fi
    else
        echo -e "${CYAN}Running all registered connectors...${NC}"
        if $DC ps --quiet etl 2>/dev/null | grep -q .; then
            $DC exec -T etl python -m etl.main --once
        else
            $DC run --rm etl python -m etl.main --once
        fi
    fi
}

cmd_status() {
    echo -e "${CYAN}Most recent run per connector:${NC}"
    $DC exec -T postgres psql \
        -U "${PG_USER}" \
        -d "${PG_DB}" \
        -c "SELECT r.connector_name, r.status, r.discovered_count, r.fetched_count, r.error_count, to_char(r.finished_at, 'YYYY-MM-DD HH24:MI') AS finished_at FROM connector_run_results r WHERE r.finished_at = (SELECT max(r2.finished_at) FROM connector_run_results r2 WHERE r2.connector_name = r.connector_name) ORDER BY r.connector_name"
}

cmd_logs() {
    $DC logs -f etl
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
