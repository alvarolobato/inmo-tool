---
id: D-012
title: Feed the zone-median price comparison into occupancy/redflags as a bucketed derived input, hashed alongside it
date: 2026-08-03
group: AI layer
rule: occupancy/redflags see a bucketed zone-median price comparison (never raw price); the exact string rendered must also be the exact `extraHashInput` passed to `getOrCompute`.
order: 65
---

# D-012: Feed the zone-median price comparison into occupancy/redflags as a bucketed derived input, hashed alongside it

*Decided: 2026-08-03*

**Context**: PR #180 fixed a real bug in the #30 assessment cache: `computeAssessmentContentHash` hashed only `(listing_id, description)` while `formatListing` rendered `precio_eur` (and other fields) into the prompt, so a large price cut left a stale verdict cached indefinitely. #180's fix removed those fields from every cached flow's prompt entirely, since issue #30's EC-3 explicitly requires that price must not invalidate the cache — extending the hash to cover price was foreclosed by that constraint. That was internally consistent but cost redflags its most reliable distress-sale signal ("precio muy por debajo de mercado" — a canonical embargo/debt-sale/partial-title tell) and cost occupancy the same cue applied to REO/repossession relistings. Issue #184 revisits this now that the cost is concrete. Four options were on the table (keep as-is; amend EC-3 to admit a coarse price band; split the flows so only redflags sees price; feed in the #32 zone-median comparison as a derived input). The owner chose option 4.

**Decision**:
- `dashboard/lib/ai-assessment/price-signal.ts`'s `buildAreaPriceSignal(propertyId)` computes a bucketed "this property vs. its zone" comparison from `lib/analytics/area-price.ts`'s `computeAreaPriceComparison` (#32) — never the raw price.
- Percentage bucketed into 10-point bands (`20-30`, `30-40`, …) on the magnitude of the discount; comparable count bucketed into coarse tiers anchored on `MIN_SAMPLE_SIZE` (`5-9`, `10-19`, `20+`). Both bucketings exist for the same reason: ordinary data churn (a nearby listing entering/leaving the radius, the comparable count fluctuating) must not force a cache miss; only a move across a band boundary — a materially different signal — does.
- Returns `undefined` (never a null, zero, or "priced normally") whenever `area-price.ts` itself has nothing defensible to say (below its own `MIN_SAMPLE_SIZE` within 1km) OR the property is priced at/above the zone median — an above-market price is not a distress signal for either flow.
- Only `occupancy` (#25/#145) and `redflags` (#27) receive it — see `price-signal.ts`'s module doc for why `condition`/`extract` don't. Both flows' `assessProperty*()` compute the signal once and pass the identical string into BOTH the LLM prompt (`FlowVars.areaPriceSignal`) AND `getOrCompute`'s new `extraHashInput` parameter (`cache.ts`), from the same call — the invalidation key and the rendered prompt can never disagree by construction, which is the generalised fix for the exact class of bug #180 found for price.
- The model is told (in `system-prompt.ts`'s `AREA_PRICE_SIGNAL_RULES`, placed AFTER `ASSESSMENT_RULES` so it is the last, binding word) that this derived text is never citable as `evidence` and never proves a finding by itself — only that it should raise how hard the model looks for an actual, citable disclosure in the ad text.
- `computeAssessmentContentHash`'s new `extra` parameter is backward-compatible: a two-argument call (as `condition`/`extract` still make) hashes bit-for-bit identically to before this change, so no pre-#184 cached row for those two assessment types goes stale.

**Alternatives rejected**:
- *Keep as-is* — leaves redflags/occupancy structurally blind to a canonical distress-sale signal; the product is separately building this reasoning for #32/#151 but that display-only surface doesn't feed the assessment flows.
- *Amend EC-3 to admit a coarse price band directly* — would still tie invalidation to THIS property's own price fluctuation, more volatile than a zone-relative comparison, and duplicates what #32 already computes correctly.
- *Split the flows, let only redflags see raw price* — still reintroduces the raw-price/EC-3 conflict for the flow that gets it, and doesn't help occupancy's genuine (if weaker) use case.

**Rationale**: The zone-median comparison is the actual signal an investor or lawyer cares about ("is this priced like a distressed sale"), it is already computed from real comparables rather than the model's price intuition, and — bucketed — it is far more stable than a raw euro figure, so it invalidates the cache rarely while still tracking a genuinely material change.

**See**: issue #184, PR (this change), `dashboard/lib/ai-assessment/price-signal.ts`, `dashboard/lib/ai-assessment/cache.ts`, `dashboard/lib/llm-context/system-prompt.ts`.
