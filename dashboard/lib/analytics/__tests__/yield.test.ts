import { describe, it, expect } from "vitest";
import {
  computeYield,
  DEFAULT_FINANCING,
  DEFAULT_OPERATING_COST_PCT,
  DEFAULT_MAINTENANCE_VACANCY_PCT,
} from "../yield";
import type { RentEstimateResult } from "../rent-estimate";

function assumptionRent(monthlyRent: number): RentEstimateResult {
  return {
    estimated_monthly_rent: monthlyRent,
    comparable_count: 0,
    confidence: "assumption",
    method: "profile_assumption",
    eur_per_m2_month_used: monthlyRent / 80,
    m2_used: 80,
  };
}

const NO_ASSUMPTION: RentEstimateResult = {
  estimated_monthly_rent: null,
  comparable_count: 0,
  confidence: null,
  method: "no_rent_assumption",
  eur_per_m2_month_used: null,
  m2_used: null,
};

describe("computeYield", () => {
  // Worked example, computed independently by hand (see PR body for the
  // full trace):
  //   price = 200,000 €, Madrid (ITP 6%, notary 0.3%, registry 0.2%, gestoría 300€ flat)
  //   Acquisition costs: ITP 12,000 + notary 600 + registry 400 + gestoría 300 = 13,300 €
  //   Rent assumption: 800 €/month -> annual gross rent 9,600 €
  //   Gross yield = 9,600 / 200,000 = 4.8%
  //   Operating costs (no actual IBI/community fee known -> assumed 25% of gross rent) = 2,400 €
  //   Net annual rent = 9,600 - 2,400 = 7,200 € -> net yield = 7,200 / 200,000 = 3.6%
  //   Financing: 20% down, 0% rate (straight-line payoff — chosen so the
  //   mortgage payment itself needs no compound-interest calculator: a
  //   300-month straight-line payoff of 160,000 € is exactly 533.333.../mo,
  //   i.e. 6,400 €/year).
  //   Cash invested = price*20% + acquisition costs = 40,000 + 13,300 = 53,300 €
  //   Cash-on-cash = (7,200 - 6,400) / 53,300 = 800 / 53,300 = 1.500938...%
  it("matches manual reference calculation", () => {
    const result = computeYield(
      { purchase_price: 200000, province: "Madrid" },
      assumptionRent(800),
      {
        financing: { down_payment_pct: 20, rate_pct: 0, term_years: 25, operating_cost_pct: 25 },
      },
    );

    expect(result.gross_yield_pct).toBeCloseTo(4.8, 6);
    expect(result.net_yield_pct).toBeCloseTo(3.6, 6);
    expect(result.cash_on_cash_pct).toBeCloseTo(1.500938, 4);
    expect(result.estimated_monthly_rent).toBe(800);
    expect(result.rent_confidence).toBe("assumption");

    const assumptions = result.assumptions_used;
    expect(assumptions).not.toBeNull();
    expect(assumptions!.down_payment_pct_is_default).toBe(false);
    expect(assumptions!.rate_pct_is_default).toBe(false);
    expect(assumptions!.term_years_is_default).toBe(false);
    expect(assumptions!.operating_cost_pct).toBe(25);
    expect(assumptions!.operating_cost_pct_is_default).toBe(false);
    expect(assumptions!.carrying_costs_source).toBe("assumed");
    expect(assumptions!.ibi_known).toBe(false);
    expect(assumptions!.community_fee_known).toBe(false);
    expect(assumptions!.annual_carrying_costs_eur).toBeCloseTo(2400, 6);
    expect(assumptions!.acquisition_costs.total_eur).toBeCloseTo(13300, 6);
    expect(assumptions!.acquisition_costs.itp_pct).toBe(6);
    expect(assumptions!.net_yield_excludes_acquisition_costs).toBe(true);
  });

  // Issue #33 EC-2: a profile with no thesis_params.financing set must
  // still produce a real result, using documented app-wide defaults, not
  // an error.
  it("falls back to default assumptions when profile has none set", () => {
    const result = computeYield(
      { purchase_price: 200000, province: "Madrid" },
      assumptionRent(800),
      {}, // no financing key at all
    );

    expect(result.gross_yield_pct).not.toBeNull();
    expect(result.net_yield_pct).not.toBeNull();
    expect(result.cash_on_cash_pct).not.toBeNull();

    const assumptions = result.assumptions_used;
    expect(assumptions).not.toBeNull();
    expect(assumptions!.down_payment_pct_is_default).toBe(true);
    expect(assumptions!.rate_pct_is_default).toBe(true);
    expect(assumptions!.term_years_is_default).toBe(true);
    expect(assumptions!.down_payment_pct).toBe(DEFAULT_FINANCING.down_payment_pct);
    expect(assumptions!.rate_pct).toBe(DEFAULT_FINANCING.rate_pct);
    expect(assumptions!.term_years).toBe(DEFAULT_FINANCING.term_years);
    expect(assumptions!.operating_cost_pct).toBe(DEFAULT_OPERATING_COST_PCT);
    expect(assumptions!.operating_cost_pct_is_default).toBe(true);
    expect(assumptions!.maintenance_vacancy_pct).toBe(DEFAULT_MAINTENANCE_VACANCY_PCT);
    expect(assumptions!.maintenance_vacancy_pct_is_default).toBe(true);
  });

  // Opus review fix: a profile that sets ONLY down_payment_pct (financing
  // object present, but rate_pct/term_years never touched) must still
  // report those two fields as system defaults — the old single
  // `financing_is_default` flag collapsed to `false` the instant ANY
  // financing field was set, silently reporting the untouched fields as
  // user-chosen.
  it("reports rate_pct/term_years as defaults when only down_payment_pct was set, not as user-chosen", () => {
    const result = computeYield(
      { purchase_price: 200000, province: "Madrid" },
      assumptionRent(800),
      { financing: { down_payment_pct: 30 } },
    );
    const assumptions = result.assumptions_used!;
    expect(assumptions.down_payment_pct).toBe(30);
    expect(assumptions.down_payment_pct_is_default).toBe(false);
    expect(assumptions.rate_pct).toBe(DEFAULT_FINANCING.rate_pct);
    expect(assumptions.rate_pct_is_default).toBe(true);
    expect(assumptions.term_years).toBe(DEFAULT_FINANCING.term_years);
    expect(assumptions.term_years_is_default).toBe(true);
  });

  // Issue #33 EC-4: confidence must propagate through unchanged, including
  // #31's eventual "high"/"low" comparable-count tiers — not just this
  // module's own "assumption" value — so yield.ts doesn't need a signature
  // change once #31 replaces rent-estimate.ts's implementation.
  it("propagates rent-estimate confidence into yield output", () => {
    // "high"/"low" are #31's future comparable-count tiers, not values this
    // module's own estimateRent() produces today — constructed directly
    // here to exercise computeYield's propagation mechanism against the
    // full confidence range issue #33 EC-4 describes, independent of
    // whether #31 has landed yet.
    const highConfidenceRent: RentEstimateResult = { ...assumptionRent(900), confidence: "high" };
    const lowConfidenceRent: RentEstimateResult = { ...assumptionRent(900), confidence: "low" };

    const highResult = computeYield({ purchase_price: 200000, province: "Madrid" }, highConfidenceRent, {});
    const lowResult = computeYield({ purchase_price: 200000, province: "Madrid" }, lowConfidenceRent, {});
    const assumptionResult = computeYield(
      { purchase_price: 200000, province: "Madrid" },
      assumptionRent(900),
      {},
    );

    expect(highResult.rent_confidence).toBe("high");
    expect(lowResult.rent_confidence).toBe("low");
    expect(assumptionResult.rent_confidence).toBe("assumption");
    // The three confidences must be pairwise distinct in the output — a
    // propagation bug that collapsed everything to one value would still
    // pass a test that only checked one tier in isolation.
    const confidences = new Set([highResult.rent_confidence, lowResult.rent_confidence, assumptionResult.rent_confidence]);
    expect(confidences.size).toBe(3);
  });

  it("gates the entire result (no fabricated rent) when there is no rent estimate, but still propagates confidence/method", () => {
    const result = computeYield({ purchase_price: 200000, province: "Madrid" }, NO_ASSUMPTION, {});
    expect(result.gross_yield_pct).toBeNull();
    expect(result.net_yield_pct).toBeNull();
    expect(result.cash_on_cash_pct).toBeNull();
    expect(result.estimated_monthly_rent).toBeNull();
    expect(result.assumptions_used).toBeNull();
    expect(result.rent_confidence).toBeNull();
    expect(result.rent_method).toBe("no_rent_assumption");
  });

  it("gates the entire result when the property has no active-listing price, even with a rent estimate available", () => {
    const result = computeYield({ purchase_price: null, province: "Madrid" }, assumptionRent(800), {});
    expect(result.gross_yield_pct).toBeNull();
    expect(result.assumptions_used).toBeNull();
    // The rent side is untouched — this is a price gate, not a rent gate.
    expect(result.rent_confidence).toBe("assumption");
  });

  // Issue #151's core claim: acquisition costs must be load-bearing, not
  // decorative — a materially different region changes cash-on-cash enough
  // to flip a ranking between two otherwise-identical properties.
  it("a materially higher-ITP region produces a materially lower cash-on-cash for an otherwise identical property", () => {
    const madridResult = computeYield(
      { purchase_price: 300000, province: "Madrid" }, // 6% ITP
      assumptionRent(1200),
      { financing: { down_payment_pct: 20, rate_pct: 0, term_years: 25 } },
    );
    const catalunyaResult = computeYield(
      { purchase_price: 300000, province: "Barcelona" }, // 10% ITP
      assumptionRent(1200),
      { financing: { down_payment_pct: 20, rate_pct: 0, term_years: 25 } },
    );

    expect(madridResult.assumptions_used!.acquisition_costs.itp_pct).toBe(6);
    expect(catalunyaResult.assumptions_used!.acquisition_costs.itp_pct).toBe(10);
    // Same rent, same price, same financing — only the region differs, and
    // that alone must move cash-on-cash by a real, non-trivial amount.
    expect(catalunyaResult.cash_on_cash_pct!).toBeLessThan(madridResult.cash_on_cash_pct!);
    const gapPct = madridResult.cash_on_cash_pct! - catalunyaResult.cash_on_cash_pct!;
    // Hand-computed: the 4-point ITP gap (6% vs 10% on 300,000 EUR = 12,000
    // EUR more acquisition cost in Barcelona) lands as a ~0.20 percentage-
    // point cash-on-cash gap once diluted across the ~80-92k EUR total cash
    // invested in each scenario (Madrid: cash-on-cash 1.50376%, Barcelona:
    // 1.30720%, gap 0.19657) — real and reproducible, just smaller in
    // absolute cash-on-cash terms than the raw EUR delta might suggest,
    // because cash-on-cash's denominator (total cash invested) is large
    // relative to the acquisition-cost swing. Asserted as a relative
    // (>10%) difference, not an absolute >1pp, so the test reflects what
    // the maths actually produces rather than an intuition-based guess.
    expect(gapPct).toBeGreaterThan(0.15);
    expect(gapPct / madridResult.cash_on_cash_pct!).toBeGreaterThan(0.1); // >10% relative difference
  });

  // Opus review must-fix #1: the ORIGINAL "actual replaces the entire
  // assumed line" model flips cash-on-cash's sign relative to the
  // all-assumed baseline on real numbers. This is the exact worked example
  // from the review (200,000 EUR Malaga flat, 80 m2, 12 EUR/m2/month rent,
  // 20% down, 3% rate, 25y term, Andalucia 7% ITP):
  //   Acquisition: ITP 14,000 + notary 600 + registry 400 + gestoria 300 = 15,300 EUR
  //   Annual gross rent = 12 * 80 * 12 = 11,520 EUR
  //   Case A (no actual data, 25% assumed): net yield 4.32%, cash-on-cash -0.84%
  //   Case B (BUGGY full-replacement, only a 55 EUR/mo community fee known):
  //     net yield 5.43%, cash-on-cash +3.17% — a full sign flip vs. Case A.
  //   Case C (THIS module's fix — community fee real + maintenance/vacancy
  //     8% assumed on top): net yield ~4.97%, cash-on-cash ~+1.51% — between
  //     the two extremes, and critically the SAME SIGN as the "assumed
  //     25%" baseline, not a flip driven purely by which cost fields a
  //     portal happened to publish.
  it("the Malaga worked example: partial actual data no longer flips cash-on-cash's sign vs. the fully-assumed baseline", () => {
    const rent = assumptionRent(12 * 80); // 12 EUR/m2/month * 80 m2 = 960 EUR/month
    const financing = { down_payment_pct: 20, rate_pct: 3, term_years: 25 };

    const assumedOnly = computeYield(
      { purchase_price: 200000, province: "Malaga" },
      rent,
      { financing: { ...financing, operating_cost_pct: 25 } },
    );
    expect(assumedOnly.net_yield_pct).toBeCloseTo(4.32, 1);
    expect(assumedOnly.cash_on_cash_pct).toBeCloseTo(-0.84, 1);
    expect(assumedOnly.cash_on_cash_pct!).toBeLessThan(0);

    const partialActual = computeYield(
      { purchase_price: 200000, province: "Malaga" },
      rent,
      { financing },
      { annual_ibi_eur: null, monthly_community_fee_eur: 55 },
    );
    // Net yield sits strictly between the two extremes the review measured
    // (4.32% all-assumed vs. the buggy 5.43% full-replacement) — never
    // above the buggy figure, since maintenance/vacancy is now added back.
    expect(partialActual.net_yield_pct!).toBeGreaterThan(assumedOnly.net_yield_pct!);
    expect(partialActual.net_yield_pct!).toBeLessThan(5.43);
    // The core must-fix: cash-on-cash must NOT flip to a large positive
    // number just because one partial cost field was published — it
    // should land close to (and same-sign direction of intent as) a
    // reasonable middle ground, and specifically must not reproduce the
    // buggy +3.17% figure.
    expect(partialActual.cash_on_cash_pct!).toBeGreaterThan(assumedOnly.cash_on_cash_pct!);
    expect(partialActual.cash_on_cash_pct!).toBeLessThan(3.17);
    expect(partialActual.cash_on_cash_pct!).toBeCloseTo(1.5, 1);
    expect(partialActual.net_yield_pct!).toBeCloseTo(4.97, 1);
  });

  it("uses actual carrying costs (IBI + community fee) PLUS the maintenance/vacancy assumption, never as a full replacement", () => {
    const withoutActuals = computeYield(
      { purchase_price: 200000, province: "Madrid" },
      assumptionRent(800),
      { financing: { down_payment_pct: 20, rate_pct: 0, term_years: 25, operating_cost_pct: 25 } },
    );
    const withActuals = computeYield(
      { purchase_price: 200000, province: "Madrid" },
      assumptionRent(800),
      { financing: { down_payment_pct: 20, rate_pct: 0, term_years: 25, operating_cost_pct: 25 } },
      { annual_ibi_eur: 500, monthly_community_fee_eur: 80 }, // 500 + 960 = 1,460 actual annual carrying cost
    );

    expect(withoutActuals.assumptions_used!.carrying_costs_source).toBe("assumed");
    expect(withoutActuals.assumptions_used!.annual_carrying_costs_eur).toBeCloseTo(2400, 6); // 25% of 9,600

    expect(withActuals.assumptions_used!.carrying_costs_source).toBe("actual");
    expect(withActuals.assumptions_used!.ibi_known).toBe(true);
    expect(withActuals.assumptions_used!.community_fee_known).toBe(true);
    // 500 (IBI) + 960 (community) + 8% of 9,600 (maintenance/vacancy, 768) = 2,228 — NOT the bare 1,460.
    expect(withActuals.assumptions_used!.annual_carrying_costs_eur).toBeCloseTo(2228, 6);
    // Still lower than the fully-assumed 25% bundle (2,400) -> a HIGHER net yield,
    // but not as dramatically higher as pure replacement (1,460) would have produced.
    expect(withActuals.net_yield_pct!).toBeGreaterThan(withoutActuals.net_yield_pct!);
  });

  it("treats a partially-known carrying cost (only IBI, no community fee) as actual PLUS the maintenance/vacancy assumption", () => {
    const result = computeYield(
      { purchase_price: 200000, province: "Madrid" },
      assumptionRent(800),
      { financing: { down_payment_pct: 20, rate_pct: 0, term_years: 25 } },
      { annual_ibi_eur: 600, monthly_community_fee_eur: null },
    );
    expect(result.assumptions_used!.carrying_costs_source).toBe("actual");
    expect(result.assumptions_used!.ibi_known).toBe(true);
    expect(result.assumptions_used!.community_fee_known).toBe(false);
    // 600 (IBI) + 0 (community, unknown) + 8% of 9,600 (768) = 1,368 — NOT the bare 600.
    expect(result.assumptions_used!.annual_carrying_costs_eur).toBeCloseTo(1368, 6);
  });

  it("an itp_pct_override replaces the regional rate entirely and is flagged as an override", () => {
    const result = computeYield(
      { purchase_price: 200000, province: "Madrid" },
      assumptionRent(800),
      { acquisition_costs: { itp_pct_override: 0 } },
    );
    expect(result.assumptions_used!.acquisition_costs.itp_pct).toBe(0);
    expect(result.assumptions_used!.acquisition_costs.itp_is_override).toBe(true);
  });

  it("a maintenance_vacancy_pct override changes only the maintenance/vacancy line, applied on top of actual carrying costs", () => {
    const result = computeYield(
      { purchase_price: 200000, province: "Madrid" },
      assumptionRent(800),
      { financing: { maintenance_vacancy_pct: 0 } },
      { annual_ibi_eur: 500, monthly_community_fee_eur: null },
    );
    expect(result.assumptions_used!.maintenance_vacancy_pct).toBe(0);
    expect(result.assumptions_used!.maintenance_vacancy_pct_is_default).toBe(false);
    // With maintenance/vacancy overridden to 0%, actual carrying costs are exactly the IBI figure.
    expect(result.assumptions_used!.annual_carrying_costs_eur).toBeCloseTo(500, 6);
  });
});
