#!/usr/bin/env bash
# tick-ec.sh — Deterministically flip "- [ ] **EC-N**" to "- [x] **EC-N**"
# for a given set of EC ids, without the metacharacter hazards of an
# LLM-driven sed substitution.
#
# Background (issue #751): the EC validator's prompt previously instructed the
# LLM to "replace '- [ ] **EC-N**' with '- [x] **EC-N**'". On issue #704 the
# agent used a sed s/// substitution, and the EC line contained "&&" — sed's
# replacement '&' expands to the whole matched text, so the line was
# re-inserted into itself and corrupted. D-038 says "the LLM is scribe, bash is
# judge" — body ticking must be deterministic too, not LLM-driven.
#
# Usage:
#   tick-ec.sh <body-file> <EC-id> [EC-id ...]
#
#   <body-file>  Path to a file containing the issue body markdown.
#   <EC-id>      One or more ids like "EC-1" "EC-3" — only these unchecked
#                items are flipped to [x]. Already-checked lines are left alone.
#
# Output: the modified body to stdout. Non-EC lines and unmatched EC lines are
# emitted byte-for-byte unchanged. EC-1 never matches EC-10 (exact id compare).
#
# Why awk and not sed: awk's sub(regexp, repl, line) only touches the matched
# prefix "- [ ] "; the replacement string "- [x] " contains no "&", and the
# rest of the line (which may contain &&, |, /, $, backticks) is preserved as
# the awk field value, never interpreted as a replacement string.

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: tick-ec.sh <body-file> <EC-id> [EC-id ...]" >&2
  exit 2
fi

BODY_FILE="$1"
shift

if [ ! -f "$BODY_FILE" ]; then
  echo "tick-ec.sh: body file not found: $BODY_FILE" >&2
  exit 2
fi

# Build a space-delimited set of target ids: " EC-1  EC-3 "
IDS=" "
for id in "$@"; do
  IDS="${IDS}${id} "
done

awk -v ids="$IDS" '
{
  line = $0
  # Match an unchecked EC line:  - [ ] **EC-<n>**
  if (line ~ /^- \[ \] \*\*EC-[0-9]+\*\*/) {
    # Extract the exact EC id from the matched prefix.
    if (match(line, /EC-[0-9]+/)) {
      ecid = substr(line, RSTART, RLENGTH)
      # Exact whole-token membership test — " EC-1 " never matches " EC-10 ".
      if (index(ids, " " ecid " ") > 0) {
        # Flip only the leading checkbox; the rest of the line is untouched.
        sub(/^- \[ \]/, "- [x]", line)
      }
    }
  }
  print line
}
' "$BODY_FILE"
