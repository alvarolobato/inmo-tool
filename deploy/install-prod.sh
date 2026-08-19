#!/usr/bin/env bash
#
# install-prod.sh — prepare a host to run inmo-tool in production.
# RUNS ON THE PRODUCTION HOST. From a workstation:  ps prod install
#
# Idempotent; safe to re-run. In order:
#   1. Checks the host: Docker, Compose, git access, the shared PostgreSQL
#      reachable on its network, and the dashboard port free.
#   2. Clones (or updates) the repository into the deployment directory.
#   3. Creates the data directories.
#   4. Writes <deployment>/.env (0600) from .env.prod.example, filling in
#      what it can infer here and generating the app's database password.
#      Secrets that only exist on the operator's workstation are left blank.
#   5. Starts nothing. `ps prod copy-data` finishes the job.
#
# Configuration comes from the environment (ps prod install forwards it from
# ~/.config/inmo-tool/.env), because none of it belongs in a public repo:
#   INMO_PROD_HOME     deployment directory            (default ~/inmo-tool)
#   SHARED_NETWORK     Docker network of the cluster   (required)
#   POSTGRES_HOST      its name on that network        (required)
#   DASHBOARD_PORT     host port for the dashboard     (required)
#   ADMIN_ENV_FILE     file holding the cluster's admin credentials, if the
#                      host already has one (optional; otherwise fill the two
#                      POSTGRES_ADMIN_* values in .env by hand afterwards)
#
# With --check-only it stops after step 1.

set -euo pipefail

REPO_URL="${REPO_URL:-git@github.com:alvarolobato/inmo-tool.git}"
PROD_HOME="${INMO_PROD_HOME:-$HOME/inmo-tool}"
SHARED_NETWORK="${SHARED_NETWORK:-}"
POSTGRES_HOST="${POSTGRES_HOST:-}"
DASHBOARD_PORT="${DASHBOARD_PORT:-}"
ADMIN_ENV_FILE="${ADMIN_ENV_FILE:-}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}!${NC} $*"; }
die()  { echo -e "  ${RED}✗${NC} $*" >&2; exit 1; }

CHECK_ONLY=false
[ "${1:-}" = "--check-only" ] && CHECK_ONLY=true

echo -e "${CYAN}1. Host checks${NC}"

[ -n "$SHARED_NETWORK" ] || die "SHARED_NETWORK is not set (the Docker network the shared PostgreSQL is on)"
[ -n "$POSTGRES_HOST" ]  || die "POSTGRES_HOST is not set (its name on that network)"
[ -n "$DASHBOARD_PORT" ] || die "DASHBOARD_PORT is not set (host port for the dashboard)"

command -v docker >/dev/null || die "docker is not on PATH"
docker info >/dev/null 2>&1 || die "the Docker daemon is not responding"
ok "Docker $(docker --version | awk '{print $3}' | tr -d ,)"

docker compose version >/dev/null 2>&1 || die "the 'docker compose' v2 plugin is missing"
ok "Compose $(docker compose version --short)"

command -v git >/dev/null || die "git is not on PATH"
git ls-remote "$REPO_URL" HEAD >/dev/null 2>&1 || die "no access to $REPO_URL (SSH key on GitHub?)"
ok "repository reachable"

docker network inspect "$SHARED_NETWORK" >/dev/null 2>&1 \
    || die "no Docker network '$SHARED_NETWORK' — start whatever provides the shared PostgreSQL first"
ok "shared network present"

# Resolve and probe PostgreSQL from inside that network, which is exactly how
# the app will reach it — a check against the host's own port would prove
# nothing about the container's view.
docker run --rm --network "$SHARED_NETWORK" postgres:16-alpine \
    pg_isready -h "$POSTGRES_HOST" -q >/dev/null 2>&1 \
    || die "'$POSTGRES_HOST' does not accept connections on network '$SHARED_NETWORK'"
ok "shared PostgreSQL accepts connections"

if lsof -nP -iTCP:"$DASHBOARD_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    docker ps --format '{{.Names}} {{.Ports}}' | grep -qE "^inmo-tool-.*:${DASHBOARD_PORT}->" \
        && ok "port $DASHBOARD_PORT already published by this stack" \
        || die "port $DASHBOARD_PORT is taken by another process"
else
    ok "port $DASHBOARD_PORT free"
fi

if [ "$CHECK_ONLY" = true ]; then
    echo -e "${GREEN}Host is ready.${NC}"
    exit 0
fi

echo -e "${CYAN}2. Repository${NC}"
if [ -d "$PROD_HOME/.git" ]; then
    git -C "$PROD_HOME" fetch --quiet origin
    git -C "$PROD_HOME" checkout --quiet main
    git -C "$PROD_HOME" pull --quiet --ff-only origin main
    ok "updated to $(git -C "$PROD_HOME" rev-parse --short HEAD)"
else
    git clone --quiet "$REPO_URL" "$PROD_HOME"
    ok "cloned at $(git -C "$PROD_HOME" rev-parse --short HEAD)"
fi

echo -e "${CYAN}3. Data directories${NC}"
mkdir -p "$PROD_HOME/data/dashboard/conversations" "$PROD_HOME/otel/local"
ok "data/dashboard/conversations, otel/local"
# No data/postgres here: in production the database lives in the shared
# cluster, not in a bind mount of this deployment.

echo -e "${CYAN}4. .env${NC}"
ENV_FILE="$PROD_HOME/.env"
if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    ok "already existed — backed up, left untouched"
else
    # Some .env files quote their values; docker compose strips the quotes on
    # read but `cut` does not, and a quoted username would reach psql with the
    # quotes attached. Two seds rather than one back-reference: BSD sed does
    # not support \1 inside an -E pattern.
    unquote() { sed -e "s/^['\"]//" -e "s/['\"]\$//"; }
    ADMIN_USER=""; ADMIN_PASSWORD=""
    if [ -n "$ADMIN_ENV_FILE" ] && [ -f "$ADMIN_ENV_FILE" ]; then
        ADMIN_USER="$(grep -E '^POSTGRES_USER=' "$ADMIN_ENV_FILE" | head -1 | cut -d= -f2- | unquote)"
        ADMIN_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "$ADMIN_ENV_FILE" | head -1 | cut -d= -f2- | unquote)"
    fi

    umask 077
    sed \
        -e "s|^SHARED_NETWORK=.*|SHARED_NETWORK=${SHARED_NETWORK}|" \
        -e "s|^POSTGRES_HOST=.*|POSTGRES_HOST=${POSTGRES_HOST}|" \
        -e "s|^DASHBOARD_PORT=.*|DASHBOARD_PORT=${DASHBOARD_PORT}|" \
        -e "s|^POSTGRES_ADMIN_USER=.*|POSTGRES_ADMIN_USER=${ADMIN_USER:-postgres}|" \
        -e "s|^POSTGRES_ADMIN_PASSWORD=.*|POSTGRES_ADMIN_PASSWORD=${ADMIN_PASSWORD}|" \
        -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 20)|" \
        -e "s|^ADMIN_API_KEY=.*|ADMIN_API_KEY=$(openssl rand -hex 32)|" \
        "$PROD_HOME/.env.prod.example" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "created (0600) with the app's own database password and an admin key"
    [ -n "$ADMIN_PASSWORD" ] || warn "POSTGRES_ADMIN_PASSWORD is blank — fill it in before starting"
    warn "OPENROUTER_API_KEY / CLAUDE_CODE_OAUTH_TOKEN come from the workstation"
fi

echo
echo -e "${GREEN}Host prepared.${NC} Nothing has been started."
echo "Next, FROM THE WORKSTATION:  ps prod copy-data"
