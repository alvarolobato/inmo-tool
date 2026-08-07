---
id: D-089
title: Per-profile preference-similarity signal augments scoring, gated on a low feedback threshold
date: 2026-08-06
group: AI layer
rule: The per-profile preference signal (`scoring/preference.ts`) nudges the written `profile_listing_state.score` by ±`PREFERENCE_SIGNAL_WEIGHT` (0.15) via centroid cosine-similarity over the SAME z-scored feature space, learned only from that profile's own accept/reject history (D-096 retired `star`). It is a hard no-op (`buildPreferenceModel` → `null`, signal exactly 0) below `MIN_FEEDBACK_TO_LEARN` (8) labeled examples or when one-sided; augments, never replaces, the cold-start/trained score.
order: 89
---

# D-089: Per-profile preference-similarity signal augments scoring, gated on a low feedback threshold

*Decided: 2026-08-06*

**Context**: Phase 7.2 (#40) asked for embedding-based preference learning that
adapts each profile's ranking to what its owner accepts/rejects. The whole
platform currently has only ~6 `feedback_event` rows, so anything that lets a
tiny sample move the ranking would be worse than nothing. The structured
logistic model (task 3.2, `scoring/model.ts`) only trains at
`MIN_TRAINING_EXAMPLES` (32) labeled examples — leaving a long early-life
window where a profile has *some* feedback but no personalization at all. The
issue's literal touchpoints (a text-embedding provider, an offline eval
harness) presuppose a meaningful feedback history that does not exist yet, and
issue #40 itself flags the "not worth starting on a handful of events"
precondition.

**Decision**: Ship the *self-learning scaffold* now as a similarity signal over
the canonical feature space, so it costs nothing today and turns on
automatically, per profile, as that profile's own feedback accumulates —
without hardcoding any preferences.

- **Signal** (`scoring/preference.ts`): for a profile, take every property with
  a current accept (positive) or reject (negative) verdict as its z-scored
  feature vector (the exact `features.ts#extractRaw` →
  `model.ts#normalizeVector` pipeline the trained model uses, normalized against
  the whole matched pool). The "liked" direction is the centroid of positives,
  "disliked" is the centroid of negatives. A candidate's signal =
  `cosine(candidate, positiveCentroid) − cosine(candidate, negativeCentroid)`,
  in [−1, 1]. Embedding-agnostic: if a real listing-text embedding is wired
  later it slots in as extra dimensions of the same vector.
- **Graceful activation**: `buildPreferenceModel` returns `null` below
  `MIN_FEEDBACK_TO_LEARN` (8) labeled examples, or when feedback is one-sided.
  `preferenceSignal(null, …)` is exactly `0`, and `applyPreferenceSignal(base,
  0) === base` bit-for-bit. So at today's ~6-event state nothing moves; a
  no-data candidate (all features imputed to the pool mean → zero vector) also
  gets cosine 0, i.e. no fabricated lean.
- **Wiring**: applied in the scoring pass (`retrain.ts` on every feedback event,
  `pipeline.ts#scoreNewCandidates` at materialization time) as
  `applyPreferenceSignal(baseScore, signal)` on the value written to
  `profile_listing_state.score` — the same column `candidates.ts`'s
  `effective_score` ranks on. Weighted modestly at `PREFERENCE_SIGNAL_WEIGHT`
  (0.15), clamped into the valid (0,1) range. Applied in BOTH the cold-start
  branch (its main value — personalizing in the 8–31 window before the logistic
  model fits) and the trained branch (a consistent extra nudge, no
  discontinuity at 32).
- **Explanation honesty** (#40 EC-4): when the signal is meaningful,
  `explainScore` appends a deliberately non-specific clause ("similar a
  propiedades que ya has valorado positivamente" / "parecido a propiedades que
  has descartado antes") rather than a fabricated precise claim — a
  centroid-similarity IS a vaguer statement than a per-feature contribution.

**Alternatives rejected**:
- *Wire a text-embedding provider + offline eval harness now (the issue's
  literal `embeddings.ts`/`model-eval.ts`)*: presupposes a feedback history that
  doesn't exist; an eval harness over 6 events measures noise. Deferred until a
  profile actually accumulates enough labeled history — the feature vector this
  signal already learns from is the honest v2 scaffold. The similarity math is
  provider-agnostic, so the embedding upgrade is additive, not a rewrite.
- *Feed the preference as a new trained-model feature (features.ts/model.ts)*:
  only takes effect at 32 examples (a retrain), so it would do nothing in the
  8–31 window that is exactly where a lightweight preference signal is most
  valuable; also a bigger blast radius than a post-hoc score nudge.
- *Blend it into `candidates.ts#effective_score` at query time (like D-057's
  boosts)*: viable, but the preference signal is intrinsic personalization of
  the learned score, not an opportunity boost; keeping it in the scoring pass
  keeps `effective_score` about below-market/distress and means the persisted
  `score` already reflects it.

**Rationale**: A centroid-similarity over the existing feature space is cheap,
deterministic, fully explainable, and — critically — a provable no-op until a
profile has enough of its own feedback, so it can ship safely today and improve
ranking automatically later with zero further work. The low threshold (8)
decoupled from the logistic model's 32 fills the early-life personalization gap;
the modest clamped weight guarantees a small sample can never dominate the
learned score.

**See**: `dashboard/lib/scoring/preference.ts` (signal + graceful gating),
`retrain.ts` / `pipeline.ts` (wiring into the scoring pass), `explain.ts` (EC-4
clause), `dashboard/lib/scoring/__tests__/preference.test.ts` (ranking + no-op
+ real-Postgres feedback read). Issue #40 (Phase 7.2). Related: D-057
(effective_score ranking blend, separate concern), task 3.2 (the augmented
logistic model), D-039 (staleness, unrelated).
