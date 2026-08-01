#!/bin/bash
# Remove the Claude token-sync launchd agent installed by
# scripts/install-claude-token-launchd.sh. Leaves ~/.claude/.credentials.json
# and the macOS Keychain entry alone — those are managed by the host claude
# CLI and should not be touched here.

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.powershop.claude-token-sync.plist"
LABEL="com.powershop.claude-token-sync"
UID_REAL=$(id -u)

launchctl bootout "gui/$UID_REAL/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  echo "Removed plist: $PLIST"
else
  echo "Plist not found at $PLIST (already uninstalled?)"
fi

echo "Uninstalled launchd agent: $LABEL"
