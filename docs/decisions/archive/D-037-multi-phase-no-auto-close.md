---
id: D-037
title: Multi-phase issues never auto-close from a non-final phase
date: 2026-05-23
---

# D-037: Multi-phase issues never auto-close from a non-final phase

*Decided: 2026-05-23*

**Context**: Issue #720 was a 4-phase issue with 12 Exit Criteria items. Phase 1's
PR (#730) used `Closes #720` in the body. On merge, GitHub auto-closed #720 —
Phases 2–4 unstarted, zero EC items verified. The `ai-post-merge-verify.yml`
safety net fired but its EC-detection used a fixed-string grep
(`grep -cF '- [ ] **EC-'`) that silently returned 0 against the actual issue
body, so the reopen path was not taken and the owner had to reopen manually.
Two layers failed at once: the worker did not follow the explicit phase-aware
prompt in `ai-worker.yml` (lines 373–395), and the post-merge guard had a
silent regex bug.

**Decision**:

A PR for Phase N < TOTAL_PHASES — or for the final phase when any `**EC-`
item is unchecked — MUST use `Part of #<issue> (Phase N of TOTAL_PHASES)`
in the body. It must NEVER use `Closes`, `Fixes`, or `Resolves` keywords.

This rule is enforced by three layers (defense in depth):

1. **Worker self-check** — `ai-worker.yml` has a pre-`gh pr create` shell
   guard that re-parses the issue body to compute `TOTAL_PHASES` + `PHASE_N`
   and aborts the worker run if the PR body it is about to use contains a
   forbidden closing keyword. Catches authoring mistakes inside the worker.

2. **Pre-merge CI gate** — `ai-multi-phase-guard.yml` runs on
   `pull_request: [opened, edited, synchronize, reopened]` and fails the
   build when a closing keyword references a multi-phase issue's non-final
   phase, or a final-phase PR where the parent issue still has unverified
   EC items. Required check; blocks merge. Catches PRs whose body was edited
   after creation or where the worker self-check was bypassed.

3. **Post-merge reopen** — `ai-post-merge-verify.yml` uses an anchored
   regex (`grep -cE '^- \[ \] \*\*EC-[0-9]'`, not fixed-string) to detect
   unverified EC items. It reopens the issue with `fact-parent-incomplete`
   when EC items remain unchecked, OR when the issue still has multiple
   `## Phase M` headings with non-trivial unchecked tasks beyond the merged
   phase. Last-resort safety net.

**Alternatives rejected**:

- **"Trust the worker prompt alone"** — that's what we had; the worker on PR
  #730 ignored the text guidance. Text without an enforced gate is
  insufficient.
- **"Disable GitHub closing keywords project-wide"** (a repo setting exists)
  — would break the happy path for single-phase issues, which are the
  majority. Closing keywords are a useful default; the fix targets only the
  multi-phase exception.
- **"Only humans commit PR bodies for multi-phase issues"** — defeats the
  factory model and adds latency to every phase.

**Rationale**: Closing a parent issue prematurely (a) loses the EC
verification contract, (b) confuses the factory state machine
(`ai-awaiting-owner` gets applied to a closed issue), (c) makes Phase 2/3/4
implementation harder because the worker has to be re-pointed at a closed
issue. Defense in depth is cheap: each layer is ~50 lines of YAML/bash;
together they eliminate the failure mode. The post-merge regex was buggy in
isolation but easy to harden once the failure was observed; the CI gate
makes future regex bugs non-fatal because the bad PR would never have merged
in the first place.

**Operational note**: the parsing logic currently lives in bash + grep, which
proved fragile (the original `grep -cF` bug was silent for an unknown
duration). A future refactor could port it to a small typed script under
`.github/ai-factory/scripts/` with unit tests. Out of scope for this
decision — the three layers already make a single layer's bugs survivable.

**See**:

- Issue #720 — the failure case (4-phase issue auto-closed by Phase 1's PR).
- PR #730 — the offending PR body (`Closes #720` in a Phase-1-of-4 PR).
- Issue #733 — the fix tracker.
- `.github/workflows/ai-worker.yml` — text guidance at lines 373–395
  (pre-fix) that the worker ignored; now backed by the self-check.
- `.github/workflows/ai-post-merge-verify.yml` — the misfiring post-merge
  guard before the regex fix.
- `.github/workflows/ai-multi-phase-guard.yml` — new pre-merge CI gate.
- [D-021](D-021-two-review-rounds.md) — review-policy interaction (the final
  phase's PR can only use `Closes #N` after both rounds and all EC items
  verified).
- [D-029](D-029-no-worker-workflows.md) — why this decision's workflow YAML
  was committed by a human, not by the factory.
- [D-034](D-034-single-track-issues.md) — single-track multi-phase issue
  model that made this failure mode common.
- `docs/issue-format.md` § PR body: closing keywords — operator-facing
  reference.
