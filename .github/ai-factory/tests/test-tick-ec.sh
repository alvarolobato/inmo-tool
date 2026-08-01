#!/usr/bin/env bash
# Tests tick-ec.sh — the deterministic EC checkbox flipper (issue #751).
# Verifies metacharacter safety (&&, |, /, $, backticks) and EC-1≠EC-10
# word-boundary disambiguation. The regression case mirrors the #704
# corruption where '&&' in an EC line broke a sed-based substitution.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TICK="$SCRIPT_DIR/../scripts/tick-ec.sh"
FIXTURE="$SCRIPT_DIR/../fixtures/tick-metachars.md"

PASS=0
FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ✓ %s\n' "$name"
    PASS=$((PASS + 1))
  else
    printf '  ✗ %s\n     expected: %s\n     actual:   %s\n' "$name" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

# Flip EC-1 and EC-2 only.
OUT=$("$TICK" "$FIXTURE" EC-1 EC-2)

echo "== checkbox state after ticking EC-1 EC-2 =="
check "EC-1 flipped to [x]"        "1" "$(printf '%s\n' "$OUT" | grep -c '^- \[x\] \*\*EC-1\*\*')"
check "EC-2 flipped to [x]"        "1" "$(printf '%s\n' "$OUT" | grep -c '^- \[x\] \*\*EC-2\*\*')"
check "EC-3 stays [x] (was checked)" "1" "$(printf '%s\n' "$OUT" | grep -c '^- \[x\] \*\*EC-3\*\*')"
check "EC-10 NOT flipped (still [ ])" "1" "$(printf '%s\n' "$OUT" | grep -c '^- \[ \] \*\*EC-10\*\*')"
check "EC-11 NOT flipped (still [ ])" "1" "$(printf '%s\n' "$OUT" | grep -c '^- \[ \] \*\*EC-11\*\*')"

echo "== content integrity (no corruption) =="
# The EC-1 line content after the checkbox must be byte-identical to the fixture's.
FIX_EC1_CONTENT=$(grep '\*\*EC-1\*\*' "$FIXTURE" | sed -E 's/^- \[[ x]\] //')
OUT_EC1_CONTENT=$(printf '%s\n' "$OUT" | grep '\*\*EC-1\*\*' | sed -E 's/^- \[[ x]\] //')
check "EC-1 content (with '&&') intact" "$FIX_EC1_CONTENT" "$OUT_EC1_CONTENT"

FIX_EC2_CONTENT=$(grep '\*\*EC-2\*\*' "$FIXTURE" | sed -E 's/^- \[[ x]\] //')
OUT_EC2_CONTENT=$(printf '%s\n' "$OUT" | grep '\*\*EC-2\*\*' | sed -E 's/^- \[[ x]\] //')
check "EC-2 content (|, /, \$, backticks) intact" "$FIX_EC2_CONTENT" "$OUT_EC2_CONTENT"

echo "== line count unchanged (no duplication) =="
check "same number of EC lines" \
  "$(grep -cE '^\- \[[ x]\] \*\*EC-' "$FIXTURE")" \
  "$(printf '%s\n' "$OUT" | grep -cE '^\- \[[ x]\] \*\*EC-')"

echo "== idempotency: re-ticking already-checked items is a no-op =="
OUT2=$("$TICK" "$FIXTURE" EC-3)
check "EC-3 re-tick leaves exactly one EC-3 line" \
  "1" "$(printf '%s\n' "$OUT2" | grep -c '\*\*EC-3\*\*')"

echo "== regression: whole body byte-stable except the two flips =="
EXPECTED=$(sed -E '
  s/^- \[ \] (\*\*EC-1\*\*)/- [x] \1/;
  s/^- \[ \] (\*\*EC-2\*\*)/- [x] \1/' "$FIXTURE")
check "body matches expected two-flip diff" "$EXPECTED" "$OUT"

echo
printf '== Summary: %d passed, %d failed ==\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
