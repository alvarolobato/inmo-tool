#!/bin/bash
# Install the launchd agent that keeps ~/.claude/.credentials.json fresh from
# the macOS Keychain so the dashboard container can read it without any
# manual intervention. Idempotent: re-running replaces the agent with the
# current template.
#
# What it does:
#   1. Resolves the repo root (the directory two levels above this script).
#   2. Renders scripts/launchd/com.powershop.claude-token-sync.plist.template
#      into ~/Library/LaunchAgents/com.powershop.claude-token-sync.plist
#      with __REPO_ROOT__ and __HOME__ substituted.
#   3. Bootstraps it via launchctl. Tries `launchctl bootstrap gui/<uid>` first
#      (modern API, macOS 10.10+) and falls back to `launchctl load` for older
#      systems.
#   4. Triggers a kickstart so the first run happens immediately, surfacing
#      any setup errors right away.
#
# Safety: this script never touches the Keychain itself. It only installs the
# plist and asks launchd to start it. The agent's job is sync-only — see the
# header of scripts/sync-claude-token.sh for the why.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
TEMPLATE="$SCRIPT_DIR/launchd/com.powershop.claude-token-sync.plist.template"
PLIST="$HOME/Library/LaunchAgents/com.powershop.claude-token-sync.plist"
LABEL="com.powershop.claude-token-sync"

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: Template not found at $TEMPLATE" >&2
  exit 1
fi
if [ ! -x "$REPO_ROOT/scripts/sync-claude-token.sh" ]; then
  chmod +x "$REPO_ROOT/scripts/sync-claude-token.sh"
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Ensure the kick file exists so launchd's WatchPaths has something to watch.
# The dashboard container touches this file on demand to trigger an
# immediate Keychain → ~/.claude/.credentials.json sync (recovery path
# for the case where a host-side `claude` invocation rotates the
# refresh_token while the container still holds the previous access_token).
KICK_DIR="$HOME/.config/powershop-analytics"
KICK_FILE="$KICK_DIR/.claude-token-kick"
mkdir -p "$KICK_DIR"
[ -e "$KICK_FILE" ] || : > "$KICK_FILE"
chmod 0664 "$KICK_FILE"

# Render template. We use `|` as the sed delimiter so the substituted absolute
# paths (which contain `/`) do not need escaping.
sed \
  -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
  -e "s|__HOME__|$HOME|g" \
  "$TEMPLATE" > "$PLIST"
chmod 644 "$PLIST"

# Unload any existing instance so we always pick up the new plist content.
# Both the modern bootout and the legacy unload may legitimately fail when
# the agent isn't loaded yet — ignore non-zero exit.
UID_REAL=$(id -u)
launchctl bootout "gui/$UID_REAL/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true

# Bootstrap (modern) with a fallback to load (legacy).
if ! launchctl bootstrap "gui/$UID_REAL" "$PLIST" 2>/dev/null; then
  launchctl load "$PLIST"
fi

# Kickstart so the first sync runs right now (otherwise we wait up to 2h).
launchctl kickstart -k "gui/$UID_REAL/$LABEL" 2>/dev/null || true

echo "Installed launchd agent: $LABEL"
echo "  Plist:      $PLIST"
echo "  Repo root:  $REPO_ROOT"
echo "  Log file:   $HOME/Library/Logs/com.powershop.claude-token-sync.log"
echo "  Interval:   every 2 hours (StartInterval=7200)"
echo
echo "Verify:"
echo "  launchctl list | grep $LABEL"
echo "  tail -n 10 \$HOME/Library/Logs/com.powershop.claude-token-sync.log"
