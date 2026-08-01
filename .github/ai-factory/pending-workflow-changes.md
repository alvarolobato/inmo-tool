# Pending Workflow Changes

This file tracks workflow YAML changes that have been designed by the AI Worker
but cannot be committed directly (D-029: the worker must not write to
`.github/workflows/`). Each entry includes the complete YAML and instructions
for the human owner to commit it.

---

## 1. File-overlap dispatch guard — `ai-worker.yml` implement job

**Issue**: #586  
**Parent**: #570 (prevent contract-regression cascades)  
**Status**: ⚠️ Pending human commit

### Where to add

In `.github/workflows/ai-worker.yml`, in the `implement` job:

1. Add the guard step **immediately after** the `Update labels — implementation started`
   step (after line ~422, before the `Implement sub-task` step that uses
   `anthropics/claude-code-action@v1`).

2. Add an `if:` condition to the **`Implement sub-task`** step so it skips when
   the guard deferred:

   ```yaml
         - name: Implement sub-task
           id: implement
           if: steps.guard.outputs.deferred != 'true'
   ```

   Without this `if:` condition the guard detects and labels the overlap but
   cannot stop the Claude Code action from running.

### What it does

Before the worker starts implementing a sub-task, this step checks whether any
other open sub-issue (carrying both `ai-in-progress` and `ai-task` labels)
touches the same files as the current sub-issue. If an overlap is found, the
worker defers instead of proceeding — it posts a comment, adds `ai-blocked` +
`ai-auto-retry`, and exits 0 so the watchdog can retry once the blocking issue
clears.

This prevents the conversations-cascade pattern (issues #536–#540) where
5 workers ran concurrently on issues that all shared `dashboard/lib/conversations.ts`.

**Failure mode**: fail-open. If the guard itself errors (API timeout, parse
failure, etc.), it logs a warning and allows the implement step to continue.

### YAML step to add

```yaml
      - name: File-overlap dispatch guard
        id: guard
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          # Not using set -e — guard is fail-open; errors log and proceed.
          set -uo pipefail

          DEFERRED=false

          # Extract file paths from an issue body.
          # Handles two formats:
          #   1. "## Files to change" section with bullet-listed backtick-quoted paths
          #   2. Inline "**Files**: `path`" lines (AGENTS.md task-item format)
          # Reads body text from stdin; outputs one path per line.
          extract_files() {
            awk '
              /^## Files to change/{f=1; next}
              f && /^## /{f=0}
              f && /^[-*]/{
                line = $0
                gsub(/^[-*][ \t]+/, "", line)
                if (substr(line,1,1) == "`") {
                  sub(/`/, "", line); sub(/`.*/, "", line)
                } else {
                  sub(/[ \t].*/, "", line)
                }
                if (length(line) > 0) print line
              }
              /\*\*Files\*\*:/{
                n = split($0, parts, /`/)
                for (i=2; i<=n; i+=2) {
                  if (length(parts[i]) > 0) print parts[i]
                }
              }
            '
          }

          run_guard() {
            local current_body="" current_files="" parent_num="" search_query="" in_progress="" count=0

            current_body=$(gh issue view "$ISSUE_NUMBER" --json body --jq '.body') || return 1
            current_files=$(printf '%s' "$current_body" | extract_files)

            if [ -z "$current_files" ]; then
              echo "Guard: no '## Files to change' section or '**Files**:' entries in #$ISSUE_NUMBER — skipping."
              return 0
            fi

            echo "Guard: files in this issue:"
            echo "$current_files"

            # Narrow the search to sibling sub-issues sharing the same parent (e.g. "Closes #N").
            # Falls back to repo-wide scope when no parent reference is found.
            parent_num=$(printf '%s' "$current_body" | sed -n 's/.*[Cc]loses #\([0-9]*\).*/\1/p' | head -1) || true
            search_query="label:ai-in-progress label:ai-task"
            if [ -n "$parent_num" ]; then
              search_query="$search_query Closes #${parent_num} in:body"
              echo "Guard: restricting search to siblings of parent #${parent_num}"
            else
              echo "Guard: no parent reference found — searching repo-wide"
            fi

            in_progress=$(gh issue list \
              --repo "${{ github.repository }}" \
              --state open \
              --search "$search_query" \
              --limit 50 \
              --json number,body \
              | jq --argjson n "$ISSUE_NUMBER" '[.[] | select(.number != $n)]') || return 1

            count=$(printf '%s' "$in_progress" | jq 'length')
            if [ "$count" -eq 0 ]; then
              echo "Guard: no other ai-in-progress ai-task issues — passes."
              return 0
            fi

            echo "Guard: checking $count in-progress issue(s) for file overlap..."

            local blocking="" overlap=""
            while IFS= read -r row; do
              local num="" body_sib="" sib_files="" inter=""
              num=$(printf '%s' "$row" | jq -r '.number')
              body_sib=$(printf '%s' "$row" | jq -r '.body')
              sib_files=$(printf '%s' "$body_sib" | extract_files)
              [ -z "$sib_files" ] && continue

              inter=$(comm -12 \
                <(printf '%s\n' "$current_files" | sort -u) \
                <(printf '%s\n' "$sib_files" | sort -u))

              if [ -n "$inter" ]; then
                blocking="$num"
                overlap="$inter"
                break
              fi
            done < <(printf '%s' "$in_progress" | jq -c '.[]')

            if [ -n "$blocking" ]; then
              file_list=$(printf '%s\n' "$overlap" \
                | awk '{if(NR>1) printf ", "; printf "%s",$0} END{print ""}')
              echo "Guard: overlap with #$blocking — $file_list"

              gh issue comment "$ISSUE_NUMBER" \
                --body "⏸️ AI Worker — dispatch deferred: overlapping files with in-progress issue #${blocking}: ${file_list}. Will retry when #${blocking} completes." || true
              gh issue edit "$ISSUE_NUMBER" \
                --remove-label "ai-in-progress" \
                --add-label "ai-blocked" \
                --add-label "ai-auto-retry" || true

              DEFERRED=true
            else
              echo "Guard: no overlap — passes."
            fi
          }

          # Run guard fail-open: if it errors for any reason, warn and proceed.
          run_guard || echo "::warning::File-overlap dispatch guard errored — proceeding (fail-open)."

          # Emit step output so the Implement sub-task step can skip when deferred.
          if [ "$DEFERRED" = "true" ]; then
            echo "deferred=true" >> "$GITHUB_OUTPUT"
            echo "Guard: dispatch deferred — Implement sub-task step will be skipped."
          fi
```

### Verification checklist

Before committing, verify:

- [ ] The guard step is placed after `Update labels — implementation started` and before `Implement sub-task`
- [ ] The guard step has `id: guard` so its outputs are referenceable
- [ ] The `Implement sub-task` step has `if: steps.guard.outputs.deferred != 'true'` (critical — without this the guard cannot stop the implementation)
- [ ] The indentation matches the surrounding steps (6 spaces for `- name:`)
- [ ] `${{ github.repository }}` and `$ISSUE_NUMBER` are used (same as surrounding steps)
- [ ] YAML is syntactically valid: `yamllint .github/workflows/ai-worker.yml`

### Logic paths

| Scenario | Outcome |
|----------|---------|
| Issue has no `## Files to change` section or `**Files**:` entries | Guard skipped, implementation proceeds |
| No other `ai-in-progress ai-task` issues | Guard passes, implementation proceeds |
| Other in-progress issues found, no file overlap | Guard passes, implementation proceeds |
| Overlap found with issue #N | Comment posted, `ai-blocked`+`ai-auto-retry` added, `deferred=true` output set, implement step skipped |
| Guard itself errors (API timeout, parse error) | Warning logged, implementation proceeds (fail-open) |

### Known limitations

**TOCTOU race (mutual deferral)**: The `ai-in-progress` label is added to the current
issue *before* the guard step runs (by the `Update labels — implementation started` step).
If a second worker dispatches for a different sub-issue in the narrow window between that
label addition and the guard query (~5 s), both workers may see each other as
`ai-in-progress` and mutually defer. The watchdog's `ai-auto-retry` loop will resolve
this automatically on the next retry cycle; it is not a permanent deadlock.

**Parent-scope fallback**: When no `Closes #N` reference is found in the issue body,
the guard falls back to a repo-wide search. This is broader than ideal but safe — the
file-overlap check is still the deciding factor.

**File path extraction — two formats supported**: The `extract_files()` function handles
both (a) a `## Files to change` section with bullet-listed backtick-quoted paths, and
(b) inline `**Files**: \`path\`` lines from the AGENTS.md task-item issue template.
Both formats yield file paths; the awk split-on-backtick approach for inline lines
extracts any backtick-quoted token on a `**Files**:` line regardless of surrounding
punctuation.
