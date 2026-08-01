#!/usr/bin/env bash
# Tests the regex patterns used by ai-multi-phase-guard.yml and
# ai-post-merge-verify.yml against fixture issue/PR bodies.
#
# Why this exists: ai-post-merge-verify.yml originally used
#   grep -cF '- [ ] **EC-'
# which silently returned 0 on issue #720's body, despite 12 matching lines.
# That bug was invisible until PR #730 merged and auto-closed #720
# without the reopen path firing (issue #733). The anchored regex
#   grep -cE '^- \[ \] \*\*EC-[0-9]'
# fixes it. This script proves both bugs at once.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$(cd "$SCRIPT_DIR/../fixtures" && pwd)"

PASS=0
FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ✓ %-60s expected=%s actual=%s\n' "$name" "$expected" "$actual"
    PASS=$((PASS + 1))
  else
    printf '  ✗ %-60s expected=%s actual=%s\n' "$name" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

# Count unchecked EC items using the anchored regex (the fix from D-037).
count_unchecked_ec() {
  grep -cE '^- \[ \] \*\*EC-[0-9]' "$1" || true
}

# Count total ## Phase N headings.
count_phases() {
  grep -cE '^## Phase [0-9]+' "$1" || true
}

# Detect any GitHub closing keyword for a given issue number in a PR body.
# Returns 0 if a closing keyword is found, 1 otherwise.
has_closing_keyword() {
  local body_file="$1" issue_num="$2"
  grep -qiE "(close[sd]?|closing|fix(e[sd]|ing)?|resolve[sd]?|resolving) #${issue_num}\b" "$body_file"
}

echo "== count_unchecked_ec on fixtures =="
check "single-no-ec.md          → 0 EC items"   0 "$(count_unchecked_ec "$FIXTURES_DIR/single-no-ec.md")"
check "single-with-ec.md        → 3 EC items"   3 "$(count_unchecked_ec "$FIXTURES_DIR/single-with-ec.md")"
check "multi-incomplete.md      → 12 EC items"  12 "$(count_unchecked_ec "$FIXTURES_DIR/multi-incomplete.md")"
check "multi-complete.md        → 0 EC items"   0 "$(count_unchecked_ec "$FIXTURES_DIR/multi-complete.md")"

echo
echo "== count_phases on fixtures =="
check "single-no-ec.md          → 1 phase"      1 "$(count_phases "$FIXTURES_DIR/single-no-ec.md")"
check "single-with-ec.md        → 1 phase"      1 "$(count_phases "$FIXTURES_DIR/single-with-ec.md")"
check "multi-incomplete.md      → 4 phases"     4 "$(count_phases "$FIXTURES_DIR/multi-incomplete.md")"
check "multi-complete.md        → 2 phases"     2 "$(count_phases "$FIXTURES_DIR/multi-complete.md")"

echo
echo "== has_closing_keyword (case-insensitive, multiple forms) =="
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

cases=(
  "Closes #720|720|0"      # plain
  "closes #720|720|0"      # lowercase
  "Fixes #720|720|0"
  "FIXED #720|720|0"
  "Resolves #720|720|0"
  "Closing #720|720|0"
  "Part of #720|720|1"     # not a closing keyword
  "Related to #720|720|1"
  "Closes #999|720|1"      # different issue number
  "Closes #7200|720|1"     # word-boundary: 720 ≠ 7200
  "Closes #720 and Closes #721|721|0"  # multiple keywords
)
for c in "${cases[@]}"; do
  IFS='|' read -r line issue expected <<< "$c"
  printf '%s\n' "$line" > "$TMP"
  if has_closing_keyword "$TMP" "$issue"; then actual=0; else actual=1; fi
  check "body='$line' issue=$issue" "$expected" "$actual"
done

echo
echo "== Regression: the original grep -cF bug =="
# The original code: grep -cF '- [ ] **EC-' should now NOT silently return 0
# on multi-incomplete.md. We compare against the anchored regex.
OLD_COUNT=$(grep -cF '- [ ] **EC-' "$FIXTURES_DIR/multi-incomplete.md" || true)
NEW_COUNT=$(count_unchecked_ec "$FIXTURES_DIR/multi-incomplete.md")
if [ "$OLD_COUNT" != "$NEW_COUNT" ]; then
  echo "  ⚠ Diagnostic: original grep -cF returned $OLD_COUNT, anchored regex returned $NEW_COUNT"
  echo "    (this is the bug class D-037 fixes; verify the workflow patch uses the anchored form)"
fi
check "anchored regex matches all 12 EC items" 12 "$NEW_COUNT"

echo
printf '== Summary: %d passed, %d failed ==\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
