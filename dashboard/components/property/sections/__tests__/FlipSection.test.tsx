// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlipSection } from "../FlipSection";
import type { InvestmentMetrics } from "@/lib/investment-metrics";
import { computeFlipMetrics, type FlipMetrics } from "@/lib/analytics/flip-margin";

const CONFIG = {
  refurbBands: { leve_eur_per_m2: 400, integral_eur_per_m2: 900, unknown_eur_per_m2: 650 },
  saleHoldingCostPct: 10,
};

/** Minimal InvestmentMetrics with a given flip block; yield left un-estimated. */
function metrics(flip: FlipMetrics | null, netYieldPct: number | null = 3.6): InvestmentMetrics {
  return {
    area_price: null,
    rent_estimate: {
      estimated_monthly_rent: null,
      comparable_count: 0,
      confidence: "assumption",
      method: "profile_assumption",
      eur_per_m2_month_used: null,
      m2_used: null,
      market_comparable: null,
      assumption_monthly_rent: null,
      disagreement_pct: null,
    },
    yield: {
      gross_yield_pct: netYieldPct === null ? null : 4.8,
      net_yield_pct: netYieldPct,
      cash_on_cash_pct: netYieldPct === null ? null : 1.5,
      rent_confidence: "assumption",
      rent_method: "profile_assumption",
      estimated_monthly_rent: netYieldPct === null ? null : 800,
      assumptions_used:
        netYieldPct === null
          ? null
          : ({} as unknown as NonNullable<InvestmentMetrics["yield"]["assumptions_used"]>),
    },
    flip,
  };
}

const FULL_FLIP = computeFlipMetrics(
  {
    condition: "a_reformar",
    severity: "leve",
    m2: 80,
    purchasePrice: 200000,
    areaMedianPricePerM2: 3500,
    sampleSize: 20,
  },
  CONFIG,
);

describe("FlipSection", () => {
  it("renders nothing when flip metrics are absent (non-flip profile)", () => {
    const { container } = render(<FlipSection metrics={metrics(null)} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the refurb/ARV/margin breakdown with each component visible", () => {
    render(<FlipSection metrics={metrics(FULL_FLIP)} />);
    expect(screen.getByTestId("flip-section-content")).toBeDefined();
    expect(screen.getByTestId("flip-refurb-cost")).toHaveAttribute("data-tier", "leve");
    expect(screen.getByTestId("flip-arv")).toBeDefined();
    // EC-2: ARV, price, refurb, buffer, and the total each render separately.
    expect(screen.getByTestId("flip-margin")).toHaveAttribute("data-computable", "true");
    expect(screen.getByTestId("flip-margin-arv")).toBeDefined();
    expect(screen.getByTestId("flip-margin-price")).toBeDefined();
    expect(screen.getByTestId("flip-margin-refurb")).toBeDefined();
    expect(screen.getByTestId("flip-margin-buffer")).toBeDefined();
    expect(screen.getByTestId("flip-margin-total")).toBeDefined();
  });

  it("shows the buy-to-rent comparison alongside", () => {
    render(<FlipSection metrics={metrics(FULL_FLIP, 3.6)} />);
    expect(screen.getByTestId("flip-vs-rent")).toBeDefined();
    expect(screen.getByTestId("flip-vs-rent-yield").textContent).toMatch(/%/);
  });

  it("shows 'sin estimación de alquiler' when no yield is available", () => {
    render(<FlipSection metrics={metrics(FULL_FLIP, null)} />);
    expect(screen.getByTestId("flip-vs-rent-yield").textContent).toMatch(/sin estimaci[oó]n/i);
  });

  it("degrades to a clean 'sin estimación' margin when inputs are missing", () => {
    const degraded = computeFlipMetrics(
      {
        condition: null,
        severity: null,
        m2: 80,
        purchasePrice: 200000,
        areaMedianPricePerM2: 3500,
        sampleSize: 20,
      },
      CONFIG,
    );
    render(<FlipSection metrics={metrics(degraded)} />);
    // ARV still renders, but no margin — no crash, no garbage number.
    expect(screen.getByTestId("flip-margin")).toHaveAttribute("data-computable", "false");
    expect(screen.getByTestId("flip-margin-none").textContent).toMatch(/sin margen/i);
    expect(screen.getByTestId("flip-refurb-cost").textContent).toMatch(/sin estimaci[oó]n/i);
  });

  it("always labels the figures as a rough estimate, not a quote (EC-4)", () => {
    render(<FlipSection metrics={metrics(FULL_FLIP)} />);
    expect(screen.getByTestId("flip-disclaimer").textContent).toMatch(/no es una tasaci[oó]n/i);
  });
});
