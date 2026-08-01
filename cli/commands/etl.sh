#!/usr/bin/env bash
# ps etl — ETL operations
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

DC="docker compose -f ${REPO_ROOT}/docker-compose.yml"
PG_USER="${POSTGRES_USER:-postgres}"
PG_DB="${POSTGRES_DB:-powershop}"

usage() {
    cat <<EOF
Usage: ps etl <subcommand>

Subcommands:
  run       Run ETL sync once
  status    Show watermark table (last sync per table)
  tables    Show row counts for synced tables
  logs      Show ETL container logs (follow)
EOF
}

cmd_run() {
    echo -e "${CYAN}Running ETL sync...${NC}"
    # Use -T to avoid TTY issues in non-interactive environments
    if $DC ps --quiet etl 2>/dev/null | grep -q .; then
        $DC exec -T etl python -m etl.main --once
    else
        $DC run --rm etl python -m etl.main --once
    fi
}

cmd_status() {
    echo -e "${CYAN}ETL watermarks:${NC}"
    $DC exec -T postgres psql \
        -U "${PG_USER}" \
        -d "${PG_DB}" \
        -c "SELECT table_name, rows_synced, status, to_char(updated_at, 'YYYY-MM-DD HH24:MI') as last_sync FROM etl_watermarks ORDER BY updated_at DESC"
}

cmd_tables() {
    echo -e "${CYAN}Synced table row counts:${NC}"
    $DC exec -T postgres psql \
        -U "${PG_USER}" \
        -d "${PG_DB}" \
        -c "SELECT tablename, n_live_tup as rows FROM pg_stat_user_tables WHERE tablename LIKE 'ps_%' ORDER BY n_live_tup DESC"
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
    run)    cmd_run ;;
    status) cmd_status ;;
    tables) cmd_tables ;;
    logs)   cmd_logs ;;
    *)
        echo -e "${RED}ps etl: unknown subcommand '${SUBCMD}'${NC}" >&2
        usage >&2
        exit 1
        ;;
esac
