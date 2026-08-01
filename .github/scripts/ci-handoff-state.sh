#!/usr/bin/env bash
# Print whether PR CI jobs (from workflow "CI": lint, test, docker-build) are
# safe for owner handoff. Used by ai-address-feedback and ai-pr-review.
# Usage: ci-handoff-state.sh OWNER/REPO PR_NUMBER
# stdout: ready | pending | failing
set -euo pipefail
REPO="${1:?repo}"
PR="${2:?pr number}"
gh pr view "$PR" --repo "$REPO" --json statusCheckRollup | jq -r '
  .statusCheckRollup
  | map(select(
      (.workflowName == "CI")
      or (.name == "lint")
      or (.name == "test")
      or (.name == "docker-build")
    ))
  | if length == 0 then "pending"
    elif any(.[]; (.status // "") != "COMPLETED") then "pending"
    elif any(.[]; (.conclusion // "") == "FAILURE" or .conclusion == "CANCELLED" or .conclusion == "TIMED_OUT") then "failing"
    else "ready" end
'
