#!/usr/bin/env bash
# Push the Claude subscription quota into the dashboard (D-107).
#
# WHY THIS RUNS ON THE HOST
# -------------------------
# `claude -p "/usage"` reports subscription consumption only under the
# interactive OAuth credential file (~/.claude/.credentials.json). Verified by
# running the newer host CLI with the container's CLAUDE_CODE_OAUTH_TOKEN: it
# returns a local session-cost summary instead of the quota view. So the
# dashboard container cannot read this no matter what it runs — the reading has
# to come from where the credentials live, same as the launchd credential sync
# (D-025).
#
# COST: none. The probe is a metadata command, not a model call — measured
# total_cost_usd 0, zero input/output tokens, num_turns 0, ~2.6s. Polling it
# does not consume the quota it reports.
#
# NOTE: it must run WITHOUT the dashboard's lean flags — `--disable-slash-commands`
# makes it answer "/usage isn't available in this environment."
#
# USAGE
#   DASHBOARD_URL=http://localhost:4001 \
#   ADMIN_API_KEY=... \
#     scripts/claude-quota-poller.sh            # one shot
#   ... INTERVAL_SECONDS=600 scripts/claude-quota-poller.sh --loop
#
# Install as a launchd agent (macOS) or a cron entry to keep it fresh; the
# dashboard treats a reading older than dashboard.llm_quota_max_age_seconds as
# unknown and stops enforcing the cap rather than blocking work.

set -euo pipefail

DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:4000}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-600}"

if [ -z "${ADMIN_API_KEY:-}" ]; then
  echo "claude-quota-poller: ADMIN_API_KEY is required" >&2
  exit 2
fi

poll_once() {
  local raw usage_text payload http

  # Deliberately no lean flags here (see the note above).
  if ! raw="$("$CLAUDE_BIN" -p "/usage" --output-format json 2>/dev/null)"; then
    echo "claude-quota-poller: the claude CLI failed" >&2
    return 1
  fi

  # Pull the human-readable text out of the envelope. `strict=False` because
  # the result string contains raw control characters (bullets, newlines).
  usage_text="$(printf '%s' "$raw" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin, strict=False)
except Exception:
    sys.exit(1)
sys.stdout.write(d.get("result") or "")
')" || { echo "claude-quota-poller: could not parse the CLI envelope" >&2; return 1; }

  if [ -z "$usage_text" ]; then
    echo "claude-quota-poller: empty /usage output" >&2
    return 1
  fi

  # A container-auth CLI answers with a session-cost summary instead of the
  # quota view. Detect that explicitly rather than POSTing something the
  # dashboard will reject, so the operator gets an actionable message.
  case "$usage_text" in
    *"% used"*) : ;;
    *)
      echo "claude-quota-poller: this CLI reports no subscription quota." >&2
      echo "  It must run as a user authenticated with ~/.claude/.credentials.json;" >&2
      echo "  CLAUDE_CODE_OAUTH_TOKEN auth only yields a session-cost summary." >&2
      return 1
      ;;
  esac

  payload="$(printf '%s' "$usage_text" | python3 -c '
import sys, json
print(json.dumps({"usage_text": sys.stdin.read(), "source": "host-poller"}))
')"

  # The admin key goes in via --config on stdin-adjacent fd, NOT on the argv:
  # a header argument is visible in `ps aux` to every user on the box, and
  # under --loop that exposure repeats forever.
  http="$(printf '%s' "$payload" | curl -s -o /dev/null -w '%{http_code}' \
    --max-time 30 \
    --config <(printf 'header = "X-Admin-Key: %s"\n' "$ADMIN_API_KEY") \
    -X POST "$DASHBOARD_URL/api/etl/llm-quota" \
    -H "Content-Type: application/json" \
    --data-binary @-)"

  if [ "$http" != "200" ]; then
    echo "claude-quota-poller: dashboard returned HTTP $http" >&2
    return 1
  fi

  printf '%s\n' "$usage_text" | grep -E '% used' || true
  return 0
}

case "${1:-}" in
  ""|--loop) : ;;
  *)
    echo "claude-quota-poller: unknown argument '$1' (expected --loop or nothing)" >&2
    exit 2
    ;;
esac

if [ "${1:-}" = "--loop" ]; then
  while true; do
    poll_once || true
    sleep "$INTERVAL_SECONDS"
  done
else
  poll_once
fi
