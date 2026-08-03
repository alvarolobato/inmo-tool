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
 * ## Carrying costs (#151): additive, not a full replacement (revised after
 * Opus review, 2026-08)
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
 * **This module's first version read "used... rather than estimated" as a
 * full REPLACEMENT of the entire `operating_cost_pct` line** (IBI +
 * community + maintenance + vacancy all zeroed out the moment any one
 * actual figure was known). An Opus review caught that this inverts the
 * sign of cash-on-cash on real numbers: Solvia listings that publish only
 * a community fee (dropping IBI, maintenance, AND vacancy entirely) looked
 * *better* than equivalent listings that publish nothing at all and fall
 * back to the full assumed 25% — a systematic, directional bias in favour
 * of whichever portal happens to publish partial cost data. That is a
 * worse fabrication than the "invented sub-split" this module originally
 * tried to avoid, because it has a known, exploitable direction (issue #1
 * §11's fabricated-precision concern is about UNDIRECTED noise, not a
 * bias that always points the same way).
 *
 * **Revised model**: actual carrying-cost fields REPLACE only the specific
 * cost category they cover (IBI, community fee), and a SEPARATE,
 * independently-sourced `DEFAULT_MAINTENANCE_VACANCY_PCT` is always added
 * on top — whether or not any actual data is known — because no source in
 * this schema publishes maintenance or vacancy figures, actual or
 * otherwise. This is NOT the "sub-split the bundled 25%" idea D-009
 * originally rejected (inventing what fraction of the 25% is
 * "IBI's share"): `DEFAULT_MAINTENANCE_VACANCY_PCT` is its own
 * independently-cited rule-of-thumb (property-management guidance
 * typically budgets 5-10% of gross rent for maintenance + vacancy alone,
 * independent of a region's actual tax/community-fee costs), applied the
 * same way regardless of how much of the IBI/community pair is known.
 * When NEITHER IBI nor community fee is known, the full
 * `operating_cost_pct` (25% default, already understood to bundle
 * everything) is used instead of assumed-IBI + assumed-community +
 * assumed-maintenance/vacancy, to avoid stacking three independent
 * assumptions where one bundled one already existed.
 *
 * Every result reports exactly which of IBI/community were actual via
 * `ibi_known`/`community_fee_known`, plus `carrying_costs_source`
 * ("actual" whenever ANY real figure was used, "assumed" only when
 * neither was) — see must-fix #7 in the same review: `carrying_costs_source`
 * alone was previously an OR that let "only the community fee is real"
 * render identically to "both are real," so the UI must read the two
 * booleans, not just the coarse enum, to label precisely what's known.
 *
 * `operating_cost_pct` itself is unchanged from #33 — no second
 * configuration mechanism was added for the no-actual-data branch: it's
 * still `thesis_params.financing.operating_cost_pct`, just only applied
 * when neither IBI nor community fee is known.
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

/**
 * Percentage of GROSS annual rent assumed for maintenance + vacancy ONLY —
 * applied ON TOP OF actual IBI/community-fee figures whenever at least one
 * of them is known (see module docstring's "additive, not a full
 * replacement" revision). No source in this schema publishes maintenance
 * or vacancy data, actual or estimated, so this line is always an
 * assumption regardless of how much of the IBI/community pair is real.
 * 8% is the midpoint of the "5-10% of gross rent for maintenance+vacancy
 * combined" range commonly cited in property-management guidance — a
 * SEPARATE, independently-sourced figure, not a derived share of
 * `DEFAULT_OPERATING_COST_PCT` (D-009 explicitly rejected inventing what
 * fraction of the bundled 25% is "the maintenance/vacancy part").
 */
export const DEFAULT_MAINTENANCE_VACANCY_PCT = 8;

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
  down_payment_pct_is_default: boolean;
  rate_pct: number;
  rate_pct_is_default: boolean;
  term_years: number;
  term_years_is_default: boolean;
  operating_cost_pct: number;
  operating_cost_pct_is_default: boolean;
  maintenance_vacancy_pct: number;
  maintenance_vacancy_pct_is_default: boolean;
  /** "actual" whenever at least one of IBI/community fee is a real published figure; "assumed" only when NEITHER is known (issue #151 must-fix #7: don't collapse "one of two known" and "both known" into one label — see ibi_known/community_fee_known for the precise breakdown). */
  carrying_costs_source: "actual" | "assumed";
  /** True when `annual_ibi_eur` came from a listing's `raw_extra`, not the assumed bundle. */
  ibi_known: boolean;
  /** True when `monthly_community_fee_eur` came from a listing's `raw_extra`, not the assumed bundle. */
  community_fee_known: boolean;
  annual_carrying_costs_eur: number;
  acquisition_costs: AcquisitionCostBreakdown;
  /** Denominator convention, since must-fix #6 requires every yield figure to state what it's measured against: gross/net yield divide by purchase_price alone (acquisition costs excluded — standard rental-yield convention); cash-on-cash divides by purchase_price*down_payment_pct + acquisition_costs.total_eur (the actual cash an investor puts in). Echoed here so the UI never has to hardcode this fact in two places. */
  net_yield_excludes_acquisition_costs: true;
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
  // Per-field default flags, NOT one blanket "financing_is_default" — a
  // profile that set only `down_payment_pct` (financing object present,
  // but rate_pct/term_years never touched by the user) must still report
  // those two fields as system defaults, not as user-chosen values (Opus
  // review must-fix: "financing_is_default is only true when the whole
  // object is absent, so setting down_payment_pct alone silently inherits
  // 3%/25y while the UI reports them as user-set"). Each financing field
  // in ThesisParamsSchema is independently optional (see profiles-schema.ts)
  // specifically so this per-field undefined check is meaningful.
  const downPaymentPctIsDefault = financing?.down_payment_pct === undefined;
  const ratePctIsDefault = financing?.rate_pct === undefined;
  const termYearsIsDefault = financing?.term_years === undefined;
  const downPaymentPct = financing?.down_payment_pct ?? DEFAULT_FINANCING.down_payment_pct;
  const ratePct = financing?.rate_pct ?? DEFAULT_FINANCING.rate_pct;
  const termYears = financing?.term_years ?? DEFAULT_FINANCING.term_years;
  const operatingCostPctIsDefault = financing?.operating_cost_pct === undefined;
  const operatingCostPct = financing?.operating_cost_pct ?? DEFAULT_OPERATING_COST_PCT;
  const maintenanceVacancyPctIsDefault = financing?.maintenance_vacancy_pct === undefined;
  const maintenanceVacancyPct = financing?.maintenance_vacancy_pct ?? DEFAULT_MAINTENANCE_VACANCY_PCT;

  const annualGrossRent = rentEstimate.estimated_monthly_rent * 12;
  const grossYieldPct = (annualGrossRent / property.purchase_price) * 100;

  // Additive model (revised after Opus review — see module docstring):
  // actual IBI/community fee replace ONLY their own line; maintenance +
  // vacancy is always a separate assumption layered on top, because no
  // source publishes it. Only when NEITHER IBI nor community is known do
  // we fall back to the single bundled `operatingCostPct` (covers IBI +
  // community + maintenance + vacancy together) instead of stacking three
  // independent per-category assumptions on top of each other.
  const ibiKnown = carryingCostsKnown.annual_ibi_eur !== null;
  const communityFeeKnown = carryingCostsKnown.monthly_community_fee_eur !== null;
  const hasActualCarrying = ibiKnown || communityFeeKnown;
  const annualCarryingCosts = hasActualCarrying
    ? (carryingCostsKnown.annual_ibi_eur ?? 0) +
      (carryingCostsKnown.monthly_community_fee_eur ?? 0) * 12 +
      (maintenanceVacancyPct / 100) * annualGrossRent
    : (operatingCostPct / 100) * annualGrossRent;

  const annualNetRent = annualGrossRent - annualCarryingCosts;
  // Net yield, like gross yield, divides by purchase_price alone — the
  // standard rental-yield convention (acquisition costs are NOT folded in
  // here; only cash-on-cash below includes them, since cash-on-cash is
  // specifically "return on cash actually deployed," a different question
  // than "return on the asset's price"). See
  // `net_yield_excludes_acquisition_costs` in the result and must-fix #6:
  // the UI must label this denominator so it never reads as if
  // acquisition costs were already netted out of it.
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
      down_payment_pct_is_default: downPaymentPctIsDefault,
      rate_pct: ratePct,
      rate_pct_is_default: ratePctIsDefault,
      term_years: termYears,
      term_years_is_default: termYearsIsDefault,
      operating_cost_pct: operatingCostPct,
      operating_cost_pct_is_default: operatingCostPctIsDefault,
      maintenance_vacancy_pct: maintenanceVacancyPct,
      maintenance_vacancy_pct_is_default: maintenanceVacancyPctIsDefault,
      carrying_costs_source: hasActualCarrying ? "actual" : "assumed",
      ibi_known: ibiKnown,
      community_fee_known: communityFeeKnown,
      annual_carrying_costs_eur: annualCarryingCosts,
      acquisition_costs: acquisitionCosts,
      net_yield_excludes_acquisition_costs: true,
    },
  };
}
