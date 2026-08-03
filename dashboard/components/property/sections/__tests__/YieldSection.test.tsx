// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { YieldSection } from "../YieldSection";
import type { InvestmentMetrics } from "@/lib/investment-metrics";

function baseMetrics(overrides: Partial<InvestmentMetrics> = {}): InvestmentMetrics {
  return {
    area_price: {
      area_avg_price_per_m2: 2400,
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
        rate_pct: 3,
        term_years: 25,
        financing_is_default: false,
        operating_cost_pct: 25,
        operating_cost_pct_is_default: true,
        carrying_costs_source: "assumed",
        annual_carrying_costs_eur: 2400,
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

  it("renders the no-rent-assumption empty state and NO yield figures when the profile has no rent assumption", () => {
    const metrics = baseMetrics({
      rent_estimate: {
        estimated_monthly_rent: null,
        comparable_count: 0,
        confidence: null,
        method: "no_rent_assumption",
        eur_per_m2_month_used: null,
        m2_used: null,
      },
      yield: {
        gross_yield_pct: null,
        net_yield_pct: null,
        cash_on_cash_pct: null,
        rent_confidence: null,
        rent_method: "no_rent_assumption",
        estimated_monthly_rent: null,
        assumptions_used: null,
      },
    });
    render(<YieldSection metrics={metrics} />);
    expect(screen.getByTestId("yield-empty-state")).toBeDefined();
    expect(screen.queryByTestId("gross-yield")).toBeNull();
    expect(screen.queryByTestId("estimated-rent")).toBeNull();
    expect(screen.getByText(/sin estimaci.n de alquiler/i)).toBeDefined();
    // Area-price comparison is independent of rent and still renders.
    expect(screen.getByTestId("area-price-comparison")).toBeDefined();
  });

  it("renders the insufficient-comparables state instead of a noisy area-price comparison", () => {
    const metrics = baseMetrics({
      area_price: { area_avg_price_per_m2: null, property_price_per_m2: 3000, pct_vs_average: null, sample_size: 2 },
    });
    render(<YieldSection metrics={metrics} />);
    expect(screen.getByTestId("area-price-insufficient")).toBeDefined();
    expect(screen.queryByTestId("area-price-comparison")).toBeNull();
  });

  it("shows the resolved comunidad autónoma and flags an unrecognized region distinctly", () => {
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
    // Assumptions are collapsed behind a <details> — its content is still
    // present in the DOM (testing-library's getByText doesn't filter by
    // CSS visibility), so no need to simulate opening it here. Both the
    // inline ITP line and the standalone warning mention "no reconocida" —
    // getAllByText, not getByText, since more than one element matches.
    expect(screen.getAllByText(/no reconocida/i).length).toBeGreaterThanOrEqual(2);
  });
});
