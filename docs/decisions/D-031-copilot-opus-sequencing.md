---
id: D-031
title: Strict Copilot → address → Opus → address sequencing
date: 2026-05-11
---

# D-031: Strict Copilot → address → Opus → address sequencing

*Decided: 2026-05-11*

**Context**: PRs #594 and #596 (sub-tasks of #580) sat for 3.5 h with both reviews posted but the lifecycle labels stuck in `ai-cp-after-1 + ai-phase-opus + ai-ready-for-review`. PR #595 sat for 5 h in `ai-phase-copilot` after a GraphQL 504 in `ai-pr-review.yml`. Owner observation (paraphrased): *"why are PRs not progressing through reviews? neither the watchdog nor the factory manager should have to intervene."* Trace showed three concrete bugs:

1. **Out-of-order race**: `ai-pr-review.yml` fired on `pull_request: types: [opened, reopened, ready_for_review, labeled]`. On a fresh PR Opus posted a review at 12:26 (PR #594) and 12:27 (PR #596), BEFORE Copilot finished posting (12:28 / 12:30). Address-feedback then processed only the Copilot review (its most recent fire), transitioned the PR to `ai-phase-opus`, and the orphaned Opus review never advanced the chain. The head-SHA idempotency check inside the workflow was designed to prevent **duplicate** reviews but cannot fix the **sequencing** problem.
2. **Silent failure on transient errors**: `ai-pr-review.yml`'s `Handle failure` step ran `gh pr edit "$PR_NUMBER" --add-label ai-ready-for-review --add-label ai-blocked --add-label ai-auto-retry || true` without `--repo`. On PR #595 the prior step crashed on `HTTP 504 GraphQL`, then this label-add itself errored with `failed to run git: fatal: not a git repository`. The `|| true` swallowed it; no retry marker landed; the watchdog had nothing to retry. Silent 5 h stall.
3. **Critical-dispatch swallow**: `ai-address-feedback.yml` at the Copilot→Opus transition ran `gh workflow run ai-pr-review.yml ... || true`. If the dispatch failed (rate limit, action_required gate, transient), the PR sat in `ai-phase-opus` with no further events, waiting on a watchdog cycle whose actual cadence is ~3 h (issue #598).

**Decision**:
- **Tighten `ai-pr-review.yml`'s trigger to `types: [labeled]` only** — gated by `if: github.event.action == 'labeled' && github.event.label.name == 'ai-ready-for-review'`. The label is added at exactly one point in the lifecycle (when address-feedback finishes addressing the Copilot review), enforcing **Copilot → address → Opus → address → owner-merge** as a strict sequence. `workflow_dispatch` remains available for manual re-fires from the watchdog or owner.
- **Failure handler in `ai-pr-review.yml` gets `--repo` and loses `|| true` on the label-add** — when adding the `ai-blocked + ai-auto-retry` retry marker fails, the step goes red and the failure is visible. Belt: pass `--repo "$REPO"` so the call doesn't depend on a working git checkout (workflow_dispatch runs aren't guaranteed to land in the repo dir at this point).
- **Critical Copilot→Opus dispatch in `ai-address-feedback.yml` loses `|| true`** — both the label transition and the `gh workflow run ai-pr-review.yml` dispatch are now strict. If either fails the workflow goes red, the watchdog sees the marker (or the owner sees the run failure in the UI). Belt-and-braces: the label add IS the trigger now (per D-031), but the dispatch remains as a deterministic backup against GitHub's `action_required` gating of bot-actor label events.

**Alternatives rejected**:
- **Keep all four trigger types and rely on the head-SHA idempotency to dedupe**: doesn't address the sequencing — the FIRST Opus review still happens out of order; idempotency only stops the SECOND one.
- **Add a separate "is Copilot done?" check at the top of ai-pr-review.yml**: harder to reason about than a clean trigger. Bug-prone if Copilot's review state is ambiguous (e.g., PRs created with the `request reviewer` API but never actually reviewed).
- **Remove the `Handle failure` step entirely and let the watchdog detect failed runs**: the watchdog's actual cadence (#598) is too slow; we'd trade a 5 h stall for a ~3 h stall.

**Rationale**: The factory should self-drive through review rounds without the watchdog or Factory Manager intervening; their job is recovery for genuine failures, not papering over architectural races. D-031 is the architectural fix; #598 (watchdog cadence) is the recovery-layer fix; both ship in parallel.

**See**: `.github/workflows/ai-pr-review.yml` (trigger + failure handler), `.github/workflows/ai-address-feedback.yml` (Copilot→Opus transition), PRs #594, #595, #596 (the casualties), #600 (D-030 watchdog cadence companion fix).
