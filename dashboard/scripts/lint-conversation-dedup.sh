#!/usr/bin/env bash
# Fails if ConversationViewer.tsx exists as a component file, or if any component
# file still contains the old per-component LLM-calling patterns that were
# consolidated into ConversationPane in the conversation-engine rearchitecture.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPONENTS="$ROOT/components"

FAIL=0

# AC-10a: ConversationViewer.tsx must not exist
if [ -f "$COMPONENTS/ConversationViewer.tsx" ]; then
  echo "FAIL: ConversationViewer.tsx still exists — delete it (Phase 3 task 4)" >&2
  FAIL=1
fi

# AC-10b: Old LLM-calling patterns must not appear in component files
OLD_PATTERNS="handleSend|loadPriorTurns|appendMessage"
MATCHES=$(grep -rEn --include="*.tsx" --include="*.ts" "$OLD_PATTERNS" "$COMPONENTS" 2>/dev/null \
    | grep -v "ConversationPane.tsx" \
    | grep -v "__tests__" || true)
if [ -n "$MATCHES" ]; then
  echo "FAIL: old conversation patterns found in components (handleSend|loadPriorTurns|appendMessage):" >&2
  echo "$MATCHES" >&2
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "OK: conversation deduplication lint passed"
fi

exit "$FAIL"
