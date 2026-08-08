---
id: D-100
title: Investor score is a monotone re-expression of effective_score with capped timing boosts; risk flags are chips, never subtracted
date: 2026-08-08
group: Product / candidate feed
rule: 'The investor score shown on the card + detail is a MONOTONE re-expression of the feed sort key `effective_score` (NOT a second ranking): `clamp(round(effective_score / 1.64 × 100), 0, 100)` + a colour band (A "Oportunidad" ≥70 / B "Buena" ≥50 / C "Media" ≥30 / D "Flojo" / "Sin puntuar" for the never-scored −1 sentinel) + a confidence tier + a per-term breakdown that sums exactly to the score. `effective_score` gains two #452 timing boosts in `rankedCandidatesCte` — days-on-market (linear ramp to 180d × 0.04) + net price-drop (ramp to 0.20 × 0.07), joint-capped at 0.11 — both non-negative and degrading to 0 when absent, so MAX_TOTAL_BOOST rises 0.53→0.64 and the never-scored floor holds (−1 + 0.64 = −0.36 < any real sigmoid score). Divisor 1.64 = 1.0 + MAX_TOTAL_BOOST. The #425 keyset cursor / ORDER BY / adjacency are UNCHANGED (only terms added to the existing sort expression). Boost weights/caps + all display math live in the pure, client-safe `lib/display-score.ts` (imported by `candidates.ts` for the SQL and by the card/detail for rendering — derive-once). Risk red flags render as CHIPS in the breakdown and are NEVER subtracted (for a REO/value buyer distress IS the opportunity; the distress boost already ADDS).'
---

# D-100: Investor score — re-expression of effective_score, timing boosts, risk-as-chips

*Decided: 2026-08-08*

**Context** (issue #452, Fable's design; builds on #309/D-057 and #425):
the feed already sorts on a blended `effective_score` (learned/cold-start sigmoid
base + non-negative opportunity boosts: below-market, distress, beach, tourist
licence). That score was never shown to the user as a number — the card only
carried per-signal badges, and the `ranking_boost_reason` string was computed but
never rendered. The owner wanted a single, glanceable 0–100 "how good a deal is
this" figure on the card + detail, combining all signals including timing
(days-on-market and price drops), which `market-signals.ts` already tracks but
which never fed the feed sort.

**Decision**:

1. **The displayed score is a monotone re-expression of `effective_score`, not a
   new ranking.** One number, one order: the 0–100 the card shows is
   `clamp(round(effective_score / DISPLAY_SCORE_CEIL × 100), 0, 100)`, so it can
   never disagree with the card's position in the feed, and the #425 keyset
   cursor is untouched. There is no second scoring pass, no re-sort.

2. **Two capped timing boosts are ADDED to `effective_score`** in
   `rankedCandidatesCte` (a new `timing` CTE mirroring
   `computePropertyScoringSignals`: one representative listing per property,
   days-on-market frozen at the terminal-status transition, net drop over its
   price history):
   - days-on-market: linear ramp to `DOM_SATURATION_DAYS` (180) × `DOM_BOOST_WEIGHT`
     (0.04);
   - net price-drop: linear ramp to `PRICE_DROP_SATURATION` (0.20) ×
     `PRICE_DROP_BOOST_WEIGHT` (0.07);
   - joint-capped at `TIMING_JOINT_CAP` (0.11, Fable's default).
   Both are non-negative and degrade to 0 when the signal is absent (LEFT JOIN
   NULL → CASE ELSE 0), so a candidate never sinks and the graceful-degradation
   invariant holds.

3. **Invariant recomputation.** `MAX_TOTAL_BOOST` rises from 0.53 (0.25 + 0.15 +
   0.09 + 0.04) to **0.64** (+ 0.11 timing). A never-scored candidate (base score
   NULL → `NO_SCORE_SENTINEL` = −1) at the maximum boost lands at **−0.36**,
   still strictly below any real sigmoid score in (0,1) — so #309/D-057's
   "augment, never replace" / "never-scored stays last" invariant survives the
   timing terms. The display divisor `DISPLAY_SCORE_CEIL` = 1.0 (sigmoid
   supremum) + `MAX_TOTAL_BOOST` = **1.64** (Fable's chosen value), computed from
   the constants so it can't silently drift.

4. **The cursor is unchanged in shape.** `effective_score` remains the single
   sort key; #452 only appends terms to its existing expression. The
   `(novelty_tier, effective_score, property_id)` keyset ORDER BY, the cursor
   encoding, and `getAdjacentCandidates` are byte-for-byte unchanged in
   structure — no re-tiering, no mid-session ordering instability.

5. **Band + confidence + summing breakdown.** Band: A "Oportunidad" (≥70),
   B "Buena" (≥50), C "Media" (≥30), D "Flojo" (<30), plus "Sin puntuar" for the
   sentinel (never mapped to a number). Confidence (alta/media/baja) from input
   coverage. The detail "Puntuación inversora" section shows a per-term breakdown
   whose integer points sum EXACTLY to the shown score (largest-remainder
   rounding anchored to the authoritative `effective_score`), with "sin datos"
   rows for absent signals.

6. **Risk flags are chips, never subtracted** (owner decision). Red flags /
   caveats render as informational warn-tone chips in the breakdown, explicitly
   labelled "no restan puntos" — for a REO / value buyer distress IS the
   opportunity, and the distress boost already ADDS for it. Subtracting would
   double-penalise the very thesis the tool serves.

7. **Derive-once.** All boost weights/caps and the entire display mapping live in
   the pure, client-safe `lib/display-score.ts` (no server imports).
   `lib/candidates.ts` imports the numeric constants to interpolate into the SQL;
   the card chip and detail section import the same module to render. The SQL
   sort key and the UI re-expression can never drift because they read one set of
   constants.

**Alternatives rejected**:

- *A separate scoring pass / stored 0–100 column.* Rejected: a second number is a
  second source of truth that can disagree with the feed order. A pure
  re-expression of the existing sort key can't.
- *Subtracting for risk flags.* Rejected per the owner: penalises the value-buy
  thesis. Chips-that-inform, boost-that-adds is the correct model here.
- *`relisted_lower` as a third timing boost.* Deferred (issue #452 Fase 5): crawl
  coverage of the cross-listing relist pattern is ~0 today, so it would add SQL
  cost for no signal. Revisit when the crawl ages.

**Rationale**: one number that is provably consistent with the order the user is
already looking at; timing signals that were tracked but unused now contribute;
the never-scored floor is preserved and re-verified in code (`MAX_TOTAL_BOOST` is
computed, not asserted in a comment); and the value-buyer semantics (distress =
opportunity) are honoured rather than fought.

**See**: `dashboard/lib/display-score.ts`,
`dashboard/lib/candidates.ts` (`rankedCandidatesCte`, `describeRankingBoost`,
`getPropertyInvestorScore`), `dashboard/components/candidates/InvestorScoreChip.tsx`,
`dashboard/components/property/sections/InvestorScoreSection.tsx`,
`dashboard/e2e/investor-score.spec.ts`; issue #452; decisions D-057 (blended
`effective_score`), D-059 (derive-once per-axis columns), #425 (keyset cursor).
