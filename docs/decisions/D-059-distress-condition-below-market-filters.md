---
id: D-059
title: Hard-filter the candidate feed by occupancy, condition, and below-market discount
date: 2026-08-05
group: Product
rule: The candidate feed hard-filters on `occupancy`/`condition`/`renovation`/`minBelowMarketPct`, applied in the OUTER query on the SAME per-axis columns `rankedCandidatesCte` derives (filter ⇔ rank agree). Below-market filter never touches `pool`. Unassessed axis = excluded (empty, not error); UI flags "needs assessment data".
order: 73
---

# D-059: Hard-filter the candidate feed by occupancy, condition, and below-market discount

*Decided: 2026-08-05*

**Context**: After #309/D-057 blended below-market + distress signals into the
feed *ranking*, the "glance and act" investor persona (#307) could see distress
badges float to the top — but still could not say "show me ONLY occupied /
needs-integral-reform / ≥15% below market" and see just those. The signals were
computed (occupancy/condition/red-flag verdicts in `ai_assessment`, the
pool-median price/m² discount in `rankedCandidatesCte`) and drove the sort, yet
nothing let the user *exclude* the rest. #310 asked for hard filters on exactly
those three axes. Constraints: (1) reuse #309's already-computed signals so the
filter and the ranking can never disagree about what "occupied" or "a_reformar"
means; (2) the below-market filter must not shift the very pool median that
*defines* below-market; (3) assessments are empty in this deployment until the
LLM is wired (#316), so an assessment-based filter must degrade to an *empty*
feed, never an error, and the UI must say so rather than looking broken; (4)
merge cleanly on top of #309's `rankedCandidatesCte`.

**Decision**: The candidate feed (`dashboard/lib/candidates.ts` → `listCandidates`)
gains four optional, combinable hard filters, all applied in the OUTER query on
the per-axis columns the `ranked` CTE already derives — never inside `pool`:

- `occupancy`: `occupied` (occupancy verdict `tenanted`/`occupied_illegally`) or
  `free` (`vacant`). Read from the nested Verdict at
  `ai_assessment.result->'occupancy'->>'value'`.
- `condition`: `a_reformar` | `reformado` | `obra_nueva` (flat
  `result->>'condition'`).
- `renovation`: `leve` | `integral` (#313 `result->>'renovation_severity'`);
  implies `a_reformar` since only that category carries a non-null severity.
- `minBelowMarketPct` (fraction, e.g. `0.15`): keep only candidates whose
  `below_market_pct >= threshold`. A null discount (pool below `MIN_POOL_SIZE`,
  or no price/m²) is EXCLUDED as "unknown" — never a false pass.

The three per-axis columns (`occupancy_status`, `condition_category`,
`renovation_severity`) are surfaced by the SAME `DISTINCT ON`-latest-per-axis
subquery in the CTE's `dist` LATERAL that feeds `distress_level`, so filter and
rank read one source of truth. A NULL axis value (never assessed) fails every
equality, so an assessment filter with no data yields an empty feed. The API
route validates the enum/percent values (400 on anything else, never a silent
unfiltered feed); the query passes them as bind parameters (`$7`–`$11`), never
interpolated. The UI (`CandidateList`) renders three always-present controls and
distinguishes "empty because the filter needs assessment data (#316)" from
"empty because a working filter matched nothing".

**Alternatives rejected**:
- *Profile-scope filters in `scope-query.ts`/`profiles-schema.ts`* (the shape
  #310's original body sketched): rejected in favor of feed-level filters that
  mirror the #265 source-filter pattern — the persona wants to toggle
  "occupied/a_reformar/≥N%" ad-hoc while browsing a profile's feed, not re-save
  the profile's sourcing criteria. Feed filters also reuse #309's computed
  columns directly, guaranteeing filter/rank agreement; a separate scope-stage
  would recompute the same signals in a second place and risk drift.
- *Recomputing below-market from the geographic zone median per filter call*:
  rejected — the feed already ranks on the cheap pool-median proxy (D-057); the
  filter reuses that exact `below_market_pct` so the "≥15%" a user filters on is
  the same number the ranking boosted.
- *Applying the below-market filter inside `pool`*: rejected — it would remove
  at-market candidates before the median is taken, moving the goalposts the
  discount is measured against.

**Rationale**: Reusing the CTE's per-axis signals keeps one definition of each
distress axis for both filtering and ranking. Excluding unknown/unassessed
candidates (rather than soft-passing them) matches the persona's intent — a
distress-hunting filter that silently included un-assessed properties would
defeat its purpose — and degrades to a clean, explained empty state until #316
populates assessments. The below-market filter works today from price alone.

**See**: `dashboard/lib/candidates.ts` (`rankedCandidatesCte` per-axis columns,
`CandidateFilters`, `listCandidates`), `dashboard/app/api/profiles/[id]/candidates/route.ts`,
`dashboard/components/candidates/CandidateList.tsx`,
`dashboard/e2e/distress-filters.spec.ts`. Issues #310, #307, #309 (D-057), #313,
#316, #265 (source-filter pattern), #322/D-055 (hidden-source hiding).
