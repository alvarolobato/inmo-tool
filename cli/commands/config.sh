#!/usr/bin/env bash
# ps config — Show current configuration
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}PowerShop Analytics Configuration${NC}"
echo ""

# Show .env source
CONFIG_DIR="${HOME}/.config/powershop-analytics"
if [ -f "${REPO_ROOT}/local/.env" ]; then
    echo -e "Config source: ${GREEN}local/.env${NC} (worktree-specific)"
elif [ -f "${CONFIG_DIR}/.env" ]; then
    echo -e "Config source: ${GREEN}~/.config/powershop-analytics/.env${NC} (centralized)"
else
    echo -e "Config source: ${YELLOW}Not found${NC}"
    echo "  Run: ps setup"
fi

echo ""
echo -e "${CYAN}4D SQL Server:${NC}"
echo "  Host: ${P4D_HOST:-<not set>}"
echo "  Port: ${P4D_PORT:-19812}"
echo "  User: ${P4D_USER:-<not set>}"
if [ -n "${P4D_PASSWORD:-}" ]; then
    echo "  Password: ****"
else
    echo "  Password: (not set)"
fi

echo ""
echo -e "${CYAN}PostgreSQL:${NC}"
echo "  User: ${POSTGRES_USER:-postgres}"
echo "  DB:   ${POSTGRES_DB:-powershop}"
echo "  Host: ${POSTGRES_HOST:-localhost}"
echo "  Port: ${POSTGRES_PORT:-5432}"
# Quick reachability check
pg_host="${POSTGRES_HOST:-localhost}"
pg_port="${POSTGRES_PORT:-5432}"
if python3 - "$pg_host" "$pg_port" <<'PYEOF' 2>/dev/null
import socket, sys
try:
    s = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=2)
    s.close()
    sys.exit(0)
except Exception:
    sys.exit(1)
PYEOF
then
    echo -e "  Status: ${GREEN}reachable${NC}"
else
    echo -e "  Status: ${YELLOW}not reachable${NC} (stack may be down)"
fi

echo ""
echo -e "${CYAN}Docker:${NC}"
if docker info >/dev/null 2>&1; then
    echo -e "  Status: ${GREEN}running${NC}"
else
    echo -e "  Status: ${YELLOW}not running${NC}"
fi

echo ""
echo -e "${CYAN}WrenAI:${NC}"
host_port="${HOST_PORT:-3000}"
if curl -s --max-time 3 "http://localhost:${host_port}" >/dev/null 2>&1; then
    echo -e "  UI:    ${GREEN}reachable${NC} → http://localhost:${host_port}"
else
    echo -e "  UI:    ${YELLOW}not reachable${NC} at http://localhost:${host_port}"
fi
echo "  Model: ${WREN_LLM_MODEL:-<not set>}"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    echo -e "  OpenRouter API key: ${GREEN}set${NC}"
else
    echo -e "  OpenRouter API key: ${YELLOW}not set${NC}"
fi
