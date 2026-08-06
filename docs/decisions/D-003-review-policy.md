---
id: D-003
title: Bounded review policy — Opus per task, Fable per phase, until AI-factory workflows land
date: 2026-08-02
group: Plumbing / process
rule: Each task PR gets one fresh review pass; each phase gets one fresh cross-task review pass. Once per checkpoint — no iterating a round until "no more feedback."
order: 3
---

# D-003: Bounded review policy — Opus per task, Fable per phase, until AI-factory workflows land

*Decided: 2026-08-02*

**Context**: The source project (powershop-analytics) settled on exactly two automated review rounds per PR — GitHub Copilot, then Opus from a clean context — enforced by `.github/workflows/ai-pr-review.yml` (D-021 in that project's archive). This repo doesn't have that automation wired up yet: `.github/workflows/*.yml` couldn't be committed during the initial bootstrap (the pushing token lacked the `workflow` OAuth scope — see D-004) and Copilot's PR-review integration isn't configured for this repo. Implementation is happening under direct owner instruction in the meantime, and still needs a bounded, repeatable review discipline rather than ad hoc self-review.
**Decision**: Until the AI-factory workflows are committed and Copilot is wired up, this project's review cadence is:
1. Each task-level issue is implemented on its own branch/PR.
2. A fresh review pass (clean context, no prior involvement in the implementation) reviews each task's PR before it's considered ready — currently run as a separate reviewer agent, filling the role Copilot+Opus jointly play in the source project's policy.
3. After every phase's task PRs are implemented, a second fresh review pass evaluates the phase as a whole (cross-task coherence, not just per-task correctness) before the phase is handed off for owner testing.
4. Each review round runs **once** per checkpoint — no iterating a single round until "no more feedback." Findings get addressed, then the process moves on; a genuinely disputed or unresolvable finding escalates to the owner instead of triggering a third pass.
This is the same bounded-rounds principle as the source project's D-021, adapted to this repo's current tooling (no bots configured yet) rather than copying its Copilot-specific mechanics verbatim.
**Revisit when**: `.github/workflows/` is committed and Copilot review is configured for this repo — at that point, re-evaluate whether to adopt the source project's exact two-bot-round policy or keep the per-task/per-phase split introduced here.
**Rationale**: Bounded, once-per-checkpoint review catches real problems (as it already did — see the review round on issues #1–#45 that caught a data-modeling defect before any code was written) without the infinite-loop failure mode the source project explicitly moved away from.
**See**: `docs/decisions/archive/D-021-two-review-rounds.md` (source project's original rationale), issue #1 "Review addressed" sections (concrete example of this process catching real problems pre-implementation).
