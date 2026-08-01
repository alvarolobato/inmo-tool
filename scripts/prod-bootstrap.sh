#!/bin/bash
# Prod bootstrap: convert /Users/alvarolobato/powershop (or whatever
# $PROD_PATH points at) from a flat file dump into a real git checkout,
# preserving data/, .env, and wren-config.yaml. Run on the prod Mac itself.
# Idempotent: safe to re-run; if the directory is already a git checkout it
# falls through to a `git pull --ff-only`.

set -euo pipefail

PROD_PATH="${PROD_PATH:-$HOME/powershop}"
REPO_URL="${REPO_URL:-https://github.com/alvarolobato/powershop-analytics.git}"
BRANCH="${BRANCH:-main}"
PRESERVE=("data" ".env" "wren-config.yaml" ".version")

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<USAGE
Usage: $(basename "$0") [--dry-run]

Environment overrides:
  PROD_PATH   Target directory (default: \$HOME/powershop)
  REPO_URL    Git repo to clone (default: github.com/alvarolobato/powershop-analytics)
  BRANCH      Branch to check out (default: main)
USAGE
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    printf '+ %s\n' "$*"
    eval "$@"
  fi
}

abort() {
  echo "ERROR: $*" >&2
  exit 1
}

# Safety checks
if [ "$PROD_PATH" = "/" ] || [ -z "$PROD_PATH" ]; then
  abort "Refusing to operate on PROD_PATH='$PROD_PATH'"
fi

# If already a git checkout, just pull.
if [ -d "$PROD_PATH/.git" ]; then
  echo "Already a git checkout at $PROD_PATH — pulling latest."
  run "cd '$PROD_PATH' && git fetch origin '$BRANCH' && git checkout '$BRANCH' && git pull --ff-only origin '$BRANCH'"
  echo "Done. To deploy: cd '$PROD_PATH' && docker compose -f docker-compose.yml -f prod/docker-compose.override.prod.yml up -d --build"
  exit 0
fi

if [ ! -d "$PROD_PATH" ]; then
  echo "$PROD_PATH does not exist — fresh clone."
  run "git clone --branch '$BRANCH' '$REPO_URL' '$PROD_PATH'"
  echo
  echo "Next steps:"
  echo "  1. Copy .env into '$PROD_PATH/.env' (or symlink to ~/.config/powershop-analytics/.env)"
  echo "  2. claude /login   # one-time, on the prod box"
  echo "  3. bash '$PROD_PATH/scripts/install-claude-token-launchd.sh'"
  echo "  4. cd '$PROD_PATH' && docker compose -f docker-compose.yml -f prod/docker-compose.override.prod.yml up -d --build"
  exit 0
fi

# Existing flat directory — convert it.
TS=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="${PROD_PATH}.backup.${TS}"

echo "Converting flat directory $PROD_PATH into a git checkout."
echo "Backup will be at $BACKUP"
echo

# Stop any running stack so we don't move data/ out from under live containers.
if [ "$DRY_RUN" -eq 0 ] && [ -f "$PROD_PATH/docker-compose.yml" ]; then
  echo "Stopping any running stack first..."
  ( cd "$PROD_PATH" && docker compose down 2>/dev/null || true )
fi

# Move the existing dir aside.
run "mv '$PROD_PATH' '$BACKUP'"

# Clone the repo into the original path.
run "git clone --branch '$BRANCH' '$REPO_URL' '$PROD_PATH'"

# Restore preserved artefacts from the backup.
for name in "${PRESERVE[@]}"; do
  src="$BACKUP/$name"
  dst="$PROD_PATH/$name"
  if [ ! -e "$src" ]; then
    echo "  skip $name (not present in backup)"
    continue
  fi
  if [ -e "$dst" ]; then
    # The repo version exists — keep the prod copy by overwriting (data/ in
    # particular is gitignored so the repo never has it; .env is also
    # gitignored; wren-config.yaml IS in the repo, so back up the existing
    # repo copy as .repo before replacing.
    if [ ! -L "$dst" ]; then
      run "mv '$dst' '${dst}.repo'"
    fi
  fi
  run "mv '$src' '$dst'"
done

echo
echo "Bootstrap complete."
echo "Backup retained at: $BACKUP"
echo
echo "Next steps:"
echo "  1. Verify .env at $PROD_PATH/.env is correct."
echo "  2. claude /login   # one-time, only if Keychain entry is missing or expired"
echo "  3. bash '$PROD_PATH/scripts/install-claude-token-launchd.sh'"
echo "  4. cd '$PROD_PATH' && docker compose -f docker-compose.yml -f prod/docker-compose.override.prod.yml up -d --build"
echo "  5. After verifying everything works, remove the backup: rm -rf '$BACKUP'"
