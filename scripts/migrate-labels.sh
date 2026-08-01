#!/usr/bin/env bash
# Label migration: rename ai-* state labels to fact-*, migrate obsolete labels,
# delete retired labels, and create new owner-facing labels.
#
# Run AFTER Phase 2 YAML diffs have been committed to .github/workflows/.
# The preflight check enforces this order — it aborts if old ai-* state label
# names are still found in workflow YAML files.
#
# Usage:
#   bash scripts/migrate-labels.sh [--dry-run] [--repo owner/repo]
#
# See docs/ai-factory.md "Label migration (one-time)" for the full runbook.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DRY_RUN=false
REPO=""

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --repo)
      if [[ $# -lt 2 || -z "${2-}" ]]; then
        echo "Error: --repo requires an argument (e.g. --repo owner/repo)" >&2
        echo "Usage: $0 [--dry-run] [--repo owner/repo]" >&2
        exit 1
      fi
      REPO="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--dry-run] [--repo owner/repo]" >&2
      exit 1
      ;;
  esac
done

# Build repo args array so empty flag doesn't pass a blank string to gh
GH_REPO_ARGS=()
if [[ -n "$REPO" ]]; then
  GH_REPO_ARGS=("--repo" "$REPO")
fi

# --- Helpers ---
info() { echo "[info] $*"; }

dry_or_run() {
  if $DRY_RUN; then
    echo "[dry-run]" "$@"
  else
    "$@"
  fi
}

label_exists() {
  local name="$1"
  gh label list "${GH_REPO_ARGS[@]}" --limit 1000 --json name --jq '.[].name' 2>/dev/null \
    | grep -qx "$name"
}

# --- Preflight check ---
info "=== Preflight check ==="
OLD_STATE_LABELS=(
  "ai-task"
  "ai-planned"
  "ai-in-progress"
  "ai-ready-for-review"
  "ai-phase-copilot"
  "ai-phase-opus"
  "ai-cp-after-1"
  "ai-o-after-1"
  "ai-auto-retry"
  "ai-ci-failing"
  "ai-needs-rewrite"
  "ai-parent-incomplete"
  "ai-parent-verified"
  "factory-manager-tracking"
)

WORKFLOWS_DIR="$REPO_ROOT/.github/workflows"
PREFLIGHT_RAN=false
if [[ ! -d "$WORKFLOWS_DIR" ]]; then
  echo "WARNING: .github/workflows/ not found at $WORKFLOWS_DIR — preflight check skipped." >&2
else
  PREFLIGHT_RAN=true
  FOUND_OLD_REFS=false
  for label in "${OLD_STATE_LABELS[@]}"; do
    # Search non-comment lines for the label name
    while IFS= read -r filepath; do
      if grep -qE "^[^#]*(\"${label}\"|'${label}')" "$filepath" 2>/dev/null; then
        if ! $FOUND_OLD_REFS; then
          echo "" >&2
          echo "ERROR: Workflow YAML files still reference old label names." >&2
          echo "" >&2
          echo "The following workflow files must be updated to use fact-* names before running this script:" >&2
          FOUND_OLD_REFS=true
        fi
        grep -nE "^[^#]*(\"${label}\"|'${label}')" "$filepath" | while IFS=: read -r lineno _rest; do
          echo "  $filepath:$lineno  ($label)" >&2
        done
      fi
    done < <(grep -rl "$label" "$WORKFLOWS_DIR"/*.yml 2>/dev/null || true)
  done

  if $FOUND_OLD_REFS; then
    echo "" >&2
    echo "Renaming labels before the YAML is updated would break live workflows." >&2
    echo "Update .github/workflows/ to use fact-* label names first, then re-run this script." >&2
    echo "See docs/ai-factory.md \"Label migration (one-time)\" for the full runbook." >&2
    echo "" >&2
    exit 1
  fi
fi

if $PREFLIGHT_RAN; then
  info "Preflight check passed — no old label names found in workflow YAML."
else
  info "Preflight check skipped — .github/workflows/ directory not found."
fi

if $DRY_RUN; then
  echo ""
  info "=== DRY-RUN MODE — no changes will be made ==="
  echo ""
fi

# --- Rename block: ai-* → fact-* ---
info "=== Renaming internal state labels (ai-* → fact-*) ==="

declare -A RENAMES=(
  ["ai-task"]="fact-task"
  ["ai-planned"]="fact-planned"
  ["ai-in-progress"]="fact-in-progress"
  ["ai-ready-for-review"]="fact-ready-for-review"
  ["ai-phase-copilot"]="fact-phase-copilot"
  ["ai-phase-opus"]="fact-phase-opus"
  ["ai-cp-after-1"]="fact-cp-after-1"
  ["ai-o-after-1"]="fact-o-after-1"
  ["ai-auto-retry"]="fact-auto-retry"
  ["ai-ci-failing"]="fact-ci-failing"
  ["ai-needs-rewrite"]="fact-needs-rewrite"
  ["ai-parent-incomplete"]="fact-parent-incomplete"
  ["ai-parent-verified"]="fact-parent-verified"
  ["factory-manager-tracking"]="fact-manager-tracking"
)

# Ordered list so output is deterministic
RENAME_ORDER=(
  "ai-task"
  "ai-planned"
  "ai-in-progress"
  "ai-ready-for-review"
  "ai-phase-copilot"
  "ai-phase-opus"
  "ai-cp-after-1"
  "ai-o-after-1"
  "ai-auto-retry"
  "ai-ci-failing"
  "ai-needs-rewrite"
  "ai-parent-incomplete"
  "ai-parent-verified"
  "factory-manager-tracking"
)

for old_name in "${RENAME_ORDER[@]}"; do
  new_name="${RENAMES[$old_name]}"
  if label_exists "$new_name"; then
    info "  SKIP $old_name → $new_name (target already exists)"
  elif label_exists "$old_name"; then
    dry_or_run gh label edit "$old_name" "${GH_REPO_ARGS[@]}" \
      --name "$new_name" \
      --color "ededed" \
      --description "state label — workflows toggle, owner ignores"
    if $DRY_RUN; then
      info "  WOULD RENAME $old_name → $new_name"
    else
      info "  RENAMED $old_name → $new_name"
    fi
  else
    info "  SKIP $old_name → $new_name (source label not found)"
  fi
done

# --- Migrate-then-delete block ---
info "=== Migrating obsolete labels to component labels ==="

migrate_label() {
  local old_label="$1"
  local new_label="$2"

  if ! label_exists "$old_label"; then
    info "  SKIP migrate $old_label → $new_label (label not found, already deleted)"
    return
  fi

  # Migrate open issues — fail fast if listing fails to avoid deleting label with missed issues
  local count=0
  local issue_list
  if ! issue_list=$(gh issue list "${GH_REPO_ARGS[@]}" \
    --label "$old_label" --state open --limit 1000 \
    --json number --jq '.[].number' 2>&1); then
    echo "ERROR: Failed to list issues for label '$old_label': $issue_list" >&2
    exit 1
  fi
  while IFS= read -r issue_number; do
    [[ -z "$issue_number" ]] && continue
    dry_or_run gh issue edit "$issue_number" "${GH_REPO_ARGS[@]}" \
      --add-label "$new_label" \
      --remove-label "$old_label"
    count=$((count + 1))
  done <<< "$issue_list"

  if $DRY_RUN; then
    info "  WOULD MIGRATE $count open issues: $old_label → $new_label"
  else
    info "  MIGRATED $count open issues: $old_label → $new_label"
  fi

  # Delete the old label
  dry_or_run gh label delete "$old_label" "${GH_REPO_ARGS[@]}" --yes
  if $DRY_RUN; then
    info "  WOULD DELETE label $old_label"
  else
    info "  DELETED label $old_label"
  fi
}

migrate_label "dashboard-app" "comp-dashboard"
migrate_label "deployment" "comp-infra"
migrate_label "documentation" "comp-docs"

# Delete phase-2 (no migration target — phase concept moves into issue body)
info "=== Deleting retired labels ==="
if label_exists "phase-2"; then
  dry_or_run gh label delete "phase-2" "${GH_REPO_ARGS[@]}" --yes
  if $DRY_RUN; then
    info "  WOULD DELETE label phase-2"
  else
    info "  DELETED label phase-2"
  fi
else
  info "  SKIP phase-2 (already deleted)"
fi

# --- Create new owner-facing labels ---
info "=== Creating new owner-facing labels ==="

if label_exists "ai-plan"; then
  info "  SKIP ai-plan (already exists)"
else
  dry_or_run gh label create "ai-plan" "${GH_REPO_ARGS[@]}" \
    --color "0E8A16" \
    --description "Owner trigger — run planner only"
  if $DRY_RUN; then info "  WOULD CREATE ai-plan"; else info "  CREATED ai-plan"; fi
fi

if label_exists "ai-decompose"; then
  info "  SKIP ai-decompose (already exists)"
else
  dry_or_run gh label create "ai-decompose" "${GH_REPO_ARGS[@]}" \
    --color "D93F0B" \
    --description "Owner opt-in — legacy parent→sub-issues planner"
  if $DRY_RUN; then info "  WOULD CREATE ai-decompose"; else info "  CREATED ai-decompose"; fi
fi

# --- Postflight verify ---
if ! $DRY_RUN; then
  info "=== Postflight verification ==="
  echo ""
  echo "Current fact-* and new owner labels:"
  gh label list "${GH_REPO_ARGS[@]}" --limit 1000 --json name,color,description \
    --jq '.[] | select(.name | test("^fact-|^ai-plan$|^ai-decompose$")) | "\(.name)  #\(.color)  \(.description)"' \
    | sort

  echo ""
  echo "Checking for retired labels (should be empty):"
  for retired in "dashboard-app" "deployment" "documentation" "phase-2"; do
    if label_exists "$retired"; then
      echo "  WARNING: $retired still exists!"
    else
      echo "  OK: $retired not found"
    fi
  done

  echo ""
  echo "Checking old state-label names are gone:"
  for old_name in "${RENAME_ORDER[@]}"; do
    if label_exists "$old_name"; then
      echo "  WARNING: $old_name still exists (rename may have failed)"
    else
      echo "  OK: $old_name gone"
    fi
  done
fi

info "=== Done ==="
if $DRY_RUN; then
  echo ""
  echo "This was a dry run. Re-run without --dry-run to apply changes."
fi
