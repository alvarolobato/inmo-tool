/**
 * Renovation-cost estimate for the buy-to-flip thesis (issue #45, task 5.4).
 *
 * A rough, deliberately-directional €/m² heuristic — NOT a construction quote
 * (issue #45 scope note: "a €/m² heuristic tier, not a renovation quote").
 * Keyed off #26/#313's condition assessment (`lib/ai-assessment/condition.ts`):
 * the flat `condition` verdict plus, for `a_reformar`, the `renovation_severity`
 * sub-axis (`leve`/`integral`/`unknown`) #313 added specifically so this file
 * can tier light-vs-heavy work at different rates instead of one flat band.
 *
 * Pure function — no DB, no config I/O — so it's cheaply unit-testable (this
 * repo's "financial maths verified by hand" standard) and reusable from the
 * property-detail route and any future comparison view. The €/m² bands are
 * passed IN (see `RefurbCostBands`), never hardcoded here: real refurb costs
 * vary by region and the owner will tune them without a code change (issue #45
 * "make the bands themselves configurable"). `DEFAULT_REFURB_COST_BANDS` is the
 * v1 placeholder; `lib/analytics/flip-config.ts` resolves the live values from
 * `config/schema.yaml` (env > config.yaml > default).
 *
 * Honesty discipline (issue #45 technical approach #6, mirrors the rest of the
 * analytics layer): when the condition evidence doesn't support a graded
 * estimate — no assessment yet (`condition === null`, the norm until the LLM
 * flows are wired at scale, #308/#316), an `unclear` verdict, or an
 * un-graded `a_reformar` — the result degrades to a clearly-labelled
 * "no estimate" / conservative-mid band rather than inventing a precise number.
 */

import type { ConditionCategory, RenovationSeverity } from "@/lib/ai-assessment/condition";

/**
 * Per-m² refurbishment rates, euros. Round, clearly-approximate numbers
 * (issue #45 technical approach #1: "use round, clearly-approximate numbers").
 *
 *  - `leve`     — cosmetic / light reform (paint, kitchen/bath refresh,
 *                 flooring): a lower €/m² band.
 *  - `integral` — heavy / structural reform (reforma integral, systems,
 *                 gutting to shell): a materially higher band.
 *  - `unknown`  — the property IS `a_reformar` but the depth couldn't be
 *                 graded from the ad text (#313's `unknown`/`null` severity):
 *                 a CONSERVATIVE MID band, flagged as ungraded, so a flip
 *                 margin built on it reads as provisional rather than as a
 *                 fabricated leve/integral figure.
 */
export interface RefurbCostBands {
  leve_eur_per_m2: number;
  integral_eur_per_m2: number;
  unknown_eur_per_m2: number;
}

/**
 * v1 placeholder bands (issue #45 Additional Context: "treated as v1
 * placeholders the owner will likely want to tune against real regional cost
 * data"). Rough Spanish-market rules of thumb — light ~400 €/m², integral
 * ~900 €/m², ungraded mid ~650 €/m². Overridable per `config/schema.yaml`
 * (`flip.refurb_cost_*_eur_m2`).
 */
export const DEFAULT_REFURB_COST_BANDS: RefurbCostBands = {
  leve_eur_per_m2: 400,
  integral_eur_per_m2: 900,
  unknown_eur_per_m2: 650,
};

/**
 * Which band a property landed in.
 *  - `none`        — already reformado / obra nueva: no capex (rate 0).
 *  - `leve`/`integral`/`unknown` — the three `a_reformar` bands above.
 *  - `no_estimate` — no reliable condition signal (`null`/`unclear`): the
 *                    evidence doesn't support any estimate at all.
 */
export type RefurbTier = "none" | "leve" | "integral" | "unknown" | "no_estimate";

export interface RenovationCostEstimate {
  tier: RefurbTier;
  /** Band rate applied, euros/m². 0 for `none`; null for `no_estimate`. */
  eur_per_m2: number | null;
  /** Property built area used, or null when unknown/non-positive. */
  m2: number | null;
  /**
   * `eur_per_m2 × m2`, euros. 0 for `none` (no capex, regardless of m²). Null
   * when a rate applies but m² is unknown (can't multiply — don't fabricate a
   * total), and null for `no_estimate`.
   */
  total_eur: number | null;
  /** Human-readable basis, always shown next to the figure (never a bare number). */
  basis: string;
}

/**
 * Estimate refurbishment cost from a condition assessment and built area.
 *
 * `condition`/`severity` come from `lib/ai-assessment/condition.ts`'s cached
 * verdict (both `null` when no assessment exists yet). `m2` is the property's
 * `m2_built`. `bands` are the configurable €/m² rates (defaults above).
 */
export function estimateRenovationCost(
  condition: ConditionCategory | null,
  severity: RenovationSeverity | null,
  m2: number | null,
  bands: RefurbCostBands = DEFAULT_REFURB_COST_BANDS,
): RenovationCostEstimate {
  const validM2 = m2 !== null && Number.isFinite(m2) && m2 > 0 ? m2 : null;

  // No reliable condition signal → no estimate (honesty: don't guess a band
  // from silence, exactly as condition.ts refuses to assert from silence).
  if (condition === null || condition === "unclear") {
    return {
      tier: "no_estimate",
      eur_per_m2: null,
      m2: validM2,
      total_eur: null,
      basis:
        "Sin evaluación de estado fiable — no se estima coste de reforma (se necesita una valoración de estado del anuncio).",
    };
  }

  // Already renovated / new build → no capex.
  if (condition === "reformado" || condition === "obra_nueva") {
    const label = condition === "reformado" ? "reformado" : "obra nueva";
    return {
      tier: "none",
      eur_per_m2: 0,
      m2: validM2,
      total_eur: 0,
      basis: `Estado "${label}" — sin coste de reforma estimado (0 €).`,
    };
  }

  // condition === "a_reformar": tier by renovation_severity.
  let tier: RefurbTier;
  let ratePerM2: number;
  let severityLabel: string;
  if (severity === "leve") {
    tier = "leve";
    ratePerM2 = bands.leve_eur_per_m2;
    severityLabel = "reforma ligera";
  } else if (severity === "integral") {
    tier = "integral";
    ratePerM2 = bands.integral_eur_per_m2;
    severityLabel = "reforma integral";
  } else {
    // "unknown" or null — a_reformar but depth ungraded (#313). Conservative
    // mid band, flagged as provisional.
    tier = "unknown";
    ratePerM2 = bands.unknown_eur_per_m2;
    severityLabel = "a reformar, profundidad sin graduar";
  }

  const totalEur = validM2 !== null ? ratePerM2 * validM2 : null;
  const basis =
    validM2 !== null
      ? `${severityLabel}: ${ratePerM2} €/m² × ${validM2} m² (estimación aproximada, ajustable en configuración).`
      : `${severityLabel}: ${ratePerM2} €/m² (sin superficie construida registrada — no se puede calcular el total).`;

  return { tier, eur_per_m2: ratePerM2, m2: validM2, total_eur: totalEur, basis };
}
