#!/usr/bin/env bash
# ps setup — First-time setup and prerequisites check
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

RED='\033[0;31m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CONFIG_DIR="${HOME}/.config/inmo-tool"
ENV_FILE="${CONFIG_DIR}/.env"

usage() {
    cat <<EOF
Usage: ps setup [subcommand]

Subcommands:
  (none)    First-time setup: create .env config and repo symlink
  check     Verify prerequisites (Docker, .env, connectivity)
EOF
}

cmd_setup() {
    echo -e "${CYAN}inmo-tool — First-time setup${NC}"
    echo ""

    # Create config dir and .env if missing
    if [ ! -f "${ENV_FILE}" ]; then
        mkdir -p "${CONFIG_DIR}"
        cp "${REPO_ROOT}/.env.example" "${ENV_FILE}"
        echo -e "${GREEN}Created${NC} ${ENV_FILE}"
        echo -e "${YELLOW}  → Edit this file with your real credentials before continuing.${NC}"
    else
        echo -e "${GREEN}OK${NC}  ${ENV_FILE} already exists"
    fi

    # Create .env symlink in repo root if missing
    if [ -f "${REPO_ROOT}/.env" ] && [ ! -L "${REPO_ROOT}/.env" ]; then
        echo -e "${RED}[SKIP]${NC} ${REPO_ROOT}/.env exists as a regular file (not a symlink)."
        echo -e "  To use the centralized config, back it up and re-run:"
        echo -e "    mv ${REPO_ROOT}/.env ${REPO_ROOT}/.env.bak"
        echo -e "    ps setup"
    elif [ ! -L "${REPO_ROOT}/.env" ]; then
        ln -sf "${ENV_FILE}" "${REPO_ROOT}/.env"
        echo -e "${GREEN}Created${NC} symlink ${REPO_ROOT}/.env → ${ENV_FILE}"
    else
        echo -e "${GREEN}OK${NC}  ${REPO_ROOT}/.env symlink already exists"
    fi

    echo ""
    echo -e "${GREEN}Setup complete.${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Edit ${ENV_FILE} with your credentials (Postgres, LLM provider, connector-specific — see .env.example)"
    echo "  2. Run: ps setup check"
    echo "  3. Run: ps stack up"
}

cmd_check() {
    echo -e "${CYAN}inmo-tool — Prerequisites check${NC}"
    echo ""

    local all_ok=true

    # Docker running
    if docker info >/dev/null 2>&1; then
        echo -e "  ${GREEN}[OK]${NC}  Docker is running"
    else
        echo -e "  ${RED}[FAIL]${NC} Docker is not running — start Docker Desktop or the Docker daemon"
        all_ok=false
    fi

    # .env exists
    if [ -f "${ENV_FILE}" ]; then
        echo -e "  ${GREEN}[OK]${NC}  .env loaded from ${ENV_FILE}"
    else
        echo -e "  ${RED}[FAIL]${NC} ${ENV_FILE} not found — run: ps setup"
        all_ok=false
    fi

    # docker compose config valid
    if docker compose -f "${REPO_ROOT}/docker-compose.yml" config --quiet 2>/dev/null; then
        echo -e "  ${GREEN}[OK]${NC}  docker-compose.yml is valid"
    else
        echo -e "  ${YELLOW}[WARN]${NC} docker compose config failed — check docker-compose.yml and .env"
    fi

    # PostgreSQL reachability (if stack is up)
    local pg_host="${POSTGRES_HOST:-localhost}"
    local pg_port="${POSTGRES_PORT:-5432}"
    if docker compose -f "${REPO_ROOT}/docker-compose.yml" ps --quiet postgres 2>/dev/null | grep -q .; then
        if python3 - "$pg_host" "$pg_port" <<'PYEOF' 2>/dev/null
import socket, sys
try:
    s = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=3)
    s.close()
    sys.exit(0)
except Exception:
    sys.exit(1)
PYEOF
        then
            echo -e "  ${GREEN}[OK]${NC}  PostgreSQL ${pg_host}:${pg_port} is reachable"
        else
            echo -e "  ${YELLOW}[WARN]${NC} PostgreSQL ${pg_host}:${pg_port} not reachable"
        fi
    else
        echo -e "  ${YELLOW}[SKIP]${NC} PostgreSQL check skipped — stack not running (run: ps stack up)"
    fi

    echo ""
    if $all_ok; then
        echo -e "${GREEN}All required checks passed.${NC}"
    else
        echo -e "${YELLOW}Some checks failed or have warnings. Review output above.${NC}"
        exit 1
    fi
}

SUBCMD="${1:-}"
case "$SUBCMD" in
    ""|"-h"|"--help")
        if [ "$SUBCMD" = "-h" ] || [ "$SUBCMD" = "--help" ]; then
            usage
            exit 0
        fi
        cmd_setup
        ;;
    check)
        cmd_check
        ;;
    *)
        echo -e "${RED}ps setup: unknown subcommand '${SUBCMD}'${NC}" >&2
        usage >&2
        exit 1
        ;;
esac
