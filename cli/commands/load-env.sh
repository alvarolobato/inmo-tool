#!/bin/bash
# load-env.sh - Load .env credentials into the environment
# Sourced by ps.sh to ensure all subcommands have access to credentials.

# Helper to load a .env file if variables are not already set
load_env_file() {
    local env_file="$1"
    if [ ! -f "${env_file}" ]; then
        return
    fi

    # Use python to parse standard .env format (KEY=value, KEY="value")
    # and only export variables NOT already in the environment.
    PYTHON_CODE=$(cat <<'EOF'
import os, sys
env_file = sys.argv[1]
if not os.path.exists(env_file):
    sys.exit(0)
with open(env_file, 'r') as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip()
        if not key or key in os.environ:
            continue
        # Strip optional surrounding quotes
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        escaped = value.replace("'", "'\"'\"'")
        print(f"export {key}='{escaped}'")
EOF
)
    eval "$(python3 -c "$PYTHON_CODE" "$env_file")"
}

# Priority (highest wins):
#   1. Environment variables already set in the shell (always win)
#   2. local/.env                           (worktree-specific, highest file priority)
#   3. ~/.config/powershop-analytics/.env  (centralized, lowest file priority)
#
# Load lowest priority first: since load_env_file skips keys already in os.environ,
# loading local/.env first sets those keys, then centralized only fills in gaps.

_REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

load_env_file "${_REPO_ROOT}/local/.env"
load_env_file "${HOME}/.config/powershop-analytics/.env"
