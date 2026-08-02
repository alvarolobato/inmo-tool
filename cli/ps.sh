#!/usr/bin/env bash
#
# ps.sh - inmo-tool unified CLI dispatcher
# Invoked by the repo-root stub (ps). Parses command group and delegates to cli/commands/<group>.sh.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMMANDS_DIR="${SCRIPT_DIR}/commands"

RED='\033[0;31m'
NC='\033[0m'

usage() {
    cat <<EOF
Usage: ps <command> [options] [args]

Available commands:
  setup        First-time setup and prerequisites check
  stack        Docker Compose stack management (up/down/update/status/logs/destroy)
  connector    Run/inspect site connectors (list/run/status/logs)
  db           Inspect the Postgres mirror (tables/describe/query)
  dedup        Deduplication engine (run — stub until task 2.2, #16)
  dashboard    Dashboard App management (open/logs/restart/status)
  config       Show current configuration

  (no "prod" group yet — this project has no production deployment target;
  the source project's prod tooling was removed as PowerShop/WrenAI-specific
  dead weight rather than kept unused. Re-add when there's a real target.)

Help commands:
  ps help                  Show this help
  ps <command> --help      Show help for a command

Examples:
  ps setup                 First-time setup (create .env, symlink)
  ps setup check           Verify prerequisites
  ps stack up              Start all containers
  ps stack update          Pull latest, rebuild images, restart stack
  ps stack status          Show container status
  ps stack logs [svc]      Tail logs
  ps connector list        Show registered connectors
  ps connector run         Run all connectors once (or `run <name>` for one)
  ps connector status      Show the most recent run per connector
  ps db tables             List tables with row counts
  ps db query "<SQL>"      Run a read-only query
  ps dedup run             Run the dedup engine (stub — see #16)
  ps dashboard open        Open Dashboard App in browser
  ps dashboard status      Show dashboard container status
  ps config                Show loaded configuration
EOF
}

GROUP="${1:-}"
if [ -z "$GROUP" ] || [ "$GROUP" = "-h" ] || [ "$GROUP" = "--help" ] || [ "$GROUP" = "help" ]; then
    usage
    exit 0
fi

GROUP_SCRIPT="${COMMANDS_DIR}/${GROUP}.sh"
if [ ! -f "$GROUP_SCRIPT" ]; then
    echo -e "${RED}ps: unknown command '${GROUP}'${NC}" >&2
    echo "" >&2
    usage >&2
    exit 1
fi

shift
export REPO_ROOT

# Load credentials into environment before executing command
# shellcheck source=cli/commands/load-env.sh
source "${COMMANDS_DIR}/load-env.sh"

run_ret=0
"$GROUP_SCRIPT" "$@" || run_ret=$?
exit $run_ret
