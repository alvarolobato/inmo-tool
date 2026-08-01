#!/usr/bin/env bash
# ps wren — WrenAI knowledge management
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WREN_SCRIPT="${REPO_ROOT}/scripts/wren-push-metadata.py"
PYTHON="${REPO_ROOT}/.venv/bin/python3"
if [ ! -f "$PYTHON" ]; then
    PYTHON="python3"
fi

RED='\033[0;31m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

WREN_URL="${WREN_URL:-http://localhost:3000}"

usage() {
    cat <<EOF
Usage: ps wren <subcommand> [args]

Subcommands:
  push            Push all source knowledge (instructions + SQL pairs) to WrenAI
                  Source entries (is_default=1) are replaced; user entries are preserved.
  validate        Validate all SQL pairs by executing against PostgreSQL mirror.
                  Prints first result for each pair — lets you spot magnitude errors.
                  Requires POSTGRES_DSN env var (or uses default localhost).
  crosscheck      Run cross-validation: compare same metric from different data paths.
                  Detects JOIN errors, filter gaps, ETL sync issues.
                  Requires POSTGRES_DSN env var (or uses default localhost).
  status          Show current knowledge counts (instructions and SQL pairs)

Options:
  --url URL       WrenAI UI URL (default: http://localhost:3000)

Examples:
  ps wren push                     Push all knowledge to WrenAI
  ps wren push --url http://host:3000
  ps wren validate                 Execute all SQL pairs, show first result
  ps wren crosscheck               Compare metric pairs across tables
  ps wren status                   Show counts

Notes:
  - 'push' uses a merge strategy: source knowledge is refreshed on each run.
    User-created knowledge via the WrenAI UI is preserved.
  - SQL pairs are tracked by question text. Source pairs with matching questions
    are replaced; user pairs with different questions survive.
  - Instructions use the is_default SQLite flag: source=1 (replaced), user=0 (kept).
EOF
}

cmd_push() {
    echo -e "${CYAN}Pushing knowledge to WrenAI at ${WREN_URL}...${NC}"
    "$PYTHON" "$WREN_SCRIPT" --url "$WREN_URL" "$@"
    echo -e "${GREEN}Done.${NC}"
}

cmd_validate() {
    local dsn="${POSTGRES_DSN:-postgresql://postgres:change_me@localhost:5432/powershop}"
    echo -e "${CYAN}Validating SQL pairs against PostgreSQL...${NC}"
    echo -e "${YELLOW}DSN: ${dsn}${NC}"
    POSTGRES_DSN="$dsn" "$PYTHON" "$WREN_SCRIPT" --validate
}

cmd_crosscheck() {
    local dsn="${POSTGRES_DSN:-postgresql://postgres:change_me@localhost:5432/powershop}"
    echo -e "${CYAN}Running cross-validation against PostgreSQL...${NC}"
    echo -e "${YELLOW}DSN: ${dsn}${NC}"
    POSTGRES_DSN="$dsn" "$PYTHON" "$WREN_SCRIPT" --crosscheck
}

cmd_status() {
    echo -e "${CYAN}Checking WrenAI knowledge status...${NC}"

    # Count source knowledge in the script
    local n_instructions n_pairs
    n_instructions=$(python3 -c "
import ast
with open('${WREN_SCRIPT}') as f:
    src = f.read()
tree = ast.parse(src)
for node in ast.walk(tree):
    if isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name) and t.id == 'INSTRUCTIONS':
                print(len(node.value.elts))
" 2>/dev/null || echo "?")
    n_pairs=$(python3 -c "
import ast
with open('${WREN_SCRIPT}') as f:
    src = f.read()
tree = ast.parse(src)
for node in ast.walk(tree):
    if isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name) and t.id == 'SQL_PAIRS':
                print(len(node.value.elts))
" 2>/dev/null || echo "?")

    echo ""
    echo -e "  Source knowledge in script:"
    echo -e "    Instructions: ${n_instructions} (source-managed, replace on push)"
    echo -e "    SQL Pairs:    ${n_pairs} (source-managed, replace on push)"
    echo ""

    # Try to check WrenAI GraphQL
    if curl -sf --max-time 3 "${WREN_URL}/api/graphql" -X POST \
        -H "Content-Type: application/json" \
        -d '{"query":"{ instructions { id } }"}' \
        -o /tmp/wren_inst_check.json 2>/dev/null; then
        local inst_count
        inst_count=$(python3 -c "import json; d=json.load(open('/tmp/wren_inst_check.json')); print(len(d.get('data',{}).get('instructions',[])))" 2>/dev/null || echo "?")
        echo -e "  WrenAI live knowledge (${WREN_URL}):"
        echo -e "    Instructions: ${inst_count}"
    else
        echo -e "  ${YELLOW}WrenAI not reachable at ${WREN_URL}${NC}"
    fi
    rm -f /tmp/wren_inst_check.json
}

SUBCMD="${1:-}"
if [ -z "$SUBCMD" ] || [ "$SUBCMD" = "-h" ] || [ "$SUBCMD" = "--help" ]; then
    usage
    exit 0
fi
shift

# Handle --url option
while [[ "$#" -gt 0 ]]; do
    case "$1" in
        --url)
            WREN_URL="$2"
            shift 2
            ;;
        *)
            break
            ;;
    esac
done

case "$SUBCMD" in
    push)       cmd_push "$@" ;;
    validate)   cmd_validate ;;
    crosscheck) cmd_crosscheck ;;
    status)     cmd_status ;;
    *)
        echo -e "${RED}ps wren: unknown subcommand '${SUBCMD}'${NC}" >&2
        usage >&2
        exit 1
        ;;
esac
