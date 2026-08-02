#!/usr/bin/env bash
# ps db — inspect the Postgres mirror (task 1.5, #13)
# No 4D-specific read-only-statement rejection here (that existed in the
# source project's sql.sh to protect a vendor-managed ERP we only ever
# read from) — this is our own database. `query` still runs inside a
# read-only transaction as a safety habit against fat-fingered SQL, not
# because anything else in this repo depends on it being enforced.
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
Usage: ps db <subcommand> [args]

Subcommands:
  tables            List all tables with row counts
  describe <table>  Show columns for a table
  query "<SQL>"     Run a query inside a read-only transaction
EOF
}

_psql() {
    $DC exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" "$@"
}

cmd_tables() {
    echo -e "${CYAN}Tables:${NC}"
    _psql -c "SELECT relname AS table_name, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY relname"
}

cmd_describe() {
    local table="${1:-}"
    if [ -z "$table" ]; then
        echo -e "${RED}ps db describe: table name required${NC}" >&2
        exit 1
    fi
    echo -e "${CYAN}Columns for ${table}:${NC}"
    _psql -c "\d ${table}"
}

cmd_query() {
    local sql="${1:-}"
    if [ -z "$sql" ]; then
        echo -e "${RED}ps db query: SQL string required${NC}" >&2
        exit 1
    fi
    _psql --single-transaction -c "SET TRANSACTION READ ONLY" -c "$sql"
}

SUBCMD="${1:-}"
if [ -z "$SUBCMD" ] || [ "$SUBCMD" = "-h" ] || [ "$SUBCMD" = "--help" ]; then
    usage
    exit 0
fi
shift

case "$SUBCMD" in
    tables)   cmd_tables ;;
    describe) cmd_describe "$@" ;;
    query)    cmd_query "$@" ;;
    *)
        echo -e "${RED}ps db: unknown subcommand '${SUBCMD}'${NC}" >&2
        usage >&2
        exit 1
        ;;
esac
