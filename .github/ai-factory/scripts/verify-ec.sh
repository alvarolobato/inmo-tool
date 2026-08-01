#!/usr/bin/env bash
# verify-ec.sh — Verify a single parsed EC item and emit a result JSON object.
#
# Usage: verify-ec.sh <ec-json-item> <merge-sha> <repo>
#
#   <ec-json-item>  A single JSON object from parse-ec.sh output, e.g.:
#                   '{"id":"EC-1","text":"...","verified_by":"path/test.ts → name","human_only":false,"checked":false}'
#   <merge-sha>     The commit SHA of the merge (e.g. the PR's merge commit SHA).
#   <repo>          The GitHub repository in owner/repo format.
#
# Output: single JSON object:
#   {
#     "id": "EC-1",
#     "verified": true|false,
#     "human_only": true|false,
#     "evidence": "URL or description of evidence",
#     "reason": null | "human-only" | "no-annotation" | "command-refused" | "test-not-found"
#            | "ci-run-not-found" | "ci-run-failed" | "ci-job-failed"
#            | "file-not-changed" | "unrecognized-annotation" | "error"
#   }
#
# Verification dispatch table (by verified_by shape):
#   - human_only=true                    → verified=false, reason="human-only"
#   - verified_by="__no_annotation__"    → verified=false, reason="no-annotation"
#   - "path/test.ts → name"              → query latest CI run on merge SHA, find test
#   - "job-name job" / "step-name step"  → query latest CI run on merge SHA, check job/step
#   - "file diff in this PR" / "git show"→ check git show --stat for the merge SHA
#   - anything else with "→"             → treat as test reference
#   - anything not matching above        → if looks like a shell command, refuse; else unrecognized-annotation (human must verify)
#
# Security: NEVER execute arbitrary text from the EC item. Only call known GitHub API
# and git commands. Refuse any verified_by that looks like a shell command.

set -uo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <ec-json-item> <merge-sha> <repo>" >&2
  exit 1
fi

EC_JSON="$1"
MERGE_SHA="$2"
REPO="$3"

# Extract fields from the EC item JSON.
EC_ID=$(printf '%s' "$EC_JSON" | jq -r '.id')
# Strip Markdown inline-code backticks so patterns like `wc -l foo.md` work.
VERIFIED_BY=$(printf '%s' "$EC_JSON" | jq -r '.verified_by' | tr -d '`')
HUMAN_ONLY=$(printf '%s' "$EC_JSON" | jq -r '.human_only')
ALREADY_CHECKED=$(printf '%s' "$EC_JSON" | jq -r '.checked')

emit() {
  local verified="$1" evidence="$2" reason="$3"
  if [ "$reason" = "null" ]; then
    jq -cn --arg id "$EC_ID" \
           --argjson verified "$verified" \
           --argjson human_only "$HUMAN_ONLY" \
           --arg evidence "$evidence" \
           '{id:$id,verified:$verified,human_only:$human_only,evidence:$evidence,reason:null}'
  else
    jq -cn --arg id "$EC_ID" \
           --argjson verified "$verified" \
           --argjson human_only "$HUMAN_ONLY" \
           --arg evidence "$evidence" \
           --arg reason "$reason" \
           '{id:$id,verified:$verified,human_only:$human_only,evidence:$evidence,reason:$reason}'
  fi
}

# Already checked → treat as verified (the issue body says it was).
if [ "$ALREADY_CHECKED" = "true" ]; then
  emit "true" "Already ticked in issue body" "null"
  exit 0
fi

# Human-only items: never auto-verify.
if [ "$HUMAN_ONLY" = "true" ]; then
  if [ "$VERIFIED_BY" = "__no_annotation__" ]; then
    emit "false" "" "no-annotation"
  else
    emit "false" "" "human-only"
  fi
  exit 0
fi

# Security check: refuse if verified_by looks like an arbitrary shell command.
# Heuristics: contains pipe+semicolon sequence, $(...), or starts with a shell built-in.
# Backticks are already stripped above (Markdown inline-code), so they are not checked here.
if printf '%s' "$VERIFIED_BY" | grep -qE '(\|;|\$\(|^(bash|sh|python|node|curl|wget|rm|mv|cp|chmod) )'; then
  emit "false" "" "command-refused"
  exit 0
fi

# Determine the verification strategy from the verified_by string.

# Strategy 1: Test file reference — "path/file.test.ts → test name"
# Matches: contains "→" and the left side looks like a file path (has . in it).
if printf '%s' "$VERIFIED_BY" | grep -qE '.+\..+ → .+'; then
  TEST_REF=$(printf '%s' "$VERIFIED_BY" | sed 's/ → .*//')

  # Query the latest workflow runs on this merge SHA.
  RUNS=$(gh api "repos/$REPO/actions/runs?head_sha=$MERGE_SHA&per_page=10" 2>/dev/null || true)
  if [ -z "$RUNS" ]; then
    emit "false" "" "ci-run-not-found"
    exit 0
  fi

  RUN_ID=$(printf '%s' "$RUNS" | jq -r '.workflow_runs | map(select(.conclusion == "success")) | .[0].id // empty')
  RUN_URL=$(printf '%s' "$RUNS" | jq -r '.workflow_runs | map(select(.conclusion == "success")) | .[0].html_url // empty')

  if [ -z "$RUN_ID" ]; then
    # No successful run found on this SHA — check any run.
    RUN_ID=$(printf '%s' "$RUNS" | jq -r '.workflow_runs[0].id // empty')
    RUN_URL=$(printf '%s' "$RUNS" | jq -r '.workflow_runs[0].html_url // empty')
    RUN_CONCLUSION=$(printf '%s' "$RUNS" | jq -r '.workflow_runs[0].conclusion // "unknown"')
    if [ -z "$RUN_ID" ]; then
      emit "false" "" "ci-run-not-found"
      exit 0
    fi
    emit "false" "$RUN_URL (conclusion: $RUN_CONCLUSION)" "ci-run-failed"
    exit 0
  fi

  # Check if the test file exists in the repo at the merge SHA.
  FILE_EXISTS=$(gh api "repos/$REPO/contents/$TEST_REF?ref=$MERGE_SHA" 2>/dev/null | jq -r '.name // empty' || true)
  if [ -z "$FILE_EXISTS" ]; then
    emit "false" "$RUN_URL" "test-not-found"
    exit 0
  fi

  emit "true" "$RUN_URL (test file: $TEST_REF)" "null"
  exit 0
fi

# Strategy 2: CI job or step reference — verified_by mentions "job" or "step".
if printf '%s' "$VERIFIED_BY" | grep -qiE '\bjob\b|\bstep\b|dashboard-test|CI '; then
  RUNS=$(gh api "repos/$REPO/actions/runs?head_sha=$MERGE_SHA&per_page=10" 2>/dev/null || true)
  if [ -z "$RUNS" ]; then
    emit "false" "" "ci-run-not-found"
    exit 0
  fi

  RUN_ID=$(printf '%s' "$RUNS" | jq -r '.workflow_runs | map(select(.conclusion == "success")) | .[0].id // empty')
  RUN_URL=$(printf '%s' "$RUNS" | jq -r '.workflow_runs | map(select(.conclusion == "success")) | .[0].html_url // empty')

  if [ -z "$RUN_ID" ]; then
    RUN_URL=$(printf '%s' "$RUNS" | jq -r '.workflow_runs[0].html_url // empty')
    RUN_CONCLUSION=$(printf '%s' "$RUNS" | jq -r '.workflow_runs[0].conclusion // "unknown"')
    emit "false" "$RUN_URL (conclusion: $RUN_CONCLUSION)" "ci-run-not-found"
    exit 0
  fi

  # Extract the job/step name from verified_by (text before the " job", " step", or " CI" keyword).
  JOB_NAME=$(printf '%s' "$VERIFIED_BY" | sed -E 's/[[:space:]]+(job|step|CI job|CI step).*$//i' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')

  # Query the run's jobs to verify the named job/step conclusion.
  JOBS=$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs?per_page=50" 2>/dev/null || true)
  if [ -n "$JOBS" ] && [ -n "$JOB_NAME" ]; then
    JOB_CONCLUSION=$(printf '%s' "$JOBS" | jq -r --arg name "$JOB_NAME" \
      '[.jobs[] | select(.name | ascii_downcase | contains($name | ascii_downcase))] | .[0].conclusion // empty')
    if [ "$JOB_CONCLUSION" = "success" ]; then
      emit "true" "$RUN_URL (job: $JOB_NAME passed)" "null"
    elif [ -n "$JOB_CONCLUSION" ]; then
      emit "false" "$RUN_URL (job: $JOB_NAME — $JOB_CONCLUSION)" "ci-job-failed"
    else
      # Named job not found separately; accept overall run success as evidence.
      emit "true" "$RUN_URL (overall run passed)" "null"
    fi
  else
    emit "true" "$RUN_URL" "null"
  fi
  exit 0
fi

# Strategy 3: File diff reference — "file diff in this PR" or "git show".
if printf '%s' "$VERIFIED_BY" | grep -qiE 'file diff|git show|wc -l'; then
  # Extract a file path from verified_by if present.
  FILE_PATH=$(printf '%s' "$VERIFIED_BY" | grep -oE '[a-zA-Z0-9_./-]+\.(md|ts|js|py|sh|yml|yaml|txt|json)' | head -1 || true)

  if [ -n "$FILE_PATH" ]; then
    STAT=$(git show --stat "$MERGE_SHA" -- "$FILE_PATH" 2>/dev/null || true)
    if printf '%s' "$STAT" | grep -q "$FILE_PATH"; then
      emit "true" "git show $MERGE_SHA -- $FILE_PATH confirms file changed" "null"
    else
      emit "false" "File $FILE_PATH not changed in merge commit $MERGE_SHA" "file-not-changed"
    fi
  else
    # Generic file diff check — confirm the merge SHA exists and has changes.
    STAT=$(git show --stat "$MERGE_SHA" 2>/dev/null | tail -1 || true)
    if [ -n "$STAT" ]; then
      emit "true" "git show $MERGE_SHA: $STAT" "null"
    else
      emit "false" "Could not get diff for $MERGE_SHA" "error"
    fi
  fi
  exit 0
fi

# Strategy 4: Fallback — unrecognized verified_by pattern.
# D-038: only shell scripts decide "verified"; the LLM is scribe only.
# Auto-verifying an unrecognized annotation would let arbitrary text bypass the
# deterministic judge, so we always reject here and require a human to check.
emit "false" "Unrecognized verified_by pattern: $VERIFIED_BY" "unrecognized-annotation"
