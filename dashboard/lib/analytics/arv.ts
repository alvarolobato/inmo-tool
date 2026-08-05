/**
 * After-repair value (ARV) estimate for the buy-to-flip thesis (issue #45,
 * task 5.4). "What would this unit sell for, renovated?" — the exit price a
 * flip margin is netted against.
 *
 * Reuses the zone €/m² comparable already computed by `area-price.ts` (#32):
 * `ARV ≈ area_median_price_per_m2 × m2_built`. That median comes from
 * `PERCENTILE_CONT(0.5)` over same-type properties within the radius, gated to
 * `MIN_SAMPLE_SIZE` (null below it), so a non-null median here already means
 * "enough comparables to be worth showing".
 *
 * ## Honest v1 approximation (issue #45 technical approach #3)
 *
 * Issue #45 ideally wants comps filtered toward the RENOVATED end of the
 * condition spectrum ("what does a renovated unit here sell for"), not a
 * general area average across all conditions. That filtering isn't possible
 * yet: condition assessments are empty until the LLM flows run at scale
 * (#308/#316), so a renovated-only comp query would return near-zero rows and
 * no ARV at all. v1 therefore reuses the general area median and says so
 * loudly in `basis` — a directional estimate that biases the ARV
 * conservatively (mixing in un-renovated comps pulls the median DOWN, so the
 * flip margin is understated rather than overstated). When condition-graded
 * comps exist, a later revision can swap the input without touching this
 * function's shape or its callers.
 *
 * Pure function — no DB access. The DB work (fetching the median) already
 * lives in `area-price.ts`; this only does the arithmetic + confidence tier,
 * so it's cheaply unit-testable and reusable.
 */

/** Confidence in the ARV, tiered by how many comparables backed the median. */
export type ArvConfidence = "high" | "low";

/**
 * Sample-size threshold at/above which the ARV reads as high-confidence
 * (issue #45 technical approach #5: "an ARV based on 3 renovated comps should
 * visibly read as less confident than one based on 15"). 15 mirrors that
 * example directly. Below it (but at/above area-price's MIN_SAMPLE_SIZE of 5,
 * which is what makes the median non-null in the first place) the ARV still
 * renders, tagged low-confidence.
 */
export const ARV_HIGH_CONFIDENCE_MIN_SAMPLE = 15;

export interface ArvEstimate {
  /** Estimated after-repair value, euros. Null when comps or m² are missing. */
  arv_eur: number | null;
  /** The zone median €/m² used (from area-price.ts). Null when unavailable. */
  arv_per_m2: number | null;
  /** Property built area used, or null when unknown/non-positive. */
  m2: number | null;
  /** Comparable count backing the median (echoed for the confidence caveat). */
  sample_size: number;
  /** High/low per `ARV_HIGH_CONFIDENCE_MIN_SAMPLE`; null when there's no ARV. */
  confidence: ArvConfidence | null;
  /** Human-readable basis, always shown — states the approximation explicitly. */
  basis: string;
}

/**
 * Estimate ARV from the zone median €/m² and the property's built area.
 *
 * `areaMedianPricePerM2` is `AreaPriceComparison.area_median_price_per_m2`
 * (null below the min-sample gate). `m2` is `m2_built`. `sampleSize` is
 * `AreaPriceComparison.sample_size`, used only for the confidence tier.
 */
export function estimateArv(
  areaMedianPricePerM2: number | null,
  m2: number | null,
  sampleSize: number,
  opts: { highConfidenceMinSample?: number } = {},
): ArvEstimate {
  const highMin = opts.highConfidenceMinSample ?? ARV_HIGH_CONFIDENCE_MIN_SAMPLE;
  const validM2 = m2 !== null && Number.isFinite(m2) && m2 > 0 ? m2 : null;
  const validMedian =
    areaMedianPricePerM2 !== null && Number.isFinite(areaMedianPricePerM2) && areaMedianPricePerM2 > 0
      ? areaMedianPricePerM2
      : null;

  if (validMedian === null || validM2 === null) {
    const reason =
      validMedian === null
        ? "sin suficientes comparables de venta en la zona"
        : "sin superficie construida registrada";
    return {
      arv_eur: null,
      arv_per_m2: validMedian,
      m2: validM2,
      sample_size: sampleSize,
      confidence: null,
      basis: `Sin estimación de valor tras reforma (${reason}).`,
    };
  }

  const arvEur = validMedian * validM2;
  const confidence: ArvConfidence = sampleSize >= highMin ? "high" : "low";

  return {
    arv_eur: arvEur,
    arv_per_m2: validMedian,
    m2: validM2,
    sample_size: sampleSize,
    confidence,
    basis:
      `Aproximación: mediana de la zona (${sampleSize} comparables, todas las condiciones) ` +
      `× ${validM2} m². Los comparables NO están filtrados a inmuebles reformados, ` +
      `así que el ARV tiende a quedarse corto (conservador).`,
  };
}
