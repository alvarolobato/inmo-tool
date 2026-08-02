#!/usr/bin/env bash
# ps db — inspect the Postgres mirror (task 1.5, #13)
#
# `query` validates through cli/lib/sql_guard.py (a single SELECT
# statement, allowlist-based — see that file's docstring) before ever
# reaching psql. This is NOT a leftover 4D-era restriction kept out of
# habit: `SET TRANSACTION READ ONLY` alone was tried first and found
# trivially bypassable during PR #50 review — `COMMIT; DELETE ...`,
# `SET TRANSACTION READ WRITE; DELETE ...`, and psql meta-commands like
# `\! id` (arbitrary shell exec inside the container, as the default
# PG_USER is the postgres superuser) all got through it. sql_guard's
# single-statement-starting-with-SELECT check rejects all of those
# up front, before any of it reaches the database or the shell.
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Array, not a plain string — see connector.sh's identical comment.
DC=(docker compose -f "${REPO_ROOT}/docker-compose.yml")
PG_USER="${POSTGRES_USER:-postgres}"
PG_DB="${POSTGRES_DB:-inmotool}"

usage() {
    cat <<EOF
Usage: ps db <subcommand> [args]

Subcommands:
  tables            List all tables with row counts
  describe <table>  Show columns for a table
  query "<SQL>"      Run a single SELECT (validated by cli/lib/sql_guard.py)
EOF
}

_psql() {
    "${DC[@]}" exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" "$@"
}

# Runs on the host via plain `python3` (sql_guard.py has zero dependencies
# beyond stdlib) — not inside the etl container, which doesn't have cli/lib/
# in its image (the etl Dockerfile only COPYs the etl/ build context).
# $sql is passed as a real argv element (sys.argv[2]), never interpolated
# into the Python source text — the whole point is to not trust its
# contents, so it must never become code itself, shell or Python.
_validate_readonly_sql_or_die() {
    local sql="$1"
    local error
    if ! error="$(python3 -c '
import sys
sys.path.insert(0, sys.argv[1])
from sql_guard import validate_readonly_sql
err = validate_readonly_sql(sys.argv[2])
if err:
    print(err)
    sys.exit(1)
' "${REPO_ROOT}/cli/lib" "$sql" 2>&1)"; then
        echo -e "${RED}ps db query: ${error}${NC}" >&2
        exit 1
    fi
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
    _validate_readonly_sql_or_die "$sql"
    # Belt-and-suspenders on top of the allowlist guard above, not the
    # primary defense (see the module header comment for why the
    # transaction-level restriction alone was found insufficient).
    _psql -v ON_ERROR_STOP=1 --single-transaction -c "SET TRANSACTION READ ONLY" -c "$sql"
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
