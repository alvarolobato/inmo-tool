---
id: D-034
title: Single-track issues with optional phased PRs + fact-* label convention
date: 2026-05-16
---

# D-034: Single-track issues with optional phased PRs + fact-* label convention

*Decided: 2026-05-16*

**Context**: Three friction points were identified in the AI Factory as it handled issue #616:

1. **Issue noise**: the sub-issue model creates ~13 sub-issues for a single feature, flooding the open-issues list with `ai-task` entries the owner never needs to read directly. Issue #616 alone would have produced 13+ sub-issues.

2. **No planning checkpoint**: the moment `ai-work` is added, both the planning phase and all sub-issue implementations fire end-to-end in parallel. The owner sees the result only after sub-issues have been created and PRs have started. There is no "validate the plan before committing resources" mode.

3. **Label cognitive load**: the repo had 70+ labels. Internal state-machine markers (`ai-task`, `ai-planned`, `ai-cp-after-1`, `ai-phase-copilot`, etc.) were visually identical to owner-facing triggers (`ai-work`, `ai-blocked`, `ai-awaiting-owner`). The owner could not distinguish "labels I act on" from "labels the automation toggles." Several legacy labels (`dashboard-app`, `deployment`, `documentation`, `phase-2`) further cluttered the view.

The owner's stated preference: "steady, safe, efficient work" — fewer issues, fewer simultaneous PRs, the option to validate the plan before implementation starts.

**Decision**:

1. **Single-track issues by default.** Phases live as `## Phase N — <name>` headings inside the issue body. The planner edits the issue body in place (refines `## Context`, adds `## Plan`, structures `### Tasks` checklists per phase). No sub-issues are created unless `ai-decompose` is explicitly present.

2. **One PR per phase.** The implementer walks a phase's `### Tasks` checklist sequentially, commits per task, ticks checkboxes via `gh issue edit --body`, and opens exactly one PR. Phase N+1 starts only after Phase N's PR is merged and `main` is green.

3. **`ai-plan` label**: new owner-facing trigger. Adding `ai-plan` to an issue fires the planner only — it refines the body, sets `fact-planned`, and stops. No implementation. The owner reviews the refined body and adds `ai-work` when ready. This gives the "validate the plan" checkpoint.

4. **`ai-work` on unstructured body**: if `fact-planned` is absent and the body lacks `## Phase` headings, the implementer runs the planner inline first, then continues with implementation. This preserves the existing end-to-end behaviour for callers who don't need the checkpoint.

5. **Resumability via checkbox state**: if the implementer times out or fails mid-phase, re-adding `ai-work` resumes at the first unchecked task. The issue body is the durable progress log.

6. **`ai-decompose` escape hatch**: adds the `ai-decompose` label to opt in to the legacy parent → sub-issues model for genuinely huge work where parallel team execution matters. Sub-issues get `fact-task` (renamed from `ai-task`).

7. **`fact-*` label convention**: rename all internal state-machine labels from `ai-*` to `fact-*` and recolor them light grey (`#ededed`). Owner-facing labels keep their current names and colors. Rule: if a workflow toggles a label automatically and the owner never has to act on it, name it `fact-*` and colour it grey.

   Renamed labels (14 total):
   - `ai-task` → `fact-task`
   - `ai-planned` → `fact-planned`
   - `ai-in-progress` → `fact-in-progress`
   - `ai-ready-for-review` → `fact-ready-for-review`
   - `ai-phase-copilot` → `fact-phase-copilot`
   - `ai-phase-opus` → `fact-phase-opus`
   - `ai-cp-after-1` → `fact-cp-after-1`
   - `ai-o-after-1` → `fact-o-after-1`
   - `ai-auto-retry` → `fact-auto-retry`
   - `ai-ci-failing` → `fact-ci-failing`
   - `ai-needs-rewrite` → `fact-needs-rewrite`
   - `ai-parent-incomplete` → `fact-parent-incomplete`
   - `ai-parent-verified` → `fact-parent-verified`
   - `factory-manager-tracking` → `fact-manager-tracking`

**Alternatives rejected**:

- **Keep current model** (parent → sub-issues by default): causes the issue noise and checkpoint problems described above. Rejected.
- **Always split into `ai-plan` + `ai-work` as two separate labels with two sequential jobs**: adds complexity without eliminating sub-issues. Rejected in favour of `ai-plan` as an optional pre-step.
- **Remove sub-issues entirely**: some genuinely large features benefit from parallel implementation across multiple people. The `ai-decompose` escape hatch preserves this capability. Rejected in favour of opt-in.
- **Keep `ai-*` everywhere and rely on colour alone to distinguish owner-facing vs internal**: colour is unreliable (colourblindness, label list view strips colour context). Renaming is unambiguous. Rejected.

**Rationale**:

The phased-in-body model matches the format the owner already uses for large issues (issue #616 itself used this format). It reduces open issue count from ~13 per feature to 1. The `ai-plan` checkpoint lets the owner see the approach before implementation starts. The `fact-*` naming makes the owner/automation boundary explicit at a glance.

The `ai-decompose` escape hatch means no existing capability is removed — it's opt-in for the rare genuinely huge case. Existing in-flight issues with sub-issues finish under the old model without disruption.

The `fact-*` label rename requires a two-step migration: (1) update workflow YAML to reference `fact-*` names, (2) run `scripts/migrate-labels.sh` to rename the labels in GitHub. These steps must happen in order — renaming labels before the YAML is updated breaks live workflows.

**See**: #631 (parent issue), #616 (the issue that motivated this), #654 (AGENTS.md trim), #658 (.claude-contexts/), [D-021](D-021-two-review-rounds.md), [D-029](D-029-no-worker-workflows.md), [D-031](D-031-copilot-opus-sequencing.md), [D-033](D-033-opus-review-marker.md).

## Migration status

Phase 2 YAML committed 2026-05-17. Run `bash scripts/migrate-labels.sh` to complete the label rename.
