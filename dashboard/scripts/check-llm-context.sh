#!/usr/bin/env bash
# check-llm-context.sh
#
# CI guard: enforces that no file outside dashboard/lib/llm-context/ imports
# llmComplete or runAgenticChat directly from their source modules.
# The ONLY permitted importers are files inside dashboard/lib/llm-context/.
#
# Usage:  bash dashboard/scripts/check-llm-context.sh
#         npm run lint:llm-context      (from the dashboard/ directory)
#
# Exits 0 when no violations are found, 1 when violations are detected.

set -euo pipefail

DASHBOARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FAILED=0

# Check: no file outside llm-context/ imports llmComplete from llm-client.
#
# File-level check: first collect files that have a `from "@/lib/llm-client"` (or
# relative equivalent) import statement, then test each of those files for the
# llmComplete symbol.  Matching on `from.*"<path>"` (not just `"<path>"`) avoids
# false positives from inline TypeScript type references like import("./module").
while IFS= read -r file; do
  if grep -q 'llmComplete' "$file"; then
    echo "❌ LLM context boundary violation — file imports llmComplete outside llm-context/:"
    grep -n 'llmComplete' "$file" | sed "s|^|  $file:|"
    echo ""
    FAILED=1
  fi
done < <(grep -rl \
  --include='*.ts' --include='*.tsx' \
  'from.*"@/lib/llm-client"\|from.*"./llm-client"\|from.*"../llm-client"\|from.*"../../llm-client"' \
  "$DASHBOARD_DIR" \
  | grep -v 'dashboard/lib/llm-context/' \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  || true)

# Check: no file outside llm-context/ imports runAgenticChat from runner.
#
# Same file-level approach: find files with the import statement, then check
# for the symbol.  `from.*"./runner"` avoids matching inline TypeScript
# `import("./runner").SomeType` self-references inside the runner source file.
while IFS= read -r file; do
  if grep -q 'runAgenticChat' "$file"; then
    echo "❌ LLM context boundary violation — file imports runAgenticChat outside llm-context/:"
    grep -n 'runAgenticChat' "$file" | sed "s|^|  $file:|"
    echo ""
    FAILED=1
  fi
done < <(grep -rl \
  --include='*.ts' --include='*.tsx' \
  'from.*"@/lib/llm-tools/runner"\|from.*"./runner"\|from.*"../runner"\|from.*"../../llm-tools/runner"' \
  "$DASHBOARD_DIR" \
  | grep -v 'dashboard/lib/llm-context/' \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  || true)

if [ "$FAILED" -eq 1 ]; then
  echo "All LLM calls must go through dashboard/lib/llm-context/assemble.ts"
  echo "  - Replace direct llmComplete() calls with assembleRequest() from '@/lib/llm-context'"
  echo "  - Replace direct runAgenticChat() calls with assembleRequest() from '@/lib/llm-context'"
  exit 1
fi

echo "✅ llm-context boundary check passed"
