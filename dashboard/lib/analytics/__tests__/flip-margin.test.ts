import { describe, it, expect } from "vitest";
import {
  computeFlipMargin,
  computeFlipMetrics,
  DEFAULT_SALE_HOLDING_COST_PCT,
  type FlipMetricsConfig,
} from "../flip-margin";

const CONFIG: FlipMetricsConfig = {
  refurbBands: { leve_eur_per_m2: 400, integral_eur_per_m2: 900, unknown_eur_per_m2: 650 },
  saleHoldingCostPct: 10,
};

describe("computeFlipMargin", () => {
  it("computes margin = ARV − price − refurb − buffer and margin % on total cash out", () => {
    // ARV 280,000, price 200,000, refurb 32,000, buffer 10% of price = 20,000.
    const r = computeFlipMargin(280000, 200000, 32000, 10);
    expect(r.computable).toBe(true);
    expect(r.transaction_buffer_eur).toBe(20000);
    expect(r.margin_eur).toBe(28000); // 280000 - 200000 - 32000 - 20000
    // margin_pct = 28000 / (200000 + 32000 + 20000) = 28000 / 252000
    expect(r.margin_pct).toBeCloseTo(28000 / 252000, 10);
  });

  it("surfaces every component even when the margin is negative", () => {
    const r = computeFlipMargin(150000, 200000, 50000, 10);
    expect(r.computable).toBe(true);
    expect(r.arv_eur).toBe(150000);
    expect(r.purchase_price).toBe(200000);
    expect(r.refurb_cost_eur).toBe(50000);
    expect(r.margin_eur).toBeLessThan(0);
  });

  it("treats a real zero refurb (reformado) as computable", () => {
    const r = computeFlipMargin(280000, 200000, 0, 10);
    expect(r.computable).toBe(true);
    expect(r.margin_eur).toBe(60000); // 280000 - 200000 - 0 - 20000
  });

  it("degrades cleanly when an input is missing — never NaN or a partial margin", () => {
    const noArv = computeFlipMargin(null, 200000, 32000, 10);
    expect(noArv.computable).toBe(false);
    expect(noArv.margin_eur).toBeNull();
    expect(noArv.basis).toMatch(/ARV/);

    const noRefurb = computeFlipMargin(280000, 200000, null, 10);
    expect(noRefurb.computable).toBe(false);
    expect(noRefurb.margin_eur).toBeNull();
    expect(noRefurb.basis).toMatch(/reforma/i);

    const noPrice = computeFlipMargin(280000, null, 32000, 10);
    expect(noPrice.computable).toBe(false);
    expect(noPrice.transaction_buffer_eur).toBeNull();
    expect(noPrice.basis).toMatch(/precio/i);
  });

  it("rejects a non-positive price", () => {
    const r = computeFlipMargin(280000, 0, 32000, 10);
    expect(r.computable).toBe(false);
  });

  it("defaults the buffer pct when not provided", () => {
    const r = computeFlipMargin(280000, 200000, 32000);
    expect(r.transaction_buffer_pct).toBe(DEFAULT_SALE_HOLDING_COST_PCT);
  });

  it("clamps a negative buffer pct to 0", () => {
    const r = computeFlipMargin(280000, 200000, 32000, -5);
    expect(r.transaction_buffer_eur).toBe(0);
    expect(r.transaction_buffer_pct).toBe(0);
  });
});

describe("computeFlipMetrics (composition)", () => {
  it("wires renovation + ARV + margin together end to end", () => {
    const m = computeFlipMetrics(
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
    expect(m.renovation.total_eur).toBe(32000); // 400 * 80
    expect(m.arv.arv_eur).toBe(280000); // 3500 * 80
    expect(m.arv.confidence).toBe("high");
    expect(m.margin.computable).toBe(true);
    expect(m.margin.margin_eur).toBe(28000);
  });

  it("degrades the whole chain gracefully when the condition assessment is missing", () => {
    const m = computeFlipMetrics(
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
    // ARV still computes (comps + m² exist), but no refurb estimate → no margin.
    expect(m.renovation.tier).toBe("no_estimate");
    expect(m.arv.arv_eur).toBe(280000);
    expect(m.margin.computable).toBe(false);
    expect(m.margin.margin_eur).toBeNull();
  });

  it("still computes a margin for an already-reformado flip (refurb 0)", () => {
    const m = computeFlipMetrics(
      {
        condition: "reformado",
        severity: null,
        m2: 80,
        purchasePrice: 200000,
        areaMedianPricePerM2: 3500,
        sampleSize: 20,
      },
      CONFIG,
    );
    expect(m.renovation.total_eur).toBe(0);
    expect(m.margin.computable).toBe(true);
    expect(m.margin.margin_eur).toBe(60000); // 280000 - 200000 - 0 - 20000
  });
});
