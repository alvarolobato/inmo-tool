#!/usr/bin/env bash
# ps dedup — trigger the deduplication engine (task 1.5, #13)
# Stub until task 2.2 (#16) implements the actual matching engine — this
# file exists now so the CLI surface is stable and task 2.2 only has to
# implement cmd_run's body, not invent a new command shape.
set -e

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
    cat <<EOF
Usage: ps dedup <subcommand>

Subcommands:
  run    Run the deduplication engine once (not implemented yet — see #16)
EOF
}

cmd_run() {
    echo -e "${YELLOW}ps dedup run: not implemented yet — see task 2.2 (#16).${NC}"
    echo "The connector framework and schema (Phase 1) don't include matching/merge logic."
}

SUBCMD="${1:-}"
if [ -z "$SUBCMD" ] || [ "$SUBCMD" = "-h" ] || [ "$SUBCMD" = "--help" ]; then
    usage
    exit 0
fi
shift

case "$SUBCMD" in
    run) cmd_run ;;
    *)
        echo -e "${RED}ps dedup: unknown subcommand '${SUBCMD}'${NC}" >&2
        usage >&2
        exit 1
        ;;
esac
