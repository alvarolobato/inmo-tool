/**
 * Gross/net yield + cash-on-cash — issue #33, tied to acquisition costs and
 * carrying costs per issue #151 ("this issue adds what #33/#32 don't cover:
 * acquisition costs... a yield computed without them overstates returns by
 * a wide margin").
 *
 * Out of scope (issue #33's Context, issue #1 §11/§16): real underwriting —
 * mortgage amortization *schedules* (this computes a level annuity payment,
 * not a full schedule), tax modeling (no income-tax treatment of rental
 * income or mortgage-interest deductibility), or any personalized advice.
 * This is decision support: a number an investor uses to compare deals
 * against each other, not a number a bank uses to underwrite a loan.
 *
 * ## Carrying costs (#151): a deliberate, documented divergence from #33's
 * literal wording
 *
 * Issue #33's Technical approach describes ONE configurable
 * `operating_cost_pct` bundling community fees, IBI, maintenance, and a
 * vacancy allowance together. Issue #151 (filed after #33, explicitly
 * described as the product-level issue that ties #32/#33 together) asks
 * for actual IBI/community-fee data to be used "rather than estimated"
 * whenever the source publishes it (Solvia's `raw_extra.ibi_anual_eur` /
 * `raw_extra.gastos_comunidad_eur`, see solvia_mapping.py's
 * `extract_investment_extras`).
 *
 * "Used... rather than estimated" is read literally as a REPLACEMENT, not a
 * blend: when the property has at least one actual carrying-cost figure
 * (from any of its active listings' `raw_extra`), the assumed
 * `operating_cost_pct` is not applied at all — actual costs stand in for
 * the entire operating-cost line. This is simpler and more transparent
 * than trying to invent a sub-split (e.g. "IBI is normally X% of the
 * bundled 25%, so subtract that share and keep the rest") — inventing that
 * split would itself be exactly the kind of fabricated precision issue #1
 * §11 warns against. The tradeoff, stated plainly: actual IBI + community
 * fee doesn't include maintenance/vacancy allowance, so a property with
 * known carrying costs but genuinely high maintenance needs could show a
 * net yield a bit optimistic relative to the assumed-bundle case. Every
 * result echoes `carrying_costs_source` ("actual" | "assumed") in
 * `assumptions_used` specifically so this is visible, not hidden.
 *
 * `operating_cost_pct` itself is unchanged from #33 — no second
 * configuration mechanism was added (checked before diverging, per #151's
 * own instruction to check #33 first): it's still
 * `thesis_params.financing.operating_cost_pct`, just only applied in the
 * assumed-costs branch.
 */

import type { RentEstimateResult } from "./rent-estimate";
import {
  computeAcquisitionCosts,
  type AcquisitionCostBreakdown,
  type AcquisitionCostOverrides,
} from "./acquisition-costs";
import type { ThesisParams } from "@/lib/profiles-schema";

/**
 * App-wide fallback financing assumptions (issue #33 EC-2: a profile with
 * no `thesis_params.financing` set must still produce a result). These
 * intentionally mirror ProfileForm.tsx's own `setFinancingField` reset
 * defaults (down 20%, 3% rate, 25-year term) so the form's placeholder
 * values and this silent fallback never quietly diverge — if one changes,
 * check the other.
 */
export const DEFAULT_FINANCING = {
  down_payment_pct: 20,
  rate_pct: 3,
  term_years: 25,
};

/**
 * Percentage of GROSS annual rent assumed to cover community fees, IBI,
 * maintenance, and a vacancy allowance, used ONLY when the property has no
 * actual carrying-cost data (see module docstring). 25% is the upper end
 * of the "20-25% of gross rent" rule of thumb issue #33 cites — the more
 * conservative choice for a decision-support tool: erring toward
 * understating net yield is safer than erring toward overstating it.
 */
export const DEFAULT_OPERATING_COST_PCT = 25;

export interface CarryingCostsKnown {
  /** From `listing.raw_extra->>'ibi_anual_eur'` (Solvia today) — annual property tax, euros. Null if not published by any active listing. */
  annual_ibi_eur: number | null;
  /** From `listing.raw_extra->>'gastos_comunidad_eur'` — monthly community fee, euros. Null if not published. */
  monthly_community_fee_eur: number | null;
}

export const NO_CARRYING_COSTS_KNOWN: CarryingCostsKnown = {
  annual_ibi_eur: null,
  monthly_community_fee_eur: null,
};

export interface YieldPropertyInput {
  /** MIN(current_price) across the property's active listings (same convention as scope-query.ts/candidates.ts). Null when no active listing has a price — gates the result, same as no rent estimate. */
  purchase_price: number | null;
  province: string | null;
}

export interface YieldAssumptionsUsed {
  down_payment_pct: number;
  rate_pct: number;
  term_years: number;
  financing_is_default: boolean;
  operating_cost_pct: number;
  operating_cost_pct_is_default: boolean;
  carrying_costs_source: "actual" | "assumed";
  annual_carrying_costs_eur: number;
  acquisition_costs: AcquisitionCostBreakdown;
}

export interface YieldResult {
  gross_yield_pct: number | null;
  net_yield_pct: number | null;
  cash_on_cash_pct: number | null;
  /** Propagated verbatim from the rent estimate this yield was built on (issue #33 EC-4) — the UI must render a lower-confidence treatment for "low"/"assumption" than "high". */
  rent_confidence: RentEstimateResult["confidence"];
  rent_method: RentEstimateResult["method"];
  estimated_monthly_rent: number | null;
  /** Null exactly when no rent estimate exists — every other field is null in that case too (issue #151: gate yield rather than fabricate a rent figure). */
  assumptions_used: YieldAssumptionsUsed | null;
}

function gatedResult(rentEstimate: RentEstimateResult): YieldResult {
  return {
    gross_yield_pct: null,
    net_yield_pct: null,
    cash_on_cash_pct: null,
    rent_confidence: rentEstimate.confidence,
    rent_method: rentEstimate.method,
    estimated_monthly_rent: null,
    assumptions_used: null,
  };
}

/**
 * Standard level-annuity monthly mortgage payment. `rate_pct === 0` is
 * handled as a straight-line payoff (division by zero otherwise) — a real,
 * reachable input (a profile modeling an all-cash or interest-free
 * scenario), not just defensive code.
 */
function monthlyMortgagePayment(financedAmount: number, ratePct: number, termYears: number): number {
  const n = termYears * 12;
  if (ratePct === 0) return financedAmount / n;
  const monthlyRate = ratePct / 100 / 12;
  return (financedAmount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -n));
}

/**
 * Computes gross/net yield and cash-on-cash for one property. Pure
 * function — no DB access, so it's cheaply unit-testable (this repo's
 * "financial maths needs worked examples verified by hand" standard) and
 * reusable from both the property detail route and any future comparison
 * view (task 6.3).
 */
export function computeYield(
  property: YieldPropertyInput,
  rentEstimate: RentEstimateResult,
  thesisParams: Pick<ThesisParams, "financing" | "acquisition_costs">,
  carryingCostsKnown: CarryingCostsKnown = NO_CARRYING_COSTS_KNOWN,
): YieldResult {
  if (rentEstimate.estimated_monthly_rent === null) {
    return gatedResult(rentEstimate);
  }
  if (property.purchase_price === null || !(property.purchase_price > 0)) {
    // No active listing has a price (property.min_price null) — same
    // "can't compute, don't fabricate" gate as the no-rent-estimate case.
    return gatedResult(rentEstimate);
  }

  const financing = thesisParams.financing;
  const financingIsDefault = financing === undefined;
  const downPaymentPct = financing?.down_payment_pct ?? DEFAULT_FINANCING.down_payment_pct;
  const ratePct = financing?.rate_pct ?? DEFAULT_FINANCING.rate_pct;
  const termYears = financing?.term_years ?? DEFAULT_FINANCING.term_years;
  const operatingCostPctIsDefault = financing?.operating_cost_pct === undefined;
  const operatingCostPct = financing?.operating_cost_pct ?? DEFAULT_OPERATING_COST_PCT;

  const annualGrossRent = rentEstimate.estimated_monthly_rent * 12;
  const grossYieldPct = (annualGrossRent / property.purchase_price) * 100;

  const hasActualCarrying =
    carryingCostsKnown.annual_ibi_eur !== null || carryingCostsKnown.monthly_community_fee_eur !== null;
  const annualCarryingCosts = hasActualCarrying
    ? (carryingCostsKnown.annual_ibi_eur ?? 0) + (carryingCostsKnown.monthly_community_fee_eur ?? 0) * 12
    : (operatingCostPct / 100) * annualGrossRent;

  const annualNetRent = annualGrossRent - annualCarryingCosts;
  const netYieldPct = (annualNetRent / property.purchase_price) * 100;

  const acquisitionOverrides: AcquisitionCostOverrides = thesisParams.acquisition_costs ?? {};
  const acquisitionCosts = computeAcquisitionCosts(property.purchase_price, property.province, acquisitionOverrides);

  const financedAmount = property.purchase_price * (1 - downPaymentPct / 100);
  const annualMortgagePayment = monthlyMortgagePayment(financedAmount, ratePct, termYears) * 12;
  const actualCashInvested = property.purchase_price * (downPaymentPct / 100) + acquisitionCosts.total_eur;
  const cashOnCashPct = ((annualNetRent - annualMortgagePayment) / actualCashInvested) * 100;

  return {
    gross_yield_pct: grossYieldPct,
    net_yield_pct: netYieldPct,
    cash_on_cash_pct: cashOnCashPct,
    rent_confidence: rentEstimate.confidence,
    rent_method: rentEstimate.method,
    estimated_monthly_rent: rentEstimate.estimated_monthly_rent,
    assumptions_used: {
      down_payment_pct: downPaymentPct,
      rate_pct: ratePct,
      term_years: termYears,
      financing_is_default: financingIsDefault,
      operating_cost_pct: operatingCostPct,
      operating_cost_pct_is_default: operatingCostPctIsDefault,
      carrying_costs_source: hasActualCarrying ? "actual" : "assumed",
      annual_carrying_costs_eur: annualCarryingCosts,
      acquisition_costs: acquisitionCosts,
    },
  };
}
