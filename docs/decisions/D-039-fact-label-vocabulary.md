---
id: D-039
title: Review-state labels are fact-*; config.yml must match; owner-handoff strips ai-awaiting-owner only on CI failing
date: 2026-05-30
---

# D-039: Review-state labels are `fact-*`; `config.yml` must match the workflows; owner-handoff strips `ai-awaiting-owner` only on CI `failing`

*Decided: 2026-05-30*

**Context**: Three converged PRs (#778, #779, #781) never received the `ai-awaiting-owner` handoff label despite Copilot passing clean and CI green. Two compounding bugs were found:

1. **Stale label vocabulary in `config.yml`.** Every PR-review workflow (`ai-pr-review.yml`, `ai-address-feedback.yml`, `ai-watchdog.yml`, `ai-ci-remediation.yml`) keys off the `fact-*` state labels, but `.github/ai-factory/config.yml` still listed the old `ai-*` names (`ai-ready-for-review`, `ai-phase-copilot`, `ai-cp-after-1`, `ai-phase-opus`, `ai-o-after-1`, `ai-ci-failing`). `ai-factory-manager.yml` dumps `config.yml` **verbatim** into the factory-manager prompt, so the agent stamped PRs with the stale `ai-*` labels. Those are invisible to the `fact-*`-gated state machine: the Opus trigger (`fact-ready-for-review`) never fires and the converged-handoff reconcile (`fact-o-after-1`) never matches, stranding PRs. The orphan `ai-*` labels were identifiable by their empty description + default `ededed` colour (auto-created by a name reference), vs the real `fact-*` labels' `"state label — workflows toggle"` description.

2. **CI-timing race strips `ai-awaiting-owner`.** In `ai-address-feedback.yml`, `owner_handoff_or_ci_gate()` stripped `ai-awaiting-owner` **before** branching on CI state, so a transient `running`/`unknown` read (e.g. CI re-running after an auto-fix commit, as on #781) un-converged a legitimately handed-off PR and forced a watchdog recovery loop.

**Decision**:
1. `.github/ai-factory/config.yml` label values MUST **exactly match** the names the workflows read/write. It is dumped **verbatim** into the factory-manager prompt, so any drift is effectively executable — a stale name gets re-applied to live PRs and breaks `labeled`-gated triggers. When renaming a label in a workflow, update `config.yml` in the **same** change. This completes the D-034 `ai-*`→`fact-*` migration that `config.yml` had missed:
   - **Internal state labels are `fact-*`**: `fact-planned`, `fact-in-progress`, `fact-task`, `fact-needs-rewrite`, `fact-auto-retry`, `fact-phase-copilot`, `fact-cp-after-1`, `fact-phase-opus`, `fact-o-after-1`, `fact-ready-for-review`, `fact-ci-failing`.
   - **The labels that stay `ai-*`** are the human-/trigger-facing ones the owner acts on: `ai-work`, `ai-blocked`, `ai-plan`, `ai-decompose`, `ai-validate-ec`, `ai-awaiting-owner`, `ai-bug`, `ai-idea`, `ai-merge-conflict`, `ai-stale-base`.
2. `owner_handoff_or_ci_gate` in `ai-address-feedback.yml` MUST strip `ai-awaiting-owner` **only** when CI state is `failing`. On a transient `running`/`unknown` read it MUST leave labels as-is — a prior converged pass may have legitimately set `ai-awaiting-owner` (both rounds done + CI green), and the next `ready` pass re-affirms it.
3. Convergence to `ai-awaiting-owner` in `ai-address-feedback.yml` is gated on **label state** (`fact-cp-after-1` + `fact-o-after-1` both present), **never** on "this round produced no code changes." A Copilot round with zero inline comments pushes no commits but is **not** converged — it MUST still advance to `fact-phase-opus` and dispatch the Opus round (#783). The no-commit and commit paths therefore both fall through to the same phase state machine.
4. `ai-pr-review.yml` MUST complete the Opus-round transition **itself**, in the same run, rather than depending solely on a dispatched `ai-address-feedback` run starting (bot-actor dispatches can be dropped/gated — D-035). When Opus leaves **zero** inline comments (the common LGTM case) it converges inline: add `fact-o-after-1`, clear phase labels, and do the CI-gated `ai-awaiting-owner` handoff. Only when Opus leaves ≥1 inline comment does it dispatch `ai-address-feedback` to apply fixes (which then owns convergence). This is what kept #778/#779/#781 from needing a watchdog rescue.

**Alternatives rejected**:
- *Make the factory-manager read label names from a live source instead of `config.yml`* — larger change; the single-source-of-truth file is fine as long as it stays in sync.
- *Delete the orphan `ai-*` labels only* — removes the symptom but not the cause; `config.yml` would re-mint them on the next factory-manager run.

**Rationale**: `config.yml` is a verbatim prompt input, so it is effectively executable configuration — drift between it and the workflows silently mis-labels PRs. Stripping the handoff label only on a confirmed CI failure (never on a transient unknown) keeps a converged PR converged through CI re-runs.

**See**: `.github/ai-factory/config.yml`, `.github/workflows/ai-address-feedback.yml` (`owner_handoff_or_ci_gate` + phase state machine), `.github/workflows/ai-pr-review.yml`, `.github/workflows/ai-watchdog.yml`; issues #783 (Opus-skip), #784 (config drift); PRs #778, #779, #781; [D-021](D-021-two-review-rounds.md), [D-031](D-031-copilot-opus-sequencing.md), [D-035](D-035-action-required-bot-gating.md).
