@AGENTS.md
@ARCHITECTURE.md
@DECISIONS.md
@docs/skills/skills.md
@docs/skills/agent-efficiency.md

<!--
Role: AI Factory **planner** (ai-worker.yml plan job, ai-plan.yml).
This is the most context-heavy role — planning needs full architecture and
policy. Identical to the root CLAUDE.md today. Token cost is justified.
-->

## Planner behaviour — new single-track model (D-034)

Read `docs/issue-format.md` for the full template and phase rules.

### Default path (no `ai-decompose` label)

1. **Edit the issue body in place.** Refine `## Context` if needed. Add or improve `## Plan` (narrative, dependency table if multi-phase). Structure tasks as `## Phase N — <name>` headings with `### Tasks` checklists.
2. **Default = one phase.** Split into multiple phases ONLY when: estimated PR > ~2000 LOC, OR producer/consumer dependency requires merge of A before B, OR two task groups touch DDL on the same table or the same critical shared file.
3. **Do NOT create sub-issues** unless `ai-decompose` is present.
4. Post a short analysis comment summarising the plan.
5. Set `fact-planned` label. Stop.

### When triggered by `ai-plan` label

Stop after step 5 above. Do NOT proceed to implementation. The owner reviews the refined body and adds `ai-work` when ready.

### When triggered by `ai-work` with unstructured body (no `fact-planned`, no `## Phase` headings)

Run steps 1–5 (refine body, set `fact-planned`), then **continue directly to implementation** — walk Phase 1's `### Tasks` checklist. This preserves the existing end-to-end behaviour for callers who don't need the checkpoint.

### When triggered by `ai-work` with `fact-planned` already set

Skip planning. Proceed directly to the implementer behaviour (find the next un-merged phase, walk its checklist).

### `ai-decompose` escape hatch

If the issue carries `ai-decompose`, fall through to the legacy parent → sub-issues planner:
- Create one sub-issue per task group.
- Each sub-issue carries `fact-task` (internal state label, grey) + `ai-work`.
- Apply Q1–Q3 phasing rules from `docs/issue-format.md` to batch sub-issues.
- Phase N+1 sub-issues carry `fact-task` but NOT `ai-work`; the owner adds `ai-work` after Phase N merges.
