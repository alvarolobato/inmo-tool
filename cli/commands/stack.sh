#!/usr/bin/env bash
# ps stack — Docker Compose stack management
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Dashboard image: bake git describe into Next.js so the UI shows non-release builds (Docker build has no .git).
if [ -z "${APP_GIT_DESCRIBE:-}" ] && [ -d "${REPO_ROOT}/.git" ]; then
  export APP_GIT_DESCRIBE="$(cd "${REPO_ROOT}" && git describe --tags --always --dirty 2>/dev/null || true)"
fi

RED='\033[0;31m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

DC=(docker compose -f "${REPO_ROOT}/docker-compose.yml")

# Stage the browser extension into the dashboard build context (dashboard/public/)
# so the built image can serve it via GET /api/extension/download. The extension
# lives at the repo root, OUTSIDE the ./dashboard docker build context, so it must
# be packaged in *from current source* immediately before any `docker compose
# --build`. It MUST run AFTER `git pull` in `update` — staging pre-pull source and
# then building was the root cause of #334 (a redeploy shipped 0.7.0 after 0.7.1
# merged). See scripts/build-extension-zip.sh for the full rationale.
stage_extension() {
  if [ ! -f "${REPO_ROOT}/scripts/build-extension-zip.sh" ]; then
    return 0
  fi
  if ! bash "${REPO_ROOT}/scripts/build-extension-zip.sh"; then
    echo -e "${YELLOW}warning: could not package the browser extension; the in-app download will fall back to manual instructions.${NC}" >&2
    return 0
  fi
  # Belt-and-suspenders: if packaging silently produced a stale/missing zip, make
  # it loud rather than shipping the old extension again (the #334 failure mode).
  if [ -f "${REPO_ROOT}/scripts/check-extension-zip-fresh.sh" ]; then
    bash "${REPO_ROOT}/scripts/check-extension-zip-fresh.sh" || \
      echo -e "${YELLOW}warning: extension zip looks stale after packaging — the served extension may be out of date.${NC}" >&2
  fi
  # And the content check, for the residue mtime cannot reach: bytes that predate
  # an un-versioned source edit behind a timestamp that does not. (Not #693 — that
  # one the mtime guard above catches; it was never wired into `ps prod deploy`,
  # which is why it shipped. See D-161.) This compares the actual version strings.
  if [ -f "${REPO_ROOT}/scripts/check-extension-version-sync.sh" ]; then
    bash "${REPO_ROOT}/scripts/check-extension-version-sync.sh" || \
      echo -e "${YELLOW}warning: the staged extension version disagrees with browser-extension/manifest.json — the dashboard will report a wrong servedVersion.${NC}" >&2
  fi
}

usage() {
    cat <<EOF
Usage: ps stack <subcommand> [args]

Subcommands:
  up              Start all containers
  down            Stop all containers
  restart         Restart all containers
  update          Pull latest, rebuild images, restart stack
  status          Show container status
  logs [svc]      Show logs (follow); optional service name
  destroy         Stop containers and remove volumes (irreversible)
EOF
}

cmd_up() {
    # `up -d` builds any image that doesn't exist yet, so stage the extension first.
    stage_extension
    echo -e "${CYAN}Starting stack...${NC}"
    "${DC[@]}" up -d
    echo ""
    echo -e "${GREEN}Stack is up.${NC} Run 'ps stack status' to check containers."
}

cmd_down() {
    echo -e "${CYAN}Stopping stack...${NC}"
    "${DC[@]}" down
    echo -e "${GREEN}Stack stopped.${NC}"
}

cmd_restart() {
    echo -e "${CYAN}Restarting stack...${NC}"
    "${DC[@]}" restart
    echo -e "${GREEN}Stack restarted.${NC}"
}

cmd_update() {
    cd "${REPO_ROOT}"

    local branch
    branch="$(git rev-parse --abbrev-ref HEAD)"
    if [ "$branch" = "HEAD" ]; then
        echo -e "${YELLOW}Repository is in a detached HEAD state.${NC}"
        echo "Please check out a branch (for example: git checkout main) and run this command again."
        exit 1
    fi
    if [ "$branch" != "main" ]; then
        echo -e "${YELLOW}Current branch is '${branch}', not 'main'.${NC}"
        printf "Pull and rebuild on this branch anyway? [y/N] "
        read -r answer || answer=''
        if [ "${answer}" != "y" ] && [ "${answer}" != "Y" ]; then
            echo "Aborted."
            exit 0
        fi
    fi

    if [ -n "$(git status --porcelain)" ]; then
        echo -e "${YELLOW}Working tree has uncommitted or untracked changes.${NC}"
        printf "Continue? git pull will fail if it would overwrite them. [y/N] "
        read -r answer || answer=''
        if [ "${answer}" != "y" ] && [ "${answer}" != "Y" ]; then
            echo "Aborted."
            exit 0
        fi
    fi

    echo -e "${CYAN}Pulling latest from origin/${branch}...${NC}"
    git pull --ff-only origin "$branch"

    # Re-package the extension from the JUST-PULLED source, right before the build.
    # (Staging before the pull would bake the pre-pull extension into the image —
    # exactly the #334 stale-ship bug.)
    stage_extension

    echo -e "${CYAN}Rebuilding images and starting stack...${NC}"
    "${DC[@]}" up -d --build

    echo ""
    cmd_status
}

cmd_status() {
    echo -e "${CYAN}Container status:${NC}"
    "${DC[@]}" ps --format table
    echo ""

    # Check Dashboard App
    local dash_port="${DASHBOARD_PORT:-4000}"
    if curl -s --max-time 3 "http://localhost:${dash_port}" >/dev/null 2>&1; then
        echo -e "  ${GREEN}[UP]${NC}   Dashboard App → http://localhost:${dash_port}"
    else
        echo -e "  ${YELLOW}[DOWN]${NC} Dashboard App not reachable at http://localhost:${dash_port}"
    fi
}

cmd_logs() {
    local svc="${1:-}"
    if [ -n "$svc" ]; then
        "${DC[@]}" logs -f "$svc"
    else
        "${DC[@]}" logs -f
    fi
}

cmd_destroy() {
    echo -e "${RED}WARNING: This will delete all data including PostgreSQL.${NC}"
    printf "Continue? [y/N] "
    read -r answer || answer=''
    if [ "${answer}" = "y" ] || [ "${answer}" = "Y" ]; then
        echo -e "${CYAN}Destroying stack and volumes...${NC}"
        "${DC[@]}" down -v
        echo -e "${GREEN}Stack destroyed.${NC}"
    else
        echo "Aborted."
        exit 0
    fi
}

SUBCMD="${1:-}"
if [ -z "$SUBCMD" ] || [ "$SUBCMD" = "-h" ] || [ "$SUBCMD" = "--help" ]; then
    usage
    exit 0
fi
shift

case "$SUBCMD" in
    up)          cmd_up ;;
    down)        cmd_down ;;
    restart)     cmd_restart ;;
    update)      cmd_update ;;
    status)      cmd_status ;;
    logs)        cmd_logs "${1:-}" ;;
    destroy)     cmd_destroy ;;
    *)
        echo -e "${RED}ps stack: unknown subcommand '${SUBCMD}'${NC}" >&2
        usage >&2
        exit 1
        ;;
esac
