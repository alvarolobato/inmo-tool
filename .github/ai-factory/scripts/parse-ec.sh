#!/usr/bin/env bash
# parse-ec.sh — Extract EC items from a GitHub issue body and emit JSON.
#
# Usage: parse-ec.sh <issue-body-file>
# Output: JSON array: [{ "id": "EC-N", "text": "...", "verified_by": "...", "human_only": true|false }, ...]
#
# EC item format (from docs/issue-format.md):
#   - [ ] **EC-N**: <description> — *Verified by*: <cue>
#   - [ ] **EC-N**: <description> — *Human-only* — *Evidence*: <info>
#   - [x] **EC-N**: <description> — already checked items are included with their state
#
# Parsing rules:
#   - human_only=true  if the line contains "*Human-only*"
#   - human_only=true  if no "*Verified by*:" clause is present (treat as human-only with warning)
#   - verified_by=""   for human-only items
#   - The parser is line-oriented; multi-line EC items are not supported.

set -uo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <issue-body-file>" >&2
  exit 1
fi

BODY_FILE="$1"
if [ ! -f "$BODY_FILE" ]; then
  echo "File not found: $BODY_FILE" >&2
  exit 1
fi

# Output JSON using awk. Each matching line is an EC item.
awk '
BEGIN {
  count = 0
  printf "["
}

# Match both checked and unchecked EC items.
/^- \[[ x]\] \*\*EC-[0-9]/ {
  line = $0
  count++

  # Extract the EC id: **EC-N**
  ec_id = ""
  if (match(line, /\*\*EC-[0-9]+\*\*/)) {
    ec_id = substr(line, RSTART, RLENGTH)
    gsub(/\*\*/, "", ec_id)
  } else if (match(line, /\*\*EC-[0-9]+/)) {
    ec_id = substr(line, RSTART, RLENGTH)
    gsub(/\*\*/, "", ec_id)
  }

  # Determine checked state.
  checked = "false"
  if (match(line, /^- \[x\]/)) {
    checked = "true"
  }

  # Determine human_only.
  human_only = "false"
  if (index(line, "*Human-only*") > 0) {
    human_only = "true"
  }

  # Extract verified_by clause (text after "*Verified by*:").
  verified_by = ""
  if (match(line, /\*Verified by\*: /)) {
    verified_by = substr(line, RSTART + RLENGTH)
    # Strip trailing " — *Human-only*..." if present (edge case).
    sub(/ — \*Human-only\*.*$/, "", verified_by)
    # Strip trailing whitespace.
    sub(/[[:space:]]+$/, "", verified_by)
  } else if (human_only == "false") {
    # No Verified by and not Human-only → treat as human-only with warning.
    human_only = "true"
    verified_by = "__no_annotation__"
  }

  # Extract the full description text (between "**EC-N**: " and the " — *" marker).
  text = line
  # Remove the checkbox prefix.
  sub(/^- \[[ x]\] /, "", text)
  # Remove **EC-N**: prefix.
  sub(/\*\*EC-[0-9]+\*\*: /, "", text)
  # Take only up to the first " — *" separator.
  if (match(text, / — \*/)) {
    text = substr(text, 1, RSTART - 1)
  }
  sub(/[[:space:]]+$/, "", text)

  # JSON-escape helper: escape backslash, double-quote, newline.
  gsub(/\\/, "\\\\", text)
  gsub(/"/, "\\\"", text)
  gsub(/\\/, "\\\\", verified_by)
  gsub(/"/, "\\\"", verified_by)

  if (count > 1) printf ","
  printf "\n  {\"id\":\"%s\",\"text\":\"%s\",\"verified_by\":\"%s\",\"human_only\":%s,\"checked\":%s}",
    ec_id, text, verified_by, human_only, checked
}

END {
  printf "\n]\n"
}
' "$BODY_FILE"
