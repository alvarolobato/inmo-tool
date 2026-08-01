@AGENTS.md
@DECISIONS.md
@docs/skills/skills.md
@docs/skills/agent-efficiency.md

<!--
Role: AI Factory **implementer** (ai-worker.yml implement job, ai-ci-remediation.yml).
Planning has already happened upstream (parent issue + planner comment). The
implementer reads the sub-task and the parent's plan, then writes code. It
does not need the full ARCHITECTURE.md as context — when it needs structural
detail it reads the actual code.

Architecture diagrams remain available via the Read tool: ARCHITECTURE.md and
docs/architecture/*.md.
-->

## Implementer behaviour — new single-track model (D-034)

Read `docs/issue-format.md` for the full template and phase rules.

### Finding the active phase

1. Read the issue body. Identify all `## Phase N — <name>` headings.
2. For each phase, check whether its branch has a merged PR:
   ```bash
   gh pr list --search "head:<branch-name>" --state merged --json number,mergedAt
   ```
3. The **active phase** is the lowest-numbered phase whose PR has NOT yet been merged.
4. If all phases are merged → the issue is complete; post a summary comment and exit.

### Walking the phase checklist sequentially

1. Find the first unchecked task (`- [ ]`) in the active phase's `### Tasks` section.
2. Implement the task.
3. Tick the checkbox in the issue body immediately after completing the task:
   ```bash
   # Read current body, replace the first unchecked task with a checked one, write back
   BODY=$(gh issue view ISSUE_NUMBER --json body --jq .body)
   UPDATED=$(echo "$BODY" | sed '0,/- \[ \]/s//- [x]/')
   gh issue edit ISSUE_NUMBER --body "$UPDATED"
   ```
4. Repeat for each subsequent unchecked task in the phase.
5. After all tasks in the phase are ticked, commit all changes with a descriptive message.
6. Push and open **one PR** for the phase.
   - Title: `<feature> (Phase N: <phase name>)` (for single-phase issues, title may omit the phase suffix)
   - Body: `## Summary`, `## Changes`, `## Test Results`, `Closes #ISSUE_NUMBER`

### Resumability

If the implementer times out or fails mid-phase, leave all checkboxes in their current state. Re-adding `ai-work` will re-invoke the implementer, which will resume at the first remaining unchecked task.

Do NOT re-implement tasks that are already checked.

### PR-per-phase rule

Open exactly **one PR per phase**. Do not open multiple PRs for the same phase. Do not accumulate multiple phases into one PR.

### Legacy sub-issue path (when running on a `fact-task` sub-issue)

If the issue carries `fact-task`, it is a legacy sub-issue created by the `ai-decompose` planner path. In this case:
- Read the sub-issue body + the parent issue body + ALL parent comments (the planner's analysis lives there).
- Implement the sub-issue scope only — do not implement other sub-issues.
- Open one PR for this sub-issue.
- PR body includes `Closes #SUB_ISSUE_NUMBER`.
