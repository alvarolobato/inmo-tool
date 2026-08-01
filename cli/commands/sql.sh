#!/usr/bin/env bash
# ps sql — 4D SQL operations (read-only)
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
VENV_PYTHON="${REPO_ROOT}/.venv/bin/python3"

RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Ensure venv exists
if [ ! -f "$VENV_PYTHON" ]; then
    echo -e "${RED}Python venv not found. Run: python3 -m venv .venv && .venv/bin/pip install p4d${NC}" >&2
    exit 1
fi

usage() {
    cat <<EOF
Usage: ps sql <subcommand> [options]

Subcommands:
  tables              List all tables with row counts
  describe <table>    Show columns for a table
  query "<SQL>"       Run a read-only SQL query
  sample <table> [n]  Show n sample rows (default: 5)
  schema              Full schema discovery (writes to docs/)
  count <table>       Row count for a table

All operations are READ-ONLY. No data modification is performed.
EOF
}

SUBCMD="${1:-}"
if [ -z "$SUBCMD" ] || [ "$SUBCMD" = "-h" ] || [ "$SUBCMD" = "--help" ]; then
    usage
    exit 0
fi
shift

case "$SUBCMD" in
    tables)
        "$VENV_PYTHON" -c "
import p4d, os
conn = p4d.connect(host=os.environ['P4D_HOST'], port=int(os.environ['P4D_PORT']),
                   user=os.environ.get('P4D_USER',''), password=os.environ.get('P4D_PASSWORD',''))
cur = conn.cursor()
cur.execute('SELECT * FROM _USER_TABLES')
tables = cur.fetchall()
print(f'Tables: {len(tables)}')
print(f'{\"Table\":<40} {\"ID\":>5}')
print('-' * 47)
for t in sorted(tables, key=lambda x: x[0]):
    print(f'{t[0]:<40} {t[2]:>5}')
conn.close()
"
        ;;
    describe)
        TABLE="${1:?Table name required}"
        "$VENV_PYTHON" -c "
import p4d, os, re, sys
_SAFE_ID = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
if not _SAFE_ID.match(sys.argv[1]):
    print(f'ERROR: Invalid table name: {sys.argv[1]!r}. Only letters, digits, and underscores allowed.', file=sys.stderr)
    sys.exit(1)
conn = p4d.connect(host=os.environ['P4D_HOST'], port=int(os.environ['P4D_PORT']),
                   user=os.environ.get('P4D_USER',''), password=os.environ.get('P4D_PASSWORD',''))
cur = conn.cursor()
cur.execute(\"SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, DATA_LENGTH FROM _USER_COLUMNS WHERE TABLE_NAME = '\"+sys.argv[1]+\"'\")
cols = cur.fetchall()
if not cols:
    print(f'Table {sys.argv[1]} not found or has no columns')
    sys.exit(1)
# Get row count
try:
    cur.execute(f'SELECT COUNT(*) FROM {sys.argv[1]}')
    count = cur.fetchone()[0]
    print(f'Table: {sys.argv[1]} ({count:,} rows)')
except:
    print(f'Table: {sys.argv[1]}')
print(f'{\"Column\":<40} {\"Type\":<20} {\"Nullable\":<10} {\"Length\":>8}')
print('-' * 80)
for c in cols:
    print(f'{c[0]:<40} {c[1]:<20} {\"YES\" if c[2] else \"NO\":<10} {c[3] or \"\":>8}')
conn.close()
" "$TABLE"
        ;;
    query)
        SQL="${1:?SQL query required}"
        "$VENV_PYTHON" -c "
import os, sys
# Read-only allowlist guard (cli/lib/sql_guard.py — issue #832). Validate
# BEFORE importing p4d or opening any connection to the production ERP.
sys.path.insert(0, sys.argv[2])
from sql_guard import validate_readonly_sql
sql = sys.argv[1]
err = validate_readonly_sql(sql)
if err:
    print(f'ERROR: {err}', file=sys.stderr)
    sys.exit(1)
import p4d
conn = p4d.connect(host=os.environ['P4D_HOST'], port=int(os.environ['P4D_PORT']),
                   user=os.environ.get('P4D_USER',''), password=os.environ.get('P4D_PASSWORD',''))
cur = conn.cursor()
cur.execute(sql)
if cur.description:
    headers = [d[0] for d in cur.description]
    rows = cur.fetchall()
    def fmt(v):
        if v is None: return 'NULL'
        if isinstance(v, bytes): return v.decode('utf-8', errors='replace')
        return str(v)
    print('\t'.join(fmt(h) for h in headers))
    for row in rows:
        print('\t'.join(fmt(v) for v in row))
    print(f'\n({len(rows)} rows)')
conn.close()
" "$SQL" "${REPO_ROOT}/cli/lib"
        ;;
    sample)
        TABLE="${1:?Table name required}"
        N="${2:-5}"
        "$VENV_PYTHON" -c "
import p4d, os, re, sys
_SAFE_ID = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
if not _SAFE_ID.match(sys.argv[1]):
    print(f'ERROR: Invalid table name: {sys.argv[1]!r}. Only letters, digits, and underscores allowed.', file=sys.stderr)
    sys.exit(1)
try:
    limit = int(sys.argv[2])
    if limit <= 0:
        raise ValueError
except ValueError:
    print(f'ERROR: Invalid LIMIT: {sys.argv[2]!r}. Must be a positive integer.', file=sys.stderr)
    sys.exit(1)
conn = p4d.connect(host=os.environ['P4D_HOST'], port=int(os.environ['P4D_PORT']),
                   user=os.environ.get('P4D_USER',''), password=os.environ.get('P4D_PASSWORD',''))
cur = conn.cursor()
# Get supported columns (skip type 0/unknown that p4d can't handle)
cur.execute(f\"SELECT COLUMN_NAME, DATA_TYPE FROM _USER_COLUMNS WHERE TABLE_NAME = '{sys.argv[1]}'\")
cols = cur.fetchall()
supported = [c[0] for c in cols if c[1] in (1,3,4,6,8,9,10,12,18,21)]
if not supported:
    print(f'No queryable columns found for {sys.argv[1]}')
    sys.exit(1)
# Limit to first 30 columns for readability
display_cols = supported[:30]
col_list = ', '.join(display_cols)
try:
    cur.execute(f'SELECT {col_list} FROM {sys.argv[1]} LIMIT {limit}')
    if cur.description:
        headers = [d[0] for d in cur.description]
        rows = cur.fetchall()
        def fmt(v):
            if v is None: return 'NULL'
            if isinstance(v, bytes): return v.decode('utf-8', errors='replace')
            return str(v)
        print('\t'.join(fmt(h) for h in headers))
        for row in rows:
            print('\t'.join(fmt(v) for v in row))
        if len(supported) > 30:
            print(f'\n({len(rows)} rows, showing {len(display_cols)}/{len(supported)} supported columns)')
        else:
            print(f'\n({len(rows)} rows)')
except Exception as e:
    print(f'Error: {e}')
conn.close()
" "$TABLE" "$N"
        ;;
    count)
        TABLE="${1:?Table name required}"
        "$VENV_PYTHON" -c "
import p4d, os, re, sys
_SAFE_ID = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
if not _SAFE_ID.match(sys.argv[1]):
    print(f'ERROR: Invalid table name: {sys.argv[1]!r}. Only letters, digits, and underscores allowed.', file=sys.stderr)
    sys.exit(1)
conn = p4d.connect(host=os.environ['P4D_HOST'], port=int(os.environ['P4D_PORT']),
                   user=os.environ.get('P4D_USER',''), password=os.environ.get('P4D_PASSWORD',''))
cur = conn.cursor()
cur.execute(f'SELECT COUNT(*) FROM {sys.argv[1]}')
print(cur.fetchone()[0])
conn.close()
" "$TABLE"
        ;;
    schema)
        echo -e "${CYAN}Running full schema discovery...${NC}"
        echo "Output: docs/schema-discovery.md"
        echo "(This may take a few minutes)"
        # Delegate to the schema discovery script if it exists, or point to docs
        if [ -f "${REPO_ROOT}/docs/schema-discovery.md" ]; then
            echo "Schema file already exists. To regenerate, delete docs/schema-discovery.md first."
        else
            echo "Run schema discovery with Claude or manually."
        fi
        ;;
    *)
        echo -e "${RED}ps sql: unknown subcommand '${SUBCMD}'${NC}" >&2
        usage >&2
        exit 1
        ;;
esac
