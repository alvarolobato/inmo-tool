import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadFlipConfig } from "../flip-config";
import { resetConfigCache } from "@/lib/system-config/loader";

describe("loadFlipConfig", () => {
  beforeEach(() => resetConfigCache());
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
  });

  it("reads env-var overrides (highest precedence)", () => {
    vi.stubEnv("FLIP_REFURB_COST_LEVE_EUR_M2", "500");
    vi.stubEnv("FLIP_REFURB_COST_INTEGRAL_EUR_M2", "1200");
    vi.stubEnv("FLIP_REFURB_COST_UNKNOWN_EUR_M2", "800");
    vi.stubEnv("FLIP_SALE_HOLDING_COST_PCT", "15");
    resetConfigCache(); // pick up the stubbed env

    const c = loadFlipConfig();
    expect(c.refurbBands.leve_eur_per_m2).toBe(500);
    expect(c.refurbBands.integral_eur_per_m2).toBe(1200);
    expect(c.refurbBands.unknown_eur_per_m2).toBe(800);
    expect(c.saleHoldingCostPct).toBe(15);
  });

  it("returns a well-formed numeric config from schema defaults", () => {
    const c = loadFlipConfig();
    expect(typeof c.refurbBands.leve_eur_per_m2).toBe("number");
    expect(typeof c.refurbBands.integral_eur_per_m2).toBe("number");
    expect(typeof c.refurbBands.unknown_eur_per_m2).toBe("number");
    // integral is the heaviest band by construction.
    expect(c.refurbBands.integral_eur_per_m2).toBeGreaterThanOrEqual(c.refurbBands.leve_eur_per_m2);
    expect(c.saleHoldingCostPct).toBeGreaterThanOrEqual(0);
  });
});
