/**
 * Zone-median price signal — unit tests (#184).
 *
 * Mocks `@/lib/analytics/area-price`'s `computeAreaPriceComparison` so this
 * exercises ONLY `buildAreaPriceSignal`'s own decision tree (silence rules,
 * direction narrowing, bucketing) — never the real SQL, which is
 * area-price.ts's own job (and, separately, this issue's own real-DB proof
 * that the "insufficient comparables" path renders nothing — see
 * price-signal.integration.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockComputeAreaPriceComparison = vi.fn();
vi.mock("@/lib/analytics/area-price", () => ({
  computeAreaPriceComparison: (...a: unknown[]) => mockComputeAreaPriceComparison(...a),
  MIN_SAMPLE_SIZE: 5,
}));

import { buildAreaPriceSignal } from "../price-signal";

function comparison(overrides: Partial<{
  area_median_price_per_m2: number | null;
  property_price_per_m2: number | null;
  pct_vs_average: number | null;
  sample_size: number;
}> = {}) {
  return {
    area_median_price_per_m2: 2000,
    property_price_per_m2: 1500,
    pct_vs_average: -0.25,
    sample_size: 12,
    ...overrides,
  };
}

beforeEach(() => {
  mockComputeAreaPriceComparison.mockReset();
});

describe("buildAreaPriceSignal — silence rules (#184 requirement 2)", () => {
  it("returns undefined when area-price.ts itself returns null (property has no lat/lon/property_type)", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(null);
    expect(await buildAreaPriceSignal(1)).toBeUndefined();
  });

  it("returns undefined when pct_vs_average is null (insufficient comparables, or no own price/m2)", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(
      comparison({ pct_vs_average: null, area_median_price_per_m2: null, sample_size: 3 }),
    );
    expect(await buildAreaPriceSignal(1)).toBeUndefined();
  });

  it("never renders a null/zero/fabricated stand-in — the return is strictly undefined, not an empty or placeholder string", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ pct_vs_average: null }));
    const result = await buildAreaPriceSignal(1);
    expect(result).toBe(undefined);
    expect(result).not.toBe(""); // an empty string would still be falsy-but-wrong to hand callers
    expect(result).not.toBe(null);
  });
});

describe("buildAreaPriceSignal — direction narrowing (below-market only)", () => {
  it("returns undefined when the property is priced ABOVE the zone median", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ pct_vs_average: 0.3 }));
    expect(await buildAreaPriceSignal(1)).toBeUndefined();
  });

  it("returns undefined when the property is priced EXACTLY AT the zone median", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ pct_vs_average: 0 }));
    expect(await buildAreaPriceSignal(1)).toBeUndefined();
  });

  it("renders a signal when the property is priced BELOW the zone median", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ pct_vs_average: -0.3 }));
    const result = await buildAreaPriceSignal(1);
    expect(result).toBeDefined();
    expect(result).toContain("por debajo");
  });
});

describe("buildAreaPriceSignal — percentage bucketing (10-point bands)", () => {
  it("buckets -0.21 and -0.28 into the SAME band (both in 20-30)", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ pct_vs_average: -0.21, sample_size: 12 }));
    const a = await buildAreaPriceSignal(1);
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ pct_vs_average: -0.28, sample_size: 12 }));
    const b = await buildAreaPriceSignal(1);
    expect(a).toBe(b);
    expect(a).toContain("20-30");
  });

  it("buckets -0.28 and -0.31 into DIFFERENT bands (20-30 vs 30-40)", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ pct_vs_average: -0.28, sample_size: 12 }));
    const a = await buildAreaPriceSignal(1);
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ pct_vs_average: -0.31, sample_size: 12 }));
    const b = await buildAreaPriceSignal(1);
    expect(a).not.toBe(b);
    expect(a).toContain("20-30");
    expect(b).toContain("30-40");
  });

  it("a tiny below-market discount (-0.02) still renders, bucketed to 0-10", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ pct_vs_average: -0.02, sample_size: 12 }));
    const result = await buildAreaPriceSignal(1);
    expect(result).toContain("0-10");
  });
});

describe("buildAreaPriceSignal — sample-size bucketing", () => {
  it("buckets sample_size=5 and sample_size=9 into the SAME tier (5-9)", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ sample_size: 5 }));
    const a = await buildAreaPriceSignal(1);
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ sample_size: 9 }));
    const b = await buildAreaPriceSignal(1);
    expect(a).toBe(b);
    expect(a).toContain("5-9");
  });

  it("buckets sample_size=9 and sample_size=10 into DIFFERENT tiers (5-9 vs 10-19)", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ sample_size: 9 }));
    const a = await buildAreaPriceSignal(1);
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ sample_size: 10 }));
    const b = await buildAreaPriceSignal(1);
    expect(a).not.toBe(b);
    expect(a).toContain("5-9");
    expect(b).toContain("10-19");
  });

  it("a large sample size (200) renders the open-ended top tier (20+)", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ sample_size: 200 }));
    const result = await buildAreaPriceSignal(1);
    expect(result).toContain("20+");
  });

  it("never renders the exact sample_size verbatim (that's the churn #184's docstring rejects)", async () => {
    mockComputeAreaPriceComparison.mockResolvedValueOnce(comparison({ sample_size: 17 }));
    const result = await buildAreaPriceSignal(1);
    // 17 itself must not appear — only its bucket (10-19) should.
    expect(result).not.toMatch(/\b17\b/);
    expect(result).toContain("10-19");
  });
});
