#!/usr/bin/env bash
# Detect an Anthropic / Claude Code rate-limit in the current workflow run's
# live job logs. Called from `Handle failure` steps to distinguish a rate-limit
# failure (retry when it lifts) from a generic transient failure (retry after
# the watchdog's default wait).
#
# Usage: detect-rate-limit.sh RUN_ID [REPO]
#   RUN_ID — the GitHub Actions run id (${{ github.run_id }})
#   REPO   — OWNER/REPO; defaults to $GITHUB_REPOSITORY
#
# Env:
#   GH_TOKEN — required; must have `actions: read`
#
# Output (stdout, key=value lines) and $GITHUB_OUTPUT when set:
#   rate_limit_reset_epoch=<unix seconds>
#   rate_limit_reset_iso=<YYYY-MM-DDTHH:MM:SSZ>
#
# If no rate-limit signal is detected, exits 0 silently without writing output.
# On any infrastructure error (logs not fetchable, unzip missing, etc.) also
# exits 0 silently so the caller falls back to generic failure handling.
set -uo pipefail

RUN_ID="${1:-}"
REPO="${2:-${GITHUB_REPOSITORY:-}}"
if [ -z "$RUN_ID" ] || [ -z "$REPO" ]; then
  echo "detect-rate-limit: RUN_ID and REPO required" >&2
  exit 0
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# Fetch logs for every in-progress / completed job of this run. The job logs
# endpoint returns plaintext even while a job is still running, so we can call
# it from within the failing job itself.
JOBS_JSON=$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs" 2>/dev/null || echo '{}')
JOB_IDS=$(echo "$JOBS_JSON" \
  | jq -r '.jobs[]? | select(.status == "in_progress" or .status == "completed") | .id' \
  2>/dev/null || true)

if [ -z "$JOB_IDS" ]; then
  exit 0
fi

: > "$tmpdir/all.log"
while IFS= read -r JID; do
  [ -z "$JID" ] && continue
  gh api "repos/$REPO/actions/jobs/$JID/logs" >> "$tmpdir/all.log" 2>/dev/null || true
done <<< "$JOB_IDS"

if [ ! -s "$tmpdir/all.log" ]; then
  exit 0
fi

reset_epoch=""

# Pattern 1: Claude Code's own human-readable marker embeds an epoch directly.
#   e.g. "Claude AI usage limit reached|1745608800"
val=$(grep -ohE 'Claude AI usage limit reached\|[0-9]{9,}' "$tmpdir/all.log" 2>/dev/null \
  | head -1 | awk -F'|' '{print $2}')
if [ -n "$val" ]; then
  reset_epoch="$val"
fi

# Pattern 2: Anthropic response headers carry an ISO-8601 reset timestamp.
#   e.g. "anthropic-ratelimit-unified-reset: 2026-04-18T20:15:00Z"
#        "anthropic-ratelimit-tokens-reset: 2026-04-18T20:15:00Z"
if [ -z "$reset_epoch" ]; then
  iso=$(grep -ohiE 'anthropic-ratelimit-[a-z_]+-reset["]?[: ]+[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+Z-]+' \
        "$tmpdir/all.log" 2>/dev/null \
    | head -1 | grep -ohE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+Z-]+' | head -1)
  if [ -n "$iso" ]; then
    reset_epoch=$(date -u -d "$iso" +%s 2>/dev/null || echo "")
  fi
fi

# Pattern 3: HTTP `Retry-After: <seconds>` header (relative).
if [ -z "$reset_epoch" ]; then
  sec=$(grep -ohiE 'retry[- ]?after["]?[: ]+[0-9]+' "$tmpdir/all.log" 2>/dev/null \
    | head -1 | grep -ohE '[0-9]+$')
  if [ -n "$sec" ]; then
    reset_epoch=$(( $(date -u +%s) + sec ))
  fi
fi

# Pattern 4: JSON error body "retry_after":<seconds>.
if [ -z "$reset_epoch" ]; then
  sec=$(grep -ohE '"retry_after"[[:space:]]*:[[:space:]]*[0-9]+' "$tmpdir/all.log" 2>/dev/null \
    | head -1 | grep -ohE '[0-9]+$')
  if [ -n "$sec" ]; then
    reset_epoch=$(( $(date -u +%s) + sec ))
  fi
fi

if [ -z "$reset_epoch" ]; then
  exit 0
fi

# Sanity-clamp: must be in the future, capped at 12h.
now=$(date -u +%s)
if [ "$reset_epoch" -le "$now" ]; then
  exit 0
fi
max=$((now + 43200))
if [ "$reset_epoch" -gt "$max" ]; then
  reset_epoch="$max"
fi

iso=$(date -u -d "@$reset_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
echo "rate_limit_reset_epoch=$reset_epoch"
echo "rate_limit_reset_iso=$iso"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "rate_limit_reset_epoch=$reset_epoch"
    echo "rate_limit_reset_iso=$iso"
  } >> "$GITHUB_OUTPUT"
fi
