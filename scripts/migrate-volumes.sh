#!/usr/bin/env bash
# migrate-volumes.sh — Migrate Docker named volumes to bind-mount directories under ./data/
#
# Usage: ./scripts/migrate-volumes.sh
#
# This is a ONE-TIME migration script. Run it once after upgrading docker-compose.yml
# from named volumes (pgdata / qdrant-data / wren-data) to bind mounts (./data/*).
# After running, the old named volumes can be removed with `docker volume rm`.
#
# Safety: the script will NOT overwrite a non-empty destination directory.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${CYAN}[migrate]${NC} $*"; }
success() { echo -e "${GREEN}[migrate]${NC} $*"; }
warn()    { echo -e "${YELLOW}[migrate]${NC} $*"; }
error()   { echo -e "${RED}[migrate]${NC} $*" >&2; }

# ---------------------------------------------------------------------------
# 1. Stop containers
# ---------------------------------------------------------------------------
info "Stopping containers..."
docker compose -f "${REPO_ROOT}/docker-compose.yml" down

# ---------------------------------------------------------------------------
# 2. Create destination directories
# ---------------------------------------------------------------------------
info "Creating bind-mount directories..."
mkdir -p "${REPO_ROOT}/data/postgres"
mkdir -p "${REPO_ROOT}/data/qdrant"
mkdir -p "${REPO_ROOT}/data/wren"

# ---------------------------------------------------------------------------
# Helper: find the exact volume name by suffix (e.g. pgdata)
# Docker Compose prefixes volumes with the project name (usually the dir name,
# lowercased, with hyphens).  We use `docker volume ls` to locate the exact name.
# ---------------------------------------------------------------------------
find_volume() {
    local suffix="$1"
    local vol
    vol="$(docker volume ls --filter "name=${suffix}" --format '{{.Name}}' | head -1)"
    echo "$vol"
}

# ---------------------------------------------------------------------------
# Helper: copy a named volume to a bind-mount directory
# ---------------------------------------------------------------------------
copy_volume() {
    local vol_name="$1"
    local dest_dir="$2"
    local label="$3"

    if [ -z "$vol_name" ]; then
        warn "  No named volume found for '${label}' — skipping (nothing to migrate)."
        return
    fi

    # Check destination is empty (do not overwrite existing data)
    if [ -n "$(ls -A "${dest_dir}" 2>/dev/null)" ]; then
        warn "  Destination '${dest_dir}' is not empty — skipping '${label}' to avoid overwrite."
        warn "  If you want to re-run the migration, empty the directory first."
        return
    fi

    info "  Migrating volume '${vol_name}' → '${dest_dir}'..."
    docker run --rm \
        -v "${vol_name}:/src:ro" \
        -v "${dest_dir}:/dst" \
        alpine sh -c "cp -a /src/. /dst/"
    success "  Done: ${label}"
}

# ---------------------------------------------------------------------------
# 3. Copy each volume
# ---------------------------------------------------------------------------
info "Discovering named volumes..."

PGDATA_VOL="$(find_volume "pgdata")"
QDRANT_VOL="$(find_volume "qdrant-data")"
WREN_VOL="$(find_volume "wren-data")"

echo ""
info "Found volumes:"
echo "  postgres  → ${PGDATA_VOL:-<not found>}"
echo "  qdrant    → ${QDRANT_VOL:-<not found>}"
echo "  wren      → ${WREN_VOL:-<not found>}"
echo ""

copy_volume "$PGDATA_VOL"  "${REPO_ROOT}/data/postgres" "postgres"
copy_volume "$QDRANT_VOL"  "${REPO_ROOT}/data/qdrant"   "qdrant"
copy_volume "$WREN_VOL"    "${REPO_ROOT}/data/wren"     "wren"

# ---------------------------------------------------------------------------
# 4. Done
# ---------------------------------------------------------------------------
echo ""
success "Migration complete."
echo ""
echo "  Next steps:"
echo "  1. Start the stack:  docker compose up -d"
echo "  2. Verify services:  ps stack status"
echo "  3. (Optional) Remove old named volumes once you're satisfied:"
if [ -n "$PGDATA_VOL" ];  then echo "       docker volume rm ${PGDATA_VOL}";  fi
if [ -n "$QDRANT_VOL" ];  then echo "       docker volume rm ${QDRANT_VOL}";  fi
if [ -n "$WREN_VOL" ];    then echo "       docker volume rm ${WREN_VOL}";    fi
echo ""
