import { describe, it, expect, vi } from "vitest";
import { DEFAULT_REFURB_COST_BANDS } from "../renovation-estimate";
import { DEFAULT_SALE_HOLDING_COST_PCT } from "../flip-margin";

// Loader-unavailable path (schema file missing in some build contexts): every
// key falls through to its code default rather than throwing.
vi.mock("@/lib/system-config/loader", () => ({
  getSystemConfig: () => {
    throw new Error("schema not found");
  },
}));

describe("loadFlipConfig — loader unavailable", () => {
  it("degrades to the code defaults", async () => {
    const { loadFlipConfig } = await import("../flip-config");
    const c = loadFlipConfig();
    expect(c.refurbBands.leve_eur_per_m2).toBe(DEFAULT_REFURB_COST_BANDS.leve_eur_per_m2);
    expect(c.refurbBands.integral_eur_per_m2).toBe(DEFAULT_REFURB_COST_BANDS.integral_eur_per_m2);
    expect(c.refurbBands.unknown_eur_per_m2).toBe(DEFAULT_REFURB_COST_BANDS.unknown_eur_per_m2);
    expect(c.saleHoldingCostPct).toBe(DEFAULT_SALE_HOLDING_COST_PCT);
  });
});
