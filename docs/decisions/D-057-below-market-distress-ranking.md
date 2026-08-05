---
id: D-057
title: Blend below-market + distress signals into the candidate feed ranking
date: 2026-08-05
---

# D-057: Blend below-market + distress signals into the candidate feed ranking

*Decided: 2026-08-05*

**Context**: The default candidate feed (`dashboard/lib/candidates.ts`) sorted
purely on the learned/cold-start `profile_listing_state.score`. A genuinely
below-market or distressed (occupied / needs-work / debt-sale) listing showed
its badge but never rose in the list, so the "glance and act" investor persona
(#307) still had to scan the whole feed to find the deals — the badges existed
(#308) but did nothing for the sort order (#309). The two opportunity signals
already exist in the platform: the below-market discount vs. the zone median
(`analytics/area-price.ts`, fed into assessments by #184) and the distress
verdicts in `ai_assessment` (occupancy caveats, red flags, `a_reformar`
condition). Constraints: the model must be **augmented, not replaced** (no
retrain, keep the learned score authoritative); a candidate with **no
assessment and no discount** must rank exactly on its base score (assessments
are empty in this deployment until the LLM is wired, #316); the feed is
globally keyset-paginated, so the sort key has to be computable for every
matched candidate cheaply; and the change must stay within the ranking layer so
it merges cleanly against #310 (which owns the *filter* side).

**Decision**: The feed now sorts on a blended `effective_score`, computed in
SQL by the shared `rankedCandidatesCte` in `candidates.ts`:

```
effective_score = COALESCE(score, -1)
                + LEAST(GREATEST(below_market_pct, 0), 0.5) * 0.5   -- ≤ +0.25
                + LEAST(distress_level, 3) * 0.05                    -- ≤ +0.15
```

- **below_market_pct** = how far this property's price/m² sits below the
  MEDIAN price/m² of THIS profile's own matched, source-visible candidate pool
  (`percentile_cont(0.5)`), gated on ≥ `MIN_POOL_SIZE` (3) priced candidates.
  Null (no boost) when the pool is too small or the property has no price/m² —
  never a fabricated "at market" zero.
- **distress_level** (0–3) = one point each for a warn-tone occupancy caveat,
  any red flag, or an `a_reformar` condition, read from the LATEST assessment
  per axis (`DISTINCT ON`, same rule `loadFlags` uses).
- Both boosts are **additive and non-negative**, so a no-signal candidate keeps
  its base score exactly (never sinks), and a never-scored candidate (score
  NULL → −1) still sorts last even at the maximum +0.40 boost.
- The cursor and `getAdjacentCandidates` sort on the same `effective_score`, so
  keyset pagination and the detail page's prev/next never diverge from the feed.
- `CandidateRow` surfaces `effective_score`, `below_market_pct`,
  `distress_level`, and a Spanish `ranking_boost_reason` ("why this ranked
  high") for explainability.

**Alternatives rejected**:
- *Feed the signals as trained-model features (features.ts/model.ts, #309's
  literal touchpoints)*: needs a retrain to have any effect, and the distress
  feature is null everywhere until #316 — so it would do nothing for the
  persona today. Also a bigger blast radius across the scoring pipeline.
- *Rank by the true geographic zone-median discount (`computeAreaPriceComparison`)
  per candidate in the ORDER BY*: that Haversine self-join can't use an index
  (see area-price.ts) and would run for EVERY matched row on EVERY page load — a
  real regression, the exact per-row-subquery landmine `scope-query.ts` warns
  about. The pool median is a cheap, globally-orderable proxy.
- *Materialize `effective_score` in the scoring pass*: cleaner long-term and
  index-friendly, but expands scope into pipeline.ts/retrain.ts + a schema
  column and staleness handling — deferred as the follow-up if a profile's
  matched pool ever grows large enough for the new sort (no longer covered by
  `idx_profile_listing_state_profile_ranked`) to hurt.

**Rationale**: A query-time blend keeps the whole change inside the ranking
layer (clean merge with #310), keeps the learned model untouched, degrades
gracefully to base score when signals are absent (today's reality), and is
cheap enough at the current per-profile matched-set size. The pool median is
the right below-market reference for ranking because it is exactly "cheaper
than the other candidates this profile is considering" and needs no per-row
geographic scan — the same reference `scoring/pipeline.ts`'s cold-start
heuristic already falls back to (`poolMedianPricePerM2`). Weights keep the
learned score dominant (max boost 0.40 on a sigmoid score in (0,1)) while still
letting a clear deal overtake a modest score gap.

**See**: `dashboard/lib/candidates.ts` (`rankedCandidatesCte`,
`describeRankingBoost`, `WARN_CAVEAT_CODES`), `dashboard/lib/analytics/area-price.ts`
(reused reference, not modified), `dashboard/lib/ai-assessment/price-signal.ts`
(#184 / D-012), issues #309 / #307 / #308 / #316, sibling #310 (filter side).
Related: D-012 (derived price signal), D-054 (digest ranking, separate).
