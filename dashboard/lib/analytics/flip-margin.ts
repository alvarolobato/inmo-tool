/**
 * Flip margin — the headline buy-to-flip metric (issue #45, task 5.4):
 *
 *   margin = ARV − purchase price − refurb cost − transaction/holding buffer
 *
 * Every component is surfaced separately (issue #45 EC-2 / technical approach
 * #4: "displayed alongside its three components, not just the final number —
 * an investor needs to see and challenge each input, not just trust a
 * black-box margin"). This module returns each line; the UI never re-derives
 * them.
 *
 * `computeFlipMargin` is the pure margin arithmetic; `computeFlipMetrics`
 * composes the three estimates (renovation cost, ARV, margin) into one result
 * for the property-detail flip section. Both pure — no DB, no config I/O — so
 * the whole flip calculation is unit-testable end to end from primitive
 * inputs (the DB reads and config resolution live in
 * `lib/investment-metrics.ts` / `lib/analytics/flip-config.ts`).
 *
 * Graceful degradation (issue #45: "degrade gracefully when severity/comps are
 * missing … show 'sin estimación' cleanly, never crash or show a garbage
 * number"): any missing input (no ARV, no purchase price, no refurb estimate)
 * yields `computable: false` with a null margin and a `basis` explaining what's
 * missing — never a NaN, a fabricated zero, or a partial margin.
 */

import {
  estimateRenovationCost,
  type RefurbCostBands,
  type RenovationCostEstimate,
} from "./renovation-estimate";
import { estimateArv, type ArvEstimate } from "./arv";
import type { ConditionCategory, RenovationSeverity } from "@/lib/ai-assessment/condition";

/**
 * Buffer for all transaction + holding costs of a flip — acquisition taxes
 * (ITP/notary/registry), selling costs (agent commission), and carrying costs
 * while the works run — as a single configurable percentage of the PURCHASE
 * PRICE. A deliberately coarse v1 rule of thumb (issue #45 asks for "a
 * configurable %", not a line-itemised model): 10% is a round, generous
 * all-in placeholder, tunable via `config/schema.yaml`
 * (`flip.sale_holding_cost_pct`).
 */
export const DEFAULT_SALE_HOLDING_COST_PCT = 10;

export interface FlipMarginResult {
  arv_eur: number | null;
  purchase_price: number | null;
  refurb_cost_eur: number | null;
  /** `purchase_price × transaction_buffer_pct/100`; null when price unknown. */
  transaction_buffer_eur: number | null;
  transaction_buffer_pct: number;
  /** ARV − price − refurb − buffer, euros. Null when not computable. */
  margin_eur: number | null;
  /**
   * Margin as a fraction of total cash out (price + refurb + buffer) — the
   * return on the money actually deployed, the flip analogue of cash-on-cash.
   * Fraction, not a pre-multiplied percentage (e.g. 0.11 = "11%"), matching
   * area-price.ts / acquisition-costs.ts's convention. Null when not
   * computable or total-out is non-positive.
   */
  margin_pct: number | null;
  /** True only when ARV, purchase price, and refurb cost are all known. */
  computable: boolean;
  basis: string;
}

/**
 * Pure flip-margin arithmetic. `refurbCostEur` is the TOTAL refurb estimate
 * (`RenovationCostEstimate.total_eur`); a `none`-tier property passes 0 here
 * (already renovated, real zero), which is computable — distinct from a
 * `no_estimate` property passing `null`, which is not.
 */
export function computeFlipMargin(
  arvEur: number | null,
  purchasePrice: number | null,
  refurbCostEur: number | null,
  saleHoldingCostPct: number = DEFAULT_SALE_HOLDING_COST_PCT,
): FlipMarginResult {
  const pct = Number.isFinite(saleHoldingCostPct) && saleHoldingCostPct >= 0 ? saleHoldingCostPct : 0;
  const hasPrice = purchasePrice !== null && Number.isFinite(purchasePrice) && purchasePrice > 0;
  const bufferEur = hasPrice ? (purchasePrice as number) * (pct / 100) : null;

  const computable =
    hasPrice &&
    arvEur !== null &&
    Number.isFinite(arvEur) &&
    refurbCostEur !== null &&
    Number.isFinite(refurbCostEur);

  if (!computable) {
    const missing: string[] = [];
    if (arvEur === null || !Number.isFinite(arvEur)) missing.push("valor tras reforma (ARV)");
    if (!hasPrice) missing.push("precio de compra");
    if (refurbCostEur === null || !Number.isFinite(refurbCostEur)) missing.push("coste de reforma");
    return {
      arv_eur: arvEur !== null && Number.isFinite(arvEur) ? arvEur : null,
      purchase_price: hasPrice ? (purchasePrice as number) : null,
      refurb_cost_eur: refurbCostEur !== null && Number.isFinite(refurbCostEur) ? refurbCostEur : null,
      transaction_buffer_eur: bufferEur,
      transaction_buffer_pct: pct,
      margin_eur: null,
      margin_pct: null,
      computable: false,
      basis: `Sin margen estimable: falta ${missing.join(" y ")}.`,
    };
  }

  const price = purchasePrice as number;
  const refurb = refurbCostEur as number;
  const arv = arvEur as number;
  const buffer = bufferEur as number;
  const marginEur = arv - price - refurb - buffer;
  const totalOut = price + refurb + buffer;
  const marginPct = totalOut > 0 ? marginEur / totalOut : null;

  return {
    arv_eur: arv,
    purchase_price: price,
    refurb_cost_eur: refurb,
    transaction_buffer_eur: buffer,
    transaction_buffer_pct: pct,
    margin_eur: marginEur,
    margin_pct: marginPct,
    computable: true,
    basis:
      `Margen = ARV (${Math.round(arv)}) − compra (${Math.round(price)}) − reforma (${Math.round(refurb)}) ` +
      `− gastos ${pct}% (${Math.round(buffer)}). Estimación aproximada de apoyo a la decisión, no una tasación.`,
  };
}

export interface FlipMetricsInputs {
  /** From the condition assessment (null when none exists yet). */
  condition: ConditionCategory | null;
  severity: RenovationSeverity | null;
  /** Property `m2_built`. */
  m2: number | null;
  /** MIN(active sale price) — same convention as the rest of the analytics layer. */
  purchasePrice: number | null;
  /** `AreaPriceComparison.area_median_price_per_m2` (null below min sample). */
  areaMedianPricePerM2: number | null;
  /** `AreaPriceComparison.sample_size` (for the ARV confidence tier). */
  sampleSize: number;
}

export interface FlipMetricsConfig {
  refurbBands: RefurbCostBands;
  saleHoldingCostPct: number;
}

export interface FlipMetrics {
  renovation: RenovationCostEstimate;
  arv: ArvEstimate;
  margin: FlipMarginResult;
}

/**
 * Compose the three flip estimates from primitive inputs. Pure — the caller
 * (`lib/investment-metrics.ts`) does the DB reads and passes the numbers in.
 */
export function computeFlipMetrics(inputs: FlipMetricsInputs, config: FlipMetricsConfig): FlipMetrics {
  const renovation = estimateRenovationCost(inputs.condition, inputs.severity, inputs.m2, config.refurbBands);
  const arv = estimateArv(inputs.areaMedianPricePerM2, inputs.m2, inputs.sampleSize);
  const margin = computeFlipMargin(
    arv.arv_eur,
    inputs.purchasePrice,
    renovation.total_eur,
    config.saleHoldingCostPct,
  );
  return { renovation, arv, margin };
}
