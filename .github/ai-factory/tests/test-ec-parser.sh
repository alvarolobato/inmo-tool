#!/usr/bin/env bash
# test-ec-parser.sh — Unit tests for parse-ec.sh
#
# Covers:
#   - Items with explicit *Verified by*: clause (machine-verifiable)
#   - Items with *Human-only* annotation
#   - Items with no annotation (treated as human-only with warning)
#   - Items with multiple verification cues (test file + CI job)
#   - Already-checked items (checked=true)
#   - Edge cases: mixed issue with both human-only and verified items
#   - Fixture-level counts matching #720 (12 items) and #723 (5 items)
#   - "close vs awaiting decision" logic (EC-2, EC-3 in issue #735)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$(cd "$SCRIPT_DIR/../fixtures" && pwd)"
PARSE_EC="$(cd "$SCRIPT_DIR/../scripts" && pwd)/parse-ec.sh"

PASS=0
FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ✓ %-70s expected=%s\n' "$name" "$expected"
    PASS=$((PASS + 1))
  else
    printf '  ✗ %-70s expected=%s actual=%s\n' "$name" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

# Parse a fixture and run jq against the resulting JSON.
parse_jq() {
  local fixture="$1" jq_expr="$2"
  bash "$PARSE_EC" "$fixture" | jq -r "$jq_expr" 2>/dev/null
}

# Count EC items in a fixture.
count_items() { parse_jq "$1" 'length'; }

# Count human-only items.
count_human_only() { parse_jq "$1" '[.[] | select(.human_only == true)] | length'; }

# Count machine-verifiable (non-human-only) items.
count_machine() { parse_jq "$1" '[.[] | select(.human_only == false)] | length'; }

# Count unchecked items.
count_unchecked() { parse_jq "$1" '[.[] | select(.checked == false)] | length'; }

# Count checked items.
count_checked() { parse_jq "$1" '[.[] | select(.checked == true)] | length'; }

# Get a field for a specific EC id.
get_field() { parse_jq "$1" ".[] | select(.id == \"$2\") | .$3"; }

# Decide whether to close the issue or label fact-awaiting-human-validation.
# Returns "close" if all items are checked OR (all machine items have human_only=false
# and none remain unchecked). Returns "await" if any human-only item is unchecked.
# Replicates the logic in verify-ec.sh: close only when zero items remain unchecked
# AND zero human-only items remain unticked.
decide_action() {
  local fixture="$1"
  local unchecked_human unchecked_total
  unchecked_human=$(parse_jq "$fixture" '[.[] | select(.human_only == true and .checked == false)] | length')
  unchecked_total=$(parse_jq "$fixture" '[.[] | select(.checked == false)] | length')
  if [ "$unchecked_total" -eq 0 ]; then
    echo "close"
  elif [ "$unchecked_human" -gt 0 ]; then
    echo "await"
  else
    # Only machine-verifiable items remain unchecked — await for safety.
    echo "await"
  fi
}

echo "== parse-ec.sh: fixture item counts =="

# single-with-ec.md has 3 EC items (2 machine, 1 human-only)
check "single-with-ec.md total items = 3"    "3" "$(count_items "$FIXTURES_DIR/single-with-ec.md")"
check "single-with-ec.md human_only = 1"     "1" "$(count_human_only "$FIXTURES_DIR/single-with-ec.md")"
check "single-with-ec.md machine = 2"        "2" "$(count_machine "$FIXTURES_DIR/single-with-ec.md")"

# ec-720.md has 12 EC items (10 machine, 2 human-only)
check "ec-720.md total items = 12"           "12" "$(count_items "$FIXTURES_DIR/ec-720.md")"
check "ec-720.md human_only = 2"             "2"  "$(count_human_only "$FIXTURES_DIR/ec-720.md")"
check "ec-720.md machine = 10"               "10" "$(count_machine "$FIXTURES_DIR/ec-720.md")"

# ec-723.md has 5 EC items (3 machine, 2 human-only)
check "ec-723.md total items = 5"            "5" "$(count_items "$FIXTURES_DIR/ec-723.md")"
check "ec-723.md human_only = 2"             "2" "$(count_human_only "$FIXTURES_DIR/ec-723.md")"
check "ec-723.md machine = 3"               "3" "$(count_machine "$FIXTURES_DIR/ec-723.md")"

# single-no-ec.md has no EC items
check "single-no-ec.md total items = 0"     "0" "$(count_items "$FIXTURES_DIR/single-no-ec.md")"

# multi-complete.md has 0 unchecked items
check "multi-complete.md unchecked = 0"     "0" "$(count_unchecked "$FIXTURES_DIR/multi-complete.md")"

echo
echo "== parse-ec.sh: field extraction =="

# EC-1 in ec-720.md — machine-verifiable
check "ec-720 EC-1 human_only=false" \
  "false" "$(get_field "$FIXTURES_DIR/ec-720.md" "EC-1" "human_only")"
check "ec-720 EC-1 verified_by contains check-llm-context.sh" \
  "1" "$(get_field "$FIXTURES_DIR/ec-720.md" "EC-1" "verified_by" | grep -c "check-llm-context.sh" || true)"

# EC-10 in ec-720.md — human-only
check "ec-720 EC-10 human_only=true" \
  "true" "$(get_field "$FIXTURES_DIR/ec-720.md" "EC-10" "human_only")"
check "ec-720 EC-10 verified_by is empty" \
  "" "$(get_field "$FIXTURES_DIR/ec-720.md" "EC-10" "verified_by")"

# EC-4 in ec-723.md — human-only
check "ec-723 EC-4 human_only=true" \
  "true" "$(get_field "$FIXTURES_DIR/ec-723.md" "EC-4" "human_only")"

# EC-1 in ec-723.md — machine-verifiable with multiple cues
check "ec-723 EC-1 human_only=false" \
  "false" "$(get_field "$FIXTURES_DIR/ec-723.md" "EC-1" "human_only")"

echo
echo "== parse-ec.sh: checked state =="

# multi-complete.md has all items checked
check "multi-complete.md all checked" \
  "3" "$(count_checked "$FIXTURES_DIR/multi-complete.md")"
check "multi-complete.md zero unchecked" \
  "0" "$(count_unchecked "$FIXTURES_DIR/multi-complete.md")"

# ec-720.md has all items unchecked
check "ec-720.md all unchecked" \
  "12" "$(count_unchecked "$FIXTURES_DIR/ec-720.md")"

echo
echo "== close vs awaiting decision (EC-2, EC-3 from issue #735) =="

# multi-complete.md: zero unchecked → should close
check "multi-complete.md → close"       "close" "$(decide_action "$FIXTURES_DIR/multi-complete.md")"

# ec-720.md: 12 unchecked (2 human-only) → should await
check "ec-720.md → await"              "await" "$(decide_action "$FIXTURES_DIR/ec-720.md")"

# ec-723.md: 5 unchecked (2 human-only) → should await (EC-3 from #735)
check "ec-723.md → await (human-only items exist)" \
  "await" "$(decide_action "$FIXTURES_DIR/ec-723.md")"

# single-no-ec.md: 0 items total → close (nothing to verify)
check "single-no-ec.md → close (no EC items)" "close" "$(decide_action "$FIXTURES_DIR/single-no-ec.md")"

# multi-incomplete.md: 12 unchecked → await
check "multi-incomplete.md → await"    "await" "$(decide_action "$FIXTURES_DIR/multi-incomplete.md")"

echo
echo "== parse-ec.sh: inline fixture for edge cases =="

TMP_FIXTURE=$(mktemp /tmp/ec-fixture-XXXXXX.md)
trap 'rm -f "$TMP_FIXTURE"' EXIT

# Edge case 1: item with no annotation (should be treated as human-only).
cat > "$TMP_FIXTURE" << 'EOF'
## Exit criteria / Validation

- [ ] **EC-1**: Something that needs verification.
- [ ] **EC-2**: Something else — *Verified by*: some-test.ts → "passes".
EOF
check "no-annotation EC-1 → human_only=true" \
  "true" "$(get_field "$TMP_FIXTURE" "EC-1" "human_only")"
check "no-annotation EC-1 verified_by=__no_annotation__" \
  "__no_annotation__" "$(get_field "$TMP_FIXTURE" "EC-1" "verified_by")"
check "no-annotation EC-2 → human_only=false" \
  "false" "$(get_field "$TMP_FIXTURE" "EC-2" "human_only")"

# Edge case 2: already-checked human-only item.
cat > "$TMP_FIXTURE" << 'EOF'
## Exit criteria / Validation

- [x] **EC-1**: Manual smoke test passed — *Human-only* — *Evidence*: screenshot.
- [ ] **EC-2**: Unit tests green — *Verified by*: foo.test.ts → "passes".
EOF
check "checked human-only EC-1 checked=true" \
  "true" "$(get_field "$TMP_FIXTURE" "EC-1" "checked")"
check "checked human-only EC-1 human_only=true" \
  "true" "$(get_field "$TMP_FIXTURE" "EC-1" "human_only")"

# Edge case 3: issue where all machine items checked, human-only still open → await.
cat > "$TMP_FIXTURE" << 'EOF'
## Exit criteria / Validation

- [x] **EC-1**: Tests green — *Verified by*: foo.test.ts → "passes".
- [ ] **EC-2**: Manual smoke test — *Human-only* — *Evidence*: screenshot pending.
EOF
check "mixed checked+human-only → await" "await" "$(decide_action "$TMP_FIXTURE")"

echo
printf '== Summary: %d passed, %d failed ==\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
