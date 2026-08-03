---
id: D-014
title: Comparable-rent estimator — selection rule, confidence tiers, and precedence vs. a profile's own assumption
date: 2026-08-03
---

# D-014: Comparable-rent estimator — selection rule, confidence tiers, and precedence vs. a profile's own assumption

*Decided: 2026-08-03*

**Context**: [D-010](D-010-rent-assumption-until-comparables.md) shipped a per-profile `€/m²/month` assumption as an explicit stand-in "until #31 ships real comparables" — issue #31 is that work. `RentConfidence` (`"high" | "low" | "assumption" | null`) was deliberately typed as a superset from the start so `"high"`/`"low"` could go from reserved-but-unreachable to real without a signature change (see the original `rent-estimate.ts` docstring). This decision makes three judgment calls the issue and the implementing brief both flagged as needing an explicit, documented answer.

**Decision**:

1. **Comparable selection**: same shape as `area-price.ts`'s sale-comparable query (median via `PERCENTILE_CONT`, a padded lat/lon bounding-box prefilter ahead of the exact Haversine expression, same `idx_property_lat_lon` index) with two differences tuned for rent specifically:
   - **Size-banded** (`SIZE_BAND_RATIO = 0.35`, comps within ±35% of the target's own `m2_built`): rent varies far more with size than sale price/m² does (a 40m² studio rents for much more per m² than a 150m² flat) — an unbanded median would systematically mis-scale for anything far from the local size mix. Sale comps aren't size-banded because condition and exact location dominate price/m² there more than size does.
   - **Looser radius** (`DEFAULT_RADIUS_KM = 1.5` vs. sale's `1`): rental inventory is far sparser today (one new connector vs. several existing sale connectors) — a tighter radius would push most properties straight to "insufficient data" regardless of how well-located the real comps are.

2. **Confidence tiers**: issue #31's own bands are the count gate, taken verbatim: below 3 comparables → no estimate (`insufficient_data`); 3–7 → `low`; 8+ → `high`. On top of that (per the implementing brief, not the issue itself), a dispersion gate can demote an 8+ sample from `high` to `low`: `MAX_HIGH_CONFIDENCE_RELATIVE_IQR = 0.6` — the interquartile range of comps' €/m²/month, divided by their median. This can only ever demote `high` → `low`, never promote a small sample to `high` and never turn a real sample into `insufficient_data` — the count gate alone decides usable-vs-not; dispersion only decides how much to trust a usable one.

3. **Precedence vs. a profile's own assumption**: the profile's `thesis_params.rent_assumption`, when set, remains the figure `yield.ts` actually computes from (`method: "profile_assumption"`, behaviourally unchanged from [D-010](D-010-rent-assumption-until-comparables.md)) — **never silently replaced by a measured comparable**, since a human may have encoded information the algorithm can't see (a specific building's condition, a negotiated rate, local knowledge). The market-comparable estimate is **always computed and attached** (`RentEstimateResult.market_comparable`) whenever the property has enough location data to query with, regardless of whether an assumption is set, and `disagreement_pct` is populated whenever both numbers exist. The UI (`YieldSection.tsx`) renders both and flags a disagreement ≥15% with a warning treatment — "show both", never "pick the one that looks more sophisticated". When no assumption is set at all, the market-comparable estimate becomes the PRIMARY figure — this is the actual point of #31: unblocking yield for any profile that never set a manual assumption.

**Alternatives rejected**:
- A single flat minimum-sample cutoff (mirroring `area-price.ts`'s `MIN_SAMPLE_SIZE = 5` single gate) — rejected because issue #31 explicitly asks for tiered confidence ("a median of 3 comparables and a median of 20 are not equally trustworthy"), not a pass/fail gate.
- Letting the measured comparable silently override or average with the assumption when both exist — rejected per the brief's explicit "do not silently replace the user's number" instruction; averaging two differently-sourced numbers (a judgment call and a measurement) would fabricate a third number neither source actually produced, the same anti-pattern [D-009](D-009-acquisition-cost-model.md) already rejected for carrying costs.

**Rationale**: The count-gate-plus-dispersion-demotion design keeps the issue's own explicit, reviewable numeric bands as the primary contract while still satisfying "confidence must mean something... tied to sample size and dispersion, not a vibe" — a `high` label now means both "enough comparables" and "comparables that roughly agree with each other," not just the former. The precedence rule keeps [D-010](D-010-rent-assumption-until-comparables.md)'s honesty guarantee (never fabricate, never silently override an explicit human input) while extending it to a population of profiles that never had a number to override in the first place.

**Status**: This decision **retires [D-010](D-010-rent-assumption-until-comparables.md)** — its "until #31 ships real comparables" condition is now met. D-010's file is marked retired rather than deleted (git archaeology); its line is removed from `DECISIONS.md`.

**See**: `dashboard/lib/analytics/rent-estimate.ts` (module docstring has the full reasoning and worked examples), `dashboard/lib/analytics/__tests__/rent-estimate.test.ts` (hand-computed worked examples for every tier), `dashboard/components/property/sections/YieldSection.tsx`, [D-016](D-016-rental-data-reuses-listing-table.md) (the schema decision this estimator depends on), issue #31.
