#!/usr/bin/env bash
# ps dedup — the deduplication engine (task 2.2, #16)
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Same array-not-string reasoning as cli/commands/connector.sh.
DC=(docker compose -f "${REPO_ROOT}/docker-compose.yml")

usage() {
    cat <<EOF
Usage: ps dedup <subcommand> [args]

Subcommands:
  run              Run the dedup engine once (compare listings, merge/suggest)
  revert <id>      Undo one auto-merge by its property_merge_log id
  suggestions      List pending suggested_merge rows for human review
EOF
}

# Mirrors cli/commands/connector.sh's _run_in_etl — same exec-vs-run
# fallback reasoning, duplicated rather than shared since each command file
# in this repo owns its own copy (see cli/commands/db.sh, connector.sh).
_run_in_etl() {
    if "${DC[@]}" ps --status running --quiet etl 2>/dev/null | grep -q .; then
        "${DC[@]}" exec -T etl "$@"
    else
        "${DC[@]}" run --rm etl "$@"
    fi
}

cmd_run() {
    echo -e "${CYAN}Running dedup engine...${NC}"
    _run_in_etl python -m etl.dedup.cli run
}

cmd_revert() {
    local id="${1:-}"
    if [ -z "$id" ]; then
        echo -e "${RED}ps dedup revert: missing <id>${NC}" >&2
        usage >&2
        exit 1
    fi
    _run_in_etl python -m etl.dedup.cli revert "$id"
}

cmd_suggestions() {
    "${DC[@]}" exec -T postgres psql \
        -U "${POSTGRES_USER:-postgres}" \
        -d "${POSTGRES_DB:-inmotool}" \
        -v ON_ERROR_STOP=1 \
        -c "SELECT id, listing_id_a, listing_id_b, match_basis, confidence, status, detail, created_at FROM suggested_merge WHERE status IN ('pending','conflict') ORDER BY created_at DESC"
}

SUBCMD="${1:-}"
if [ -z "$SUBCMD" ] || [ "$SUBCMD" = "-h" ] || [ "$SUBCMD" = "--help" ]; then
    usage
    exit 0
fi
shift

case "$SUBCMD" in
    run)         cmd_run ;;
    revert)      cmd_revert "$@" ;;
    suggestions) cmd_suggestions ;;
    *)
        echo -e "${RED}ps dedup: unknown subcommand '${SUBCMD}'${NC}" >&2
        usage >&2
        exit 1
        ;;
esac
