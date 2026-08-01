#!/bin/bash
# Sync the Claude OAuth payload from the macOS Keychain to
# ~/.claude/.credentials.json so the dashboard container can read it.
#
# This is THE refresher entrypoint, run on a schedule by the launchd agent
# (~/Library/LaunchAgents/com.powershop.claude-token-sync.plist). Despite the
# name, it does NOT attempt to refresh the OAuth token itself — that endpoint
# at claude.ai is protected by Cloudflare and direct curl POSTs return an
# anti-bot challenge page (issue #419, D-024). The host claude CLI handles
# token rotation internally during normal use; we only mirror its output.
#
# The dashboard container also never refreshes — see
# docs/decisions/D-025-oauth-single-refresher.md and the Apr 2026 incident in
# memory/project_dashboard_claude_cli_auth.md (rotating refresh_tokens from
# the container invalidated the Keychain copy and forced the host user to
# `claude /login`).
#
# Behaviour:
#   1. Read the OAuth payload from the Keychain entry "Claude Code-credentials".
#   2. Validate it as JSON with a claudeAiOauth.expiresAt field.
#   3. Atomically write it to ~/.claude/.credentials.json (chmod 600). The
#      atomic rename means the container never sees a half-written file.
#   4. Print the remaining lifetime so launchd logs serve as a heads-up.
#
# When the access_token actually expires and host claude cannot refresh
# (Cloudflare-blocked), the user runs `claude /login` once. This script keeps
# the container in sync but does not try to be cleverer than the platform
# allows.
#
# Idempotent. Safe to run hundreds of times per day. Always exits 0 — failures
# are logged but don't fail the launchd cycle.

set -u
set -o pipefail

KEYCHAIN_SVC="${CLAUDE_KEYCHAIN_SVC:-Claude Code-credentials}"
# Default to `$(id -un)` rather than `$USER` because under launchd `USER` is
# often unset and `set -u` would crash. `id -un` always resolves the real
# user even in a stripped launchd environment.
KEYCHAIN_ACCT="${CLAUDE_KEYCHAIN_ACCT:-$(id -un)}"
CREDS_FILE="${CLAUDE_CREDS_FILE:-$HOME/.claude/.credentials.json}"
WARN_THRESHOLD_HOURS="${WARN_THRESHOLD_HOURS:-6}"

log() {
  printf '[claude-token-sync %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

TOKEN_JSON=$(security find-generic-password -s "$KEYCHAIN_SVC" -a "$KEYCHAIN_ACCT" -w 2>/dev/null || true)
if [ -z "$TOKEN_JSON" ]; then
  log "ERROR: Keychain entry '$KEYCHAIN_SVC' (account '$KEYCHAIN_ACCT') not found."
  log "       Run 'claude /login' on this Mac, then re-run this script."
  exit 0
fi

# Validate JSON shape and extract expiresAt. We pass the JSON via env var so
# stdin redirection cannot conflict.
HOURS_LEFT=$(CLAUDE_TOKEN_JSON="$TOKEN_JSON" python3 -c '
import json, os, sys, time
try:
    d = json.loads(os.environ["CLAUDE_TOKEN_JSON"])
    exp = d["claudeAiOauth"]["expiresAt"]
except Exception:
    sys.exit(1)
print((exp - int(time.time() * 1000)) // 3600000)
' 2>/dev/null || true)
if [ -z "$HOURS_LEFT" ]; then
  log "ERROR: Keychain entry is not valid Claude OAuth JSON."
  exit 0
fi

# Atomic file write so the container never sees a partial file.
mkdir -p "$(dirname "$CREDS_FILE")"
TMP="${CREDS_FILE}.tmp.$$"
printf '%s' "$TOKEN_JSON" > "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$CREDS_FILE"

if [ "$HOURS_LEFT" -le 0 ]; then
  log "WARN: access_token already expired ${HOURS_LEFT#-}h ago. Synced anyway."
  log "      If host 'claude' cannot refresh, run 'claude /login' and re-run this script."
elif [ "$HOURS_LEFT" -le "$WARN_THRESHOLD_HOURS" ]; then
  log "Token nearing expiry (${HOURS_LEFT}h left). Synced to $CREDS_FILE."
  log "Heads-up: if host 'claude' cannot refresh in time you may need to re-run 'claude /login'."
else
  log "Token valid ${HOURS_LEFT}h. Synced to $CREDS_FILE."
fi

# Note: CLAUDE_CODE_OAUTH_TOKEN in GitHub Actions is managed via `claude /install-github-app`
# which issues a 1-year token. No need to sync it here.
