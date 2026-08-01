#!/usr/bin/env bash
# wren-setup.sh — Auto-configure WrenAI: create PostgreSQL data source and deploy MDL
#
# Usage: ./scripts/wren-setup.sh [--host <wren-ui-url>]
#
# Defaults:
#   WREN_UI_URL  http://localhost:3000   (override via env or --host flag)
#
# This script:
#   1. Waits for the wren-ui service to be ready.
#   2. Saves the PostgreSQL data source via GraphQL mutation.
#   3. Deploys/re-indexes the MDL via GraphQL mutation.
#
# Prerequisites:
#   - curl (with JSON support)
#   - The stack must be running: docker compose up -d
#   - .env must be sourced or environment variables set
#
# GraphQL API used (wren-ui Next.js internal API at /api/graphql):
#   mutation saveDataSource(input: DataSourceInput!)
#   mutation deploy(force: Boolean)
#
# Note: This configures the *initial* data source in WrenAI.  If WrenAI already
# has a data source configured (db.sqlite3 exists and has a project row), running
# this script again will be a no-op (the mutation is idempotent for the same input).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# Configuration (from environment / .env)
# ---------------------------------------------------------------------------
# Load .env if present in repo root (docker-compose pattern)
if [ -f "${REPO_ROOT}/.env" ]; then
    set -o allexport
    # shellcheck disable=SC1091
    source "${REPO_ROOT}/.env"
    set +o allexport
fi

WREN_UI_URL="${WREN_UI_URL:-http://localhost:${HOST_PORT:-3000}}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-change_me_in_production}"
POSTGRES_DB="${POSTGRES_DB:-powershop}"

# Parse --host flag
while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)
            WREN_UI_URL="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1" >&2
            echo "Usage: $0 [--host <wren-ui-url>]" >&2
            exit 1
            ;;
    esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${CYAN}[wren-setup]${NC} $*"; }
success() { echo -e "${GREEN}[wren-setup]${NC} $*"; }
warn()    { echo -e "${YELLOW}[wren-setup]${NC} $*"; }
error()   { echo -e "${RED}[wren-setup]${NC} $*" >&2; }

GRAPHQL_URL="${WREN_UI_URL}/api/graphql"

# ---------------------------------------------------------------------------
# Helper: send a GraphQL request
# Returns the full JSON response body.
# ---------------------------------------------------------------------------
gql() {
    local query="$1"
    curl -s \
        -X POST \
        -H "Content-Type: application/json" \
        --data "$query" \
        "${GRAPHQL_URL}"
}

# ---------------------------------------------------------------------------
# 1. Wait for wren-ui to be ready
# ---------------------------------------------------------------------------
info "Waiting for WrenAI UI at ${WREN_UI_URL} ..."
MAX_WAIT=120   # seconds
ELAPSED=0
INTERVAL=5

until curl -s --max-time 3 "${WREN_UI_URL}" >/dev/null 2>&1; do
    if [ $ELAPSED -ge $MAX_WAIT ]; then
        error "WrenAI UI did not become ready within ${MAX_WAIT}s. Is the stack running?"
        error "Run: docker compose up -d && docker compose ps"
        exit 1
    fi
    info "  Not ready yet. Retrying in ${INTERVAL}s... (${ELAPSED}/${MAX_WAIT}s elapsed)"
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
done
success "WrenAI UI is ready."

# ---------------------------------------------------------------------------
# 2. Save the PostgreSQL data source
# ---------------------------------------------------------------------------
info "Configuring PostgreSQL data source..."
info "  host=${POSTGRES_HOST}  port=${POSTGRES_PORT}  db=${POSTGRES_DB}  user=${POSTGRES_USER}"

SAVE_DS_PAYLOAD=$(cat <<EOF
{
  "query": "mutation SaveDataSource(\$input: DataSourceInput!) { saveDataSource(data: \$input) { type properties } }",
  "variables": {
    "input": {
      "type": "POSTGRES",
      "properties": {
        "host": "${POSTGRES_HOST}",
        "port": ${POSTGRES_PORT},
        "database": "${POSTGRES_DB}",
        "user": "${POSTGRES_USER}",
        "password": "${POSTGRES_PASSWORD}"
      }
    }
  }
}
EOF
)

SAVE_DS_RESP="$(gql "$SAVE_DS_PAYLOAD")"

# Check for errors
if echo "$SAVE_DS_RESP" | grep -q '"errors"'; then
    # Check if it's a "data source already exists" style error (idempotent)
    if echo "$SAVE_DS_RESP" | grep -qi "already"; then
        warn "Data source already configured — skipping (idempotent)."
    else
        error "Failed to save data source. GraphQL response:"
        echo "$SAVE_DS_RESP" >&2
        exit 1
    fi
else
    success "PostgreSQL data source saved."
fi

# ---------------------------------------------------------------------------
# 3. Deploy / re-index MDL
# ---------------------------------------------------------------------------
info "Deploying MDL (force=true to reload)..."

DEPLOY_PAYLOAD='{"query":"mutation Deploy { deploy(force: true) }"}'

DEPLOY_RESP="$(gql "$DEPLOY_PAYLOAD")"

if echo "$DEPLOY_RESP" | grep -q '"errors"'; then
    error "MDL deploy returned an error. GraphQL response:"
    echo "$DEPLOY_RESP" >&2
    exit 1
else
    success "MDL deployed successfully."
fi

# ---------------------------------------------------------------------------
# 4. Done
# ---------------------------------------------------------------------------
echo ""
success "WrenAI setup complete."
echo ""
echo "  Open the UI:  ${WREN_UI_URL}"
echo ""
echo "  If this is a fresh install you may still need to:"
echo "    1. Go to the WrenAI UI and complete any onboarding wizard steps."
echo "    2. Select the tables to include in the semantic model (ps_articulos, etc.)."
echo "    3. Review and save the auto-generated MDL."
echo ""
