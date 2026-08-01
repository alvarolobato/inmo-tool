#!/bin/sh
# Claude Code CLI auth bootstrap for the dashboard container.
#
# Auth approach (updated 2026-05-20, D-025 revised):
# CLAUDE_CODE_OAUTH_TOKEN env var holds the full ~/.claude/.credentials.json JSON.
# Generated once via `claude /install-github-app` — valid for 1 year.
# The CLI reads CLAUDE_CODE_OAUTH_TOKEN directly; no file mount required.
#
# DO NOT refresh from inside the container. D-025 still applies:
# refresh-token rotation invalidates the Keychain copy on the host.
# With a 1-year token, no refresh is needed. Regenerate annually via
# `claude /install-github-app` and update CLAUDE_CODE_OAUTH_TOKEN in .env.

if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && command -v node >/dev/null 2>&1; then
  node - <<'JSEOF'
let creds;
try { creds = JSON.parse(process.env.CLAUDE_CODE_OAUTH_TOKEN); } catch { process.exit(0); }

const oauth = creds?.claudeAiOauth;
if (!oauth?.expiresAt) {
  console.log('[claude-auth] CLAUDE_CODE_OAUTH_TOKEN has no expiresAt — cannot report token state.');
  process.exit(0);
}

const expiresIn = oauth.expiresAt - Date.now();
const hours = Math.round(expiresIn / 3600000);
const days = Math.round(expiresIn / 86400000);
if (expiresIn <= 0) {
  console.log(`[claude-auth] WARNING: token expired ${Math.abs(hours)}h ago.`);
  console.log('[claude-auth] Regenerate: run `claude /install-github-app` on the host,');
  console.log('[claude-auth] then update CLAUDE_CODE_OAUTH_TOKEN in ~/.config/powershop-analytics/.env.');
} else {
  console.log(`[claude-auth] Token valid for ${days} days (${hours}h).`);
}
JSEOF
else
  echo "[claude-auth] CLAUDE_CODE_OAUTH_TOKEN not set — CLI provider will be unavailable."
fi

# Conversation context-log volume. Per-turn context files (the exact payload sent
# to the LLM) are written here. Best-effort: the app degrades gracefully if the
# volume isn't writable (conversations still work, only the context log is skipped).
CTX_DIR="${DASHBOARD_CONTEXT_DIR:-/app/data/conversations}"
if mkdir -p "$CTX_DIR" 2>/dev/null && [ -w "$CTX_DIR" ]; then
  echo "[context-store] context dir ready: $CTX_DIR"
else
  echo "[context-store] WARNING: $CTX_DIR is not writable by uid $(id -u) — context logs will be skipped."
  echo "[context-store] Fix on host: mkdir -p ./data/dashboard/conversations && chown -R 1001:1001 ./data/dashboard/conversations"
fi

exec "$@"
