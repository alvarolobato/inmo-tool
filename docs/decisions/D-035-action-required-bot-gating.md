---
id: D-035
title: GitHub gates Copilot-actor pull_request_review workflow runs as action_required — rely on cron watchdog for recovery
date: 2026-05-20
---

# D-035: GitHub gates Copilot-actor `pull_request_review` workflow runs as `action_required`

*Decided: 2026-05-20*

**Context**: Since at least 2026-05-15, every `pull_request_review`-triggered run of
`ai-watchdog.yml` and `ai-address-feedback.yml` where the triggering actor is `Copilot`
(GitHub Copilot) concludes as `action_required` instead of executing. This blocks the
fast-path event-driven recovery introduced by D-030, leaving the `*/30` cron watchdog as
the only fallback.

**Evidence from GitHub Actions API** (queried 2026-05-20):

| Timestamp (UTC) | Workflow | Triggering actor | Conclusion |
|---|---|---|---|
| 2026-05-15T12:55:16Z | AI Factory Watchdog | Copilot | action_required |
| 2026-05-15T12:55:16Z | AI Address PR Feedback | Copilot | action_required |
| 2026-05-15T14:32:17Z | AI Factory Watchdog | Copilot | action_required |
| 2026-05-15T14:32:17Z | AI Address PR Feedback | Copilot | action_required |
| 2026-05-15T14:41:40Z | AI Factory Watchdog | Copilot | action_required |
| 2026-05-15T14:41:40Z | AI Address PR Feedback | Copilot | action_required |
| 2026-05-16T21:26:52Z | AI Factory Watchdog | Copilot | action_required |
| 2026-05-16T21:26:52Z | AI Address PR Feedback | Copilot | action_required |

All `action_required` runs are triggered by the `Copilot` actor. `claude[bot]`-triggered
`pull_request_review` runs (e.g., Opus reviews) run successfully. Human-triggered runs
also succeed.

**Root cause**: GitHub gates `pull_request_review` workflow runs as `action_required` when
the triggering actor is the `Copilot` bot. This is a GitHub platform-level policy: the
`Copilot` GitHub service is not an installed GitHub App on this repo with workflow execution
permissions — it submits PR reviews as an external actor, and GitHub requires manual
admin approval before those workflow runs can execute. This affects any workflow triggered
by a Copilot PR review, regardless of whether the workflow requests `id-token: write`
(both `ai-watchdog.yml`, which does not, and `ai-address-feedback.yml`, which does, are
gated identically — confirming this is actor-based, not permission-based).

The `action_required` status is set at the workflow-run level before any jobs start, so
job-level `if:` conditions cannot prevent it.

**Decision**:

1. **Accept that `pull_request_review` triggers are unreliable when Copilot submits a review.**
   The `action_required` gating is a GitHub platform constraint, not a per-repo policy that
   can be changed via `permissions:` or job conditions.

2. **The `*/30` cron watchdog is the authoritative recovery path for Copilot reviews.**
   `ai-watchdog.yml` dispatches `ai-address-feedback.yml` via `workflow_dispatch` for any
   PR with reviewer activity newer than the last bot response and older than 3 minutes.
   `workflow_dispatch` is NOT gated as `action_required`. This path is already working.

3. **The `pull_request_review` trigger remains in both workflows** for the benefit of
   human reviewers and `claude[bot]` (Opus) reviews, which run successfully. Removing it
   would lose the fast-path Opus transition detection (seconds vs. ≤30 min).

4. **Proposed (human-commit only, per D-029)**: See the "Proposed YAML" section in PR #712.
   - `ai-address-feedback.yml`: add explicit `Copilot` check to the bot-skip condition
     so that if the `action_required` gating is ever resolved, Copilot reviews still
     take the cron/dispatch path rather than trying to run address-feedback directly.
   - `ai-watchdog.yml`: enhance the "Bot-triggered runs gated as `action_required`" step
     to cancel (not just log) stale `action_required` runs, reducing Actions UI noise.

**Alternatives rejected**:
- **Job-level `if: github.triggering_actor != 'Copilot'`**: `action_required` is set at
  the workflow-run level before job evaluation; this would not change the run's conclusion.
- **Remove `pull_request_review` trigger entirely**: loses the Opus fast-path (seconds vs.
  ≤30 min for `fact-phase-opus` transition). Copilot's `action_required` noise is
  manageable given the existing detection step in the watchdog.
- **Auto-approve via `gh api .../approve`**: requires a PAT; GITHUB_TOKEN lacks permission.
  The watchdog already attempts this and logs when it cannot.

**Rationale**: The factory's review cycle is progressing correctly via the cron path.
The `action_required` runs are visual noise in the Actions UI, not functional blockers.
The right response is to document the constraint clearly and accept the cron path as the
primary mechanism for Copilot review recovery, as it already is.

**See**:
- Issue #679 (this investigation)
- [D-030](D-030-watchdog-cadence.md) — watchdog cadence; the `pull_request_review` trigger was added here
- [D-029](D-029-no-worker-workflows.md) — worker cannot commit workflow files
- [D-031](D-031-copilot-opus-sequencing.md) — review sequencing (Copilot → Opus)
- PR #675 — first PR where the issue became visible (2026-05-17)
