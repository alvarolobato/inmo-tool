// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { YieldSection } from "../YieldSection";
import type { InvestmentMetrics } from "@/lib/investment-metrics";

function baseMetrics(overrides: Partial<InvestmentMetrics> = {}): InvestmentMetrics {
  return {
    area_price: {
      area_median_price_per_m2: 2400,
      property_price_per_m2: 3000,
      pct_vs_average: 0.25,
      sample_size: 5,
    },
    rent_estimate: {
      estimated_monthly_rent: 800,
      comparable_count: 0,
      confidence: "assumption",
      method: "profile_assumption",
      eur_per_m2_month_used: 10,
      m2_used: 80,
      market_comparable: null,
      assumption_monthly_rent: 800,
      disagreement_pct: null,
    },
    yield: {
      gross_yield_pct: 4.8,
      net_yield_pct: 3.6,
      cash_on_cash_pct: 1.5,
      rent_confidence: "assumption",
      rent_method: "profile_assumption",
      estimated_monthly_rent: 800,
      assumptions_used: {
        down_payment_pct: 20,
        down_payment_pct_is_default: false,
        rate_pct: 3,
        rate_pct_is_default: true,
        term_years: 25,
        term_years_is_default: true,
        operating_cost_pct: 25,
        operating_cost_pct_is_default: true,
        maintenance_vacancy_pct: 8,
        maintenance_vacancy_pct_is_default: true,
        carrying_costs_source: "assumed",
        ibi_known: false,
        community_fee_known: false,
        annual_carrying_costs_eur: 2400,
        net_yield_excludes_acquisition_costs: true,
        acquisition_costs: {
          purchase_price: 200000,
          comunidad_autonoma: "Madrid",
          province_recognized: true,
          itp_is_override: false,
          itp_pct: 6,
          itp_eur: 12000,
          notary_pct: 0.3,
          notary_eur: 600,
          registry_pct: 0.2,
          registry_eur: 400,
          gestoria_eur: 300,
          total_eur: 13300,
          total_pct_of_price: 0.0665,
          rates_last_verified: "2026-08-03",
        },
      },
    },
    ...overrides,
  };
}

describe("YieldSection", () => {
  it("renders the populated state with every yield figure labelled as an estimate", () => {
    render(<YieldSection metrics={baseMetrics()} />);
    expect(screen.getByTestId("estimated-rent")).toBeDefined();
    expect(screen.getByTestId("gross-yield")).toBeDefined();
    expect(screen.getByTestId("net-yield")).toBeDefined();
    expect(screen.getByTestId("cash-on-cash")).toBeDefined();
    // 4 figures, 4 "estimado" badges — none rendered as a bare, unlabeled number.
    expect(screen.getAllByTestId("estimate-badge")).toHaveLength(4);
  });

  it("renders a muted confidence badge for an 'assumption'-tier rent estimate", () => {
    render(<YieldSection metrics={baseMetrics()} />);
    const badge = screen.getByTestId("rent-confidence-badge");
    expect(badge.getAttribute("data-confidence")).toBe("assumption");
    expect(badge.getAttribute("data-muted")).toBe("true");
  });

  it("renders a non-muted confidence badge for a 'high'-tier rent estimate (issue #33 EC-4)", () => {
    const metrics = baseMetrics({
      rent_estimate: {
        ...baseMetrics().rent_estimate,
        confidence: "high",
      },
      yield: { ...baseMetrics().yield, rent_confidence: "high" },
    });
    render(<YieldSection metrics={metrics} />);
    const badge = screen.getByTestId("rent-confidence-badge");
    expect(badge.getAttribute("data-confidence")).toBe("high");
    expect(badge.getAttribute("data-muted")).toBe("false");
  });

  it("renders the insufficient-data empty state and NO yield figures when there is no assumption AND not enough market comparables", () => {
    const metrics = baseMetrics({
      rent_estimate: {
        estimated_monthly_rent: null,
        comparable_count: 0,
        confidence: null,
        method: "insufficient_data",
        eur_per_m2_month_used: null,
        m2_used: null,
        market_comparable: { eur_per_m2_month: null, estimated_monthly_rent: null, comparable_count: 2, confidence: null, oldest_comp_age_days: 5 },
        assumption_monthly_rent: null,
        disagreement_pct: null,
      },
      yield: {
        gross_yield_pct: null,
        net_yield_pct: null,
        cash_on_cash_pct: null,
        rent_confidence: null,
        rent_method: "insufficient_data",
        estimated_monthly_rent: null,
        assumptions_used: null,
      },
    });
    render(<YieldSection metrics={metrics} />);
    expect(screen.getByTestId("yield-empty-state")).toBeDefined();
    expect(screen.queryByTestId("gross-yield")).toBeNull();
    expect(screen.queryByTestId("estimated-rent")).toBeNull();
    expect(screen.getByText(/sin estimaci.n de alquiler/i)).toBeDefined();
    // The comparable count that WAS found (2, below the gate) is surfaced,
    // not silently dropped just because it wasn't enough to use.
    expect(screen.getByText(/2 encontrados/i)).toBeDefined();
    // Area-price comparison is independent of rent and still renders.
    expect(screen.getByTestId("area-price-comparison")).toBeDefined();
  });

  it("renders a distinct empty state when the property has no coordinates/type and no assumption is set (can't even attempt a market query)", () => {
    const metrics = baseMetrics({
      rent_estimate: {
        estimated_monthly_rent: null,
        comparable_count: 0,
        confidence: null,
        method: "no_property_location",
        eur_per_m2_month_used: null,
        m2_used: null,
        market_comparable: null,
        assumption_monthly_rent: null,
        disagreement_pct: null,
      },
      yield: {
        gross_yield_pct: null,
        net_yield_pct: null,
        cash_on_cash_pct: null,
        rent_confidence: null,
        rent_method: "no_property_location",
        estimated_monthly_rent: null,
        assumptions_used: null,
      },
    });
    render(<YieldSection metrics={metrics} />);
    expect(screen.getByTestId("yield-empty-state-no-location")).toBeDefined();
    expect(screen.queryByTestId("yield-empty-state")).toBeNull();
    expect(screen.getByText(/no tiene coordenadas o tipo de vivienda/i)).toBeDefined();
  });

  it("renders the measured market estimate as PRIMARY (no assumption set) with the high-confidence label", () => {
    const metrics = baseMetrics({
      rent_estimate: {
        estimated_monthly_rent: 800,
        comparable_count: 8,
        confidence: "high",
        method: "market_comparable_high",
        eur_per_m2_month_used: 10,
        m2_used: 80,
        market_comparable: { eur_per_m2_month: 10, estimated_monthly_rent: 800, comparable_count: 8, confidence: "high", oldest_comp_age_days: 12 },
        assumption_monthly_rent: null,
        disagreement_pct: null,
      },
      yield: { ...baseMetrics().yield, rent_confidence: "high", rent_method: "market_comparable_high" },
    });
    render(<YieldSection metrics={metrics} />);
    expect(screen.getByText(/comparables de mercado\)/i)).toBeDefined();
    const badge = screen.getByTestId("rent-confidence-badge");
    expect(badge.getAttribute("data-confidence")).toBe("high");
    // The market comparable IS the primary row here — no separate
    // secondary "market comparison" line duplicating it.
    expect(screen.queryByTestId("market-comparable-comparison")).toBeNull();
    // Opus review must-fix #5 (PR #199): when the market estimate IS the
    // primary figure, MarketComparableBlock renders null (see above), so
    // this was previously the ONE case where the sample size backing the
    // yield never appeared anywhere on the page. The primary row itself
    // must now say "8" (comparable_count), not just show a confidence
    // badge with no number behind it.
    const primaryRow = screen.getByTestId("estimated-rent").closest("div");
    expect(primaryRow?.textContent).toMatch(/8\s*comparables/i);
  });

  it("shows both figures and a disagreement warning when the profile's assumption and the market comparable disagree materially", () => {
    const metrics = baseMetrics({
      rent_estimate: {
        estimated_monthly_rent: 960, // 12 EUR/m2 * 80 m2 (the assumption, primary)
        comparable_count: 0,
        confidence: "assumption",
        method: "profile_assumption",
        eur_per_m2_month_used: 12,
        m2_used: 80,
        market_comparable: { eur_per_m2_month: 10, estimated_monthly_rent: 800, comparable_count: 8, confidence: "high", oldest_comp_age_days: 3 },
        assumption_monthly_rent: 960,
        disagreement_pct: 0.2, // (960-800)/800
      },
    });
    render(<YieldSection metrics={metrics} />);
    // PRIMARY row still shows the assumption (960), never silently
    // replaced by the measured 800.
    expect(screen.getByTestId("estimated-rent").textContent).toMatch(/960/);
    const comparison = screen.getByTestId("market-comparable-comparison");
    expect(comparison.textContent).toMatch(/800/);
    expect(comparison.textContent).toMatch(/20,0\s*%/);
    expect(comparison.getAttribute("data-disagreement-warning")).toBe("true"); // 20% >= 15% threshold
  });

  it("shows the market comparison WITHOUT a warning treatment when the disagreement is small", () => {
    const metrics = baseMetrics({
      rent_estimate: {
        ...baseMetrics().rent_estimate,
        market_comparable: { eur_per_m2_month: 9.8, estimated_monthly_rent: 784, comparable_count: 8, confidence: "high", oldest_comp_age_days: 3 },
        disagreement_pct: (800 - 784) / 784, // ~2%, well under the 15% threshold
      },
    });
    render(<YieldSection metrics={metrics} />);
    const comparison = screen.getByTestId("market-comparable-comparison");
    expect(comparison.getAttribute("data-disagreement-warning")).toBe("false");
  });

  // Opus review fix (PR #181), extended by issue #31: a profile that DOES
  // have a rent assumption but whose property lacks m2_built previously
  // fell into the exact same "no_rent_assumption" branch and told the user
  // to set something they'd already set. rent-estimate.ts now returns a
  // distinct "no_property_size" method — and since #31, m2_built gates
  // BOTH the assumption path and the market-comparable path, so the copy
  // must be generically correct (not assume an assumption exists) rather
  // than reference a specific rent source.
  it("renders a distinct empty state (not the assumption-specific copy) when the property lacks m2_built, regardless of rent source", () => {
    const metrics = baseMetrics({
      rent_estimate: {
        estimated_monthly_rent: null,
        comparable_count: 0,
        confidence: null,
        method: "no_property_size",
        eur_per_m2_month_used: null,
        m2_used: null,
        market_comparable: null,
        assumption_monthly_rent: null,
        disagreement_pct: null,
      },
      yield: {
        gross_yield_pct: null,
        net_yield_pct: null,
        cash_on_cash_pct: null,
        rent_confidence: null,
        rent_method: "no_property_size",
        estimated_monthly_rent: null,
        assumptions_used: null,
      },
    });
    render(<YieldSection metrics={metrics} />);
    expect(screen.getByTestId("yield-empty-state-no-size")).toBeDefined();
    expect(screen.queryByTestId("yield-empty-state")).toBeNull();
    // Must NOT tell the user to add a rent assumption (that isn't the gate here).
    expect(screen.queryByText(/a.ade.*asunci.n de alquiler/i)).toBeNull();
    expect(screen.getByText(/no tiene superficie construida/i)).toBeDefined();
  });

  it("renders the insufficient-comparables state instead of a noisy area-price comparison", () => {
    const metrics = baseMetrics({
      area_price: { area_median_price_per_m2: null, property_price_per_m2: 3000, pct_vs_average: null, sample_size: 2 },
    });
    render(<YieldSection metrics={metrics} />);
    expect(screen.getByTestId("area-price-insufficient")).toBeDefined();
    expect(screen.queryByTestId("area-price-comparison")).toBeNull();
  });

  // Opus review fix: "media" (mean) vs "mediana" (median) — the field IS a
  // median (PERCENTILE_CONT(0.5)) but the delta text used to say "media".
  it("labels the area-price delta as 'mediana', never 'media' (mean) — the underlying figure is a median", () => {
    render(<YieldSection metrics={baseMetrics()} />);
    expect(screen.getByTestId("area-price-delta").textContent).toMatch(/mediana/i);
    expect(screen.getByTestId("area-price-delta").textContent).not.toMatch(/\bmedia\b/i);
  });

  // Opus review must-fix #8: fmtEUR0 rounds 12,5 -> "13 €", which reads as
  // 1.040 EUR/mes next to an actual 1.000 EUR/mes. Must show 2 decimals.
  it("shows the €/m²/month rent rate with 2 decimals, not rounded to a whole euro", () => {
    const metrics = baseMetrics({
      rent_estimate: { ...baseMetrics().rent_estimate, eur_per_m2_month_used: 12.5, m2_used: 80 },
    });
    render(<YieldSection metrics={metrics} />);
    const row = screen.getByTestId("estimated-rent").closest("div");
    expect(row?.textContent).toMatch(/12,5\d?\s*€/);
    expect(row?.textContent).not.toMatch(/13\s*€\s*\/m²\/mes/);
  });

  // Opus review must-fix #6: gross/net yield and cash-on-cash use different
  // denominators (purchase price vs. total cash invested) — each row must
  // say so, not just show a bare percentage.
  it("labels each yield figure's denominator distinctly", () => {
    render(<YieldSection metrics={baseMetrics()} />);
    expect(screen.getByText(/yield bruto \(sobre precio de compra\)/i)).toBeDefined();
    expect(screen.getByText(/yield neto sobre precio de compra/i)).toBeDefined();
    expect(screen.getByText(/cash-on-cash \(sobre entrada \+ gastos de adquisici.n\)/i)).toBeDefined();
  });

  // Opus review must-fix #7: carrying_costs_source was previously an OR —
  // "only community fee known" rendered identically to "both known". The
  // label must state precisely which of IBI/community were actual.
  it("labels a partially-known carrying cost precisely (community fee real, IBI not published) instead of a blanket 'reales'", () => {
    const metrics = baseMetrics({
      yield: {
        ...baseMetrics().yield,
        assumptions_used: {
          ...baseMetrics().yield.assumptions_used!,
          carrying_costs_source: "actual",
          ibi_known: false,
          community_fee_known: true,
        },
      },
    });
    render(<YieldSection metrics={metrics} />);
    const netYieldRow = screen.getByTestId("net-yield").closest("div");
    expect(netYieldRow?.textContent).toMatch(/comunidad real/i);
    expect(netYieldRow?.textContent).toMatch(/ibi no publicado/i);
    // Must not claim IBI is real when it isn't known.
    expect(netYieldRow?.textContent).not.toMatch(/ibi real/i);
  });

  it("labels a fully-known carrying cost as such (both IBI and community fee real)", () => {
    const metrics = baseMetrics({
      yield: {
        ...baseMetrics().yield,
        assumptions_used: {
          ...baseMetrics().yield.assumptions_used!,
          carrying_costs_source: "actual",
          ibi_known: true,
          community_fee_known: true,
        },
      },
    });
    render(<YieldSection metrics={metrics} />);
    const netYieldRow = screen.getByTestId("net-yield").closest("div");
    expect(netYieldRow?.textContent).toMatch(/ibi real/i);
    expect(netYieldRow?.textContent).toMatch(/comunidad real/i);
  });

  // Opus review fix: financing_is_default was one blanket flag; setting
  // only down_payment_pct silently made rate_pct/term_years read as
  // user-chosen. Each field must carry its own "(por defecto)" suffix.
  it("labels only the financing fields that were actually left at their system default", () => {
    render(<YieldSection metrics={baseMetrics()} />);
    // Expand assumptions detail — its content is present in the DOM
    // regardless of <details> open state (jsdom doesn't hide it from
    // text queries), matching this suite's existing convention.
    const detail = screen.getByTestId("assumptions-detail");
    // down_payment_pct_is_default: false -> no suffix on that figure.
    expect(detail.textContent).toMatch(/20% entrada,/);
    expect(detail.textContent).not.toMatch(/20% entrada \(por defecto\)/);
    // rate_pct_is_default / term_years_is_default: true -> suffixed.
    expect(detail.textContent).toMatch(/3% interés \(por defecto\)/);
    expect(detail.textContent).toMatch(/25 años \(por defecto\)/);
  });

  // Opus review must-fix #3: the unrecognized-province warning must be
  // VISIBLE in the main flow, not only present inside a closed-by-default
  // <details> block. Unlike the previous version of this test (which only
  // asserted DOM presence via getByText — the exact gap the review
  // flagged), this asserts `toBeVisible()` on a warning OUTSIDE the
  // <details>.
  it("shows a visible (not collapsed-only) warning when the province is unrecognized", () => {
    const metrics = baseMetrics({
      yield: {
        ...baseMetrics().yield,
        assumptions_used: {
          ...baseMetrics().yield.assumptions_used!,
          acquisition_costs: {
            ...baseMetrics().yield.assumptions_used!.acquisition_costs,
            comunidad_autonoma: null,
            province_recognized: false,
          },
        },
      },
    });
    render(<YieldSection metrics={metrics} />);
    const warning = screen.getByTestId("province-unrecognized-warning");
    // The key assertion: visible, not merely present in the DOM behind a
    // closed <details>. jsdom's toBeVisible checks computed CSS
    // (display/visibility/hidden ancestors) — a <details><summary> closed
    // state hides its non-summary children from this check, so this test
    // would fail if the warning were still nested inside <details>.
    expect(warning).toBeVisible();
    expect(screen.getAllByText(/no reconocida/i).length).toBeGreaterThanOrEqual(2);
  });
});
