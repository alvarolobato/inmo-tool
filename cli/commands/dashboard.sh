#!/usr/bin/env bash
# ps dashboard — Dashboard App management
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

RED='\033[0;31m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

DC="docker compose -f ${REPO_ROOT}/docker-compose.yml"
DASHBOARD_SERVICE="dashboard"

usage() {
    cat <<EOF
Usage: ps dashboard <subcommand>

Subcommands:
  open        Open Dashboard App in browser
  logs        Show dashboard container logs (follow)
  restart     Restart the dashboard container
  status      Show dashboard container status
EOF
}

cmd_open() {
    local port="${DASHBOARD_PORT:-4000}"
    local url="http://localhost:${port}"
    echo -e "${CYAN}Opening Dashboard App at ${url}${NC}"
    case "$(uname -s)" in
        Darwin)
            open "$url"
            ;;
        Linux)
            xdg-open "$url" 2>/dev/null || echo "Visit: ${url}"
            ;;
        *)
            echo "Visit: ${url}"
            ;;
    esac
}

cmd_logs() {
    $DC logs -f "$DASHBOARD_SERVICE"
}

cmd_restart() {
    echo -e "${CYAN}Restarting dashboard...${NC}"
    $DC restart "$DASHBOARD_SERVICE"
    echo -e "${GREEN}Dashboard restarted.${NC}"
}

cmd_status() {
    echo -e "${CYAN}Dashboard container status:${NC}"
    $DC ps "$DASHBOARD_SERVICE" --format table
    echo ""

    local port="${DASHBOARD_PORT:-4000}"
    if curl -s --max-time 3 "http://localhost:${port}/api/health" | grep -q '"ok"' 2>/dev/null; then
        echo -e "  ${GREEN}[UP]${NC}   Dashboard App → http://localhost:${port}"
    else
        echo -e "  ${YELLOW}[DOWN]${NC} Dashboard App not reachable at http://localhost:${port}"
    fi
}

SUBCMD="${1:-}"
if [ -z "$SUBCMD" ] || [ "$SUBCMD" = "-h" ] || [ "$SUBCMD" = "--help" ]; then
    usage
    exit 0
fi
shift

case "$SUBCMD" in
    open)       cmd_open ;;
    logs)       cmd_logs ;;
    restart)    cmd_restart ;;
    status)     cmd_status ;;
    *)
        echo -e "${RED}ps dashboard: unknown subcommand '${SUBCMD}'${NC}" >&2
        usage >&2
        exit 1
        ;;
esac
