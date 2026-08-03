/**
 * Zone-median price comparison, rendered as a derived (non-listing) input to
 * the two assessment flows where a below-market price is itself a genuine
 * signal — redflags (#27) and occupancy (#25/#145). Issue #184.
 *
 * ## Why this exists
 *
 * PR #180 (#30's cache) removed `precio_eur` from every cached flow's prompt
 * because `computeAssessmentContentHash` (cache.ts) deliberately excludes it
 * (issue #30 EC-3: "a connector update that only changes current_price does
 * NOT invalidate"). That was the right fix for the bug #180 found (the model
 * could see a field the invalidation key couldn't), but it cost redflags its
 * single most reliable distress-sale signal: "precio muy por debajo de
 * mercado" is a canonical tell for an embargo, a debt sale, or a
 * partial-title transfer, and the model could no longer see price at all.
 *
 * #184's fix does NOT re-add the raw price — that reopens EC-3 exactly the
 * way it was closed. Instead it feeds in the DERIVED comparison: how far
 * below the zone's median price/m² this property sits, computed from real
 * comparables by `lib/analytics/area-price.ts` (#32). That is the actual
 * signal an investor (or a lawyer) cares about, and unlike a raw euro figure
 * it is far more stable: a single connector price update only moves ONE
 * property's own price/m², while the comparison is against a whole
 * neighbourhood's MEDIAN, and bucketing (below) makes it stable again on top
 * of that.
 *
 * ## Bucketing — the hash/prompt agreement issue #184 requires
 *
 * Whatever this function returns is rendered into the prompt verbatim AND
 * fed to `getOrCompute`'s `extraHashInput` (see occupancy.ts/redflags.ts) —
 * from the exact same call, by construction, so the invalidation key can
 * never drift from what the model is shown. That agreement is the whole
 * point of #184 — it is the same bug #180 fixed for price, generalised to
 * this new field, and it must not recur here.
 *
 * Two axes are bucketed, both so ordinary data churn does not force a
 * recompute while a MATERIAL change still does:
 *
 *  - **Percentage, into 10-point bands** (issue #184's own suggestion): a
 *    property that drifts from "21% below" to "28% below" as one comparable
 *    enters or leaves the 1km radius is the same qualitative fact ("notably
 *    below market", both fall in the 20-30 band) and must not re-bill the
 *    LLM. A move from "28% below" to "31% below" crosses the 20-30/30-40
 *    boundary and DOES invalidate — that is a genuinely different magnitude
 *    of signal, not noise.
 *  - **Sample size, into coarse count tiers**: `computeAreaPriceComparison`
 *    recomputes the comparable count from the CURRENT state of every nearby
 *    property, not just this one — a neighbour's connector sync adding or
 *    withdrawing a listing changes `sample_size` for THIS property's
 *    comparison too, independently of anything about this property. The
 *    issue's own example phrasing ("23% below the zone median (n=12
 *    comparables)") renders the exact count; doing that literally would make
 *    this cache invalidate whenever a STRANGER's listing count changes by
 *    one — worse churn than the raw price this whole issue exists to avoid
 *    reintroducing. A coarse tier ("10-19 comparables") keeps the
 *    qualitative confidence signal (few vs. many comparables) without that
 *    churn. Anchored on `MIN_SAMPLE_SIZE` (the gate this function is only
 *    ever called past) so a change to that constant shifts the tiers with
 *    it.
 *
 * ## Silence, not a fabricated claim (#184 requirement 2)
 *
 * Returns `undefined` — never a null, a zero, or "en línea con el mercado" —
 * whenever `area-price.ts` itself has nothing defensible to say (below its
 * own `MIN_SAMPLE_SIZE` within 1km, or this property has no active priced
 * listing / no `m2_built`). `pct_vs_average === null` is exactly that case
 * (see area-price.ts's own doc). "We don't have a comparison" and "the price
 * is normal" are different claims; only the first is ever true here.
 *
 * ## Direction — below-market only, a deliberate narrowing
 *
 * Also returns `undefined` when the property is priced AT OR ABOVE the zone
 * median. An above-market price is not a distress/occupancy signal — nothing
 * in #27's red-flag taxonomy or #25/#145's occupancy axes is evidenced by a
 * property costing more than its neighbours — so surfacing it would only add
 * prompt noise and a pointless extra cache-invalidation surface for a fact
 * these two flows have no use for. This is narrower than #32's own
 * `AreaPriceComparison`, which reports both directions for the UI's benefit
 * (correct there); it would be noise here.
 *
 * ## Why only occupancy and redflags (#184 requirement 3)
 *
 * - **redflags** — the clear case. "Priced far below the zone" is a
 *   canonical distress-sale tell (embargo, debt sale, partial-title
 *   transfer) and is exactly the kind of context that should raise how hard
 *   the model looks for a citable disclosure in the ad text.
 * - **occupancy** — included: a repossession or distress sale relisted well
 *   below market is a genuine occupancy cue (issue #184's own example) —
 *   REO/servicer listings priced well under comparables are disproportionately
 *   likely to still carry a former owner or tenant. Same "raise scrutiny, cite
 *   only ad text" treatment as redflags.
 * - **condition — excluded.** Price-per-m² correlating with condition is a
 *   real but weak, confounded signal (location, floor, orientation, and size
 *   all move price/m² at least as much as renovation state does), and unlike
 *   redflags/occupancy there is no single ad-text disclosure this would help
 *   the model look harder for — condition is read directly off what the text
 *   says about the flat, not inferred from price. Adding it would cost cache
 *   stability for a cue too noisy to act on.
 * - **extract — excluded.** Extract pulls objective structured fields (m²,
 *   rooms, bathrooms, floor, elevator) straight out of the ad text (#28); a
 *   price comparison has no bearing on what the text literally says about
 *   the flat's dimensions, and — per extract's own EC-2 ("no inventes, no
 *   redondees, no completes") — this flow is specifically about NOT letting
 *   any external signal nudge a field away from exactly what's written.
 *   Excluded.
 *
 * Server-only: transitively imports lib/db-write via area-price.ts. Never
 * import from a client component.
 */

import { computeAreaPriceComparison, MIN_SAMPLE_SIZE } from "@/lib/analytics/area-price";

/** 10-point percentage band on the magnitude of the discount, e.g. -0.23 -> "20-30". */
function percentBand(pctVsAverage: number): string {
  const pctBelowAbs = Math.abs(pctVsAverage) * 100;
  const lower = Math.floor(pctBelowAbs / 10) * 10;
  return `${lower}-${lower + 10}`;
}

/**
 * Coarse comparable-count tier: [min, 2*min) / [2*min, 4*min) / [4*min, ∞).
 * Anchored on MIN_SAMPLE_SIZE rather than a hardcoded 5/10/20 so a future
 * change to that constant (area-price.ts) moves the tiers with it.
 */
function sampleSizeBand(sampleSize: number): string {
  const min = MIN_SAMPLE_SIZE;
  if (sampleSize < min * 2) return `${min}-${min * 2 - 1}`;
  if (sampleSize < min * 4) return `${min * 2}-${min * 4 - 1}`;
  return `${min * 4}+`;
}

/**
 * Bucketed "this property vs. its zone" price signal for one property, or
 * `undefined` when there's nothing defensible/relevant to say — see this
 * module's doc for the full decision tree (insufficient comparables, or
 * priced at/above the zone median).
 */
export async function buildAreaPriceSignal(propertyId: number): Promise<string | undefined> {
  const comparison = await computeAreaPriceComparison(propertyId);
  if (!comparison || comparison.pct_vs_average === null) return undefined;
  if (comparison.pct_vs_average >= 0) return undefined; // at/above market: not a signal these flows use

  const band = percentBand(comparison.pct_vs_average);
  const sampleBand = sampleSizeBand(comparison.sample_size);

  return (
    `El precio de este inmueble está aproximadamente un ${band}% por debajo de ` +
    `la mediana de precio/m² de inmuebles comparables en su zona (radio 1km, ` +
    `${sampleBand} comparables).`
  );
}
