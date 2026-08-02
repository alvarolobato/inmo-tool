---
id: D-033
title: Opus head-SHA idempotency requires non-empty body; workflow runs identified by run-name
date: 2026-05-16
---

# D-033: Opus head-SHA idempotency requires non-empty body; workflow runs identified by run-name

*Decided: 2026-05-16*

**Context**

On 2026-05-15, eight PRs created by the AI worker (#629, #640, #644, #645, #646, #647, #649, #650) all reached `ai-blocked` despite Copilot having reviewed them and address-feedback having pushed fix commits. The pattern was identical for every one: address-feedback addressed Copilot, transitioned to `ai-cp-after-1 + ai-phase-opus + ai-ready-for-review`, dispatched `ai-pr-review.yml` — and then Opus's review never actually ran. The watchdog re-dispatched five times (every 75 minutes), each dispatch completed `success`, and then the watchdog gave up and stamped `ai-blocked`.

Investigation found **two compounding bugs** in the review state machine:

1. **`ai-pr-review.yml` head-SHA idempotency was over-broad.** The check counted *any* `claude[bot]` review on the head SHA as "Opus already ran". But `ai-address-feedback.yml` posts each inline reply to a Copilot comment as a separate review submission (state=COMMENTED, body=""). After a single Copilot round, the new head SHA typically had 3–10 such empty-body "reviews". Every Opus dispatch saw them and short-circuited at line 90 of `ai-pr-review.yml`.

   On PR #647: 4 empty-body `claude[bot]` reviews on commit `b691ef1`. Opus was dispatched at least 8 times (1 explicit from address-feedback + 1 labeled event + 3 stuck-opus retries + 5 stalled-rfr retries). Every dispatch short-circuited. Zero real Opus reviews on the head SHA.

   The check was introduced for PR #561 (duplicate Opus reviews — three Claude reviews on the same SHA within 50 min). The fix prevented duplicates but couldn't distinguish a real review from an inline reply.

2. **The watchdog's "recent run" detector matched on `head_sha` and `.inputs.pr_number`, both of which are wrong for `workflow_dispatch` runs.**

   - `gh workflow run ai-pr-review.yml --field pr_number=N` defaults to the default branch as the workflow source, and the resulting run record has `head_sha = main's SHA`, not the PR's branch SHA. The "Stuck `ai-phase-opus`" detector at `ai-watchdog.yml:619-620` filtered `head_sha == PR.headRefOid` and therefore could not see the dispatched runs — even though dozens had completed `success`. It concluded "Opus never ran" every cycle and kept re-dispatching.
   - The "Stalled `ai-ready-for-review`" detector at `ai-watchdog.yml:301-310` tried to read `.inputs.pr_number` from the workflow-runs *list* endpoint. That field is only available on the single-run detail endpoint, never on the list. The check always returned empty, so the detector never recognised a recent run.

**Decision**

Two binding rules apply going forward:

1. **Head-SHA idempotency in `ai-pr-review.yml` must filter on `(.body | length) > 0`.** Real Opus reviews always carry a non-empty body — the `claude-code-action` posts a "## Review summary" via `use_sticky_comment: true`. Inline-reply review submissions from address-feedback always have an empty body. The length check cleanly discriminates the two; a future stricter version may also require the body to match a sentinel string the action emits, but body-length is sufficient and stable.

2. **Workflow runs that need to be matched across `pull_request` and `workflow_dispatch` events must use top-level `run-name:` to embed the identifying token in `display_title`.** For PR-targeted workflows, the convention is `AI PR Review — PR #<N>`. Watchdogs match by `display_title` containing `PR #<N>` (with a non-digit boundary to avoid prefix matches), never by `head_sha` or `.inputs.*`. `head_sha` is unreliable for `workflow_dispatch` (defaults to default branch); `.inputs.*` is absent from the list endpoint.

These rules also apply to similar checks in `ai-address-feedback.yml`, `ai-ci-remediation.yml`, and any future review/feedback workflow.

**Alternatives rejected**

- *Filter by review state in `[APPROVED, CHANGES_REQUESTED]`*: rejected — real Opus reviews can be submitted with state `COMMENTED` when Claude has no clear approve/changes verdict. Body-length is a more reliable discriminator.
- *Have address-feedback post inline replies via `/pulls/{n}/comments/{cid}/replies` instead of submitting reviews*: rejected for this PR — would change the action's internal behaviour beyond the scope of a state-machine fix. Worth revisiting (PR-review-comment replies are not "reviews" and would avoid the conflation entirely).
- *Use the `--ref` flag on `gh workflow run` so dispatched runs record the PR branch's head_sha*: rejected — runs the workflow file from the PR branch, which is the wrong thing for security (a PR could modify the workflow). Keep workflow source = default branch; identify runs by `run-name`.
- *Consolidate the two competing watchdog detectors into one*: deferred to follow-up. Once the matching bugs above are fixed, both detectors correctly conclude "not stalled" and the consolidation is cosmetic.

**Rationale**

Both bugs were latent — they never fired in the steady state where one or two PRs progressed at a time. The 2026-05-15 episode bunched eight PRs into the Opus phase within a 90-minute window and exposed every concurrency-related defect at once. The fix preserves the original intent (no duplicate Opus reviews; auto-recover from dropped dispatches) while correctly identifying the "real review" event.

**See**

- `.github/workflows/ai-pr-review.yml` — head-SHA idempotency (the `EXISTING_CLAUDE_REVIEWS` jq filter near line 90) and top-level `run-name:`
- `.github/workflows/ai-watchdog.yml` — "Stalled `ai-ready-for-review` PRs" and "Stuck `ai-phase-opus` PRs" steps (the `display_title` and real-Opus-on-head checks)
- D-021 (two review rounds) — D-033 makes D-021 actually work under burst load
- D-031 (Copilot → Opus sequencing) — D-033 fixes the Opus-side of the sequence
- PRs #629, #640, #644, #645, #646, #647, #649, #650 — the eight stalled PRs that motivated this decision
- PR #561 — the original motivation for the head-SHA idempotency check that D-033 tightens
