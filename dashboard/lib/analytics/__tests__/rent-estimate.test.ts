import { describe, it, expect } from "vitest";
import { estimateRent } from "../rent-estimate";

describe("estimateRent", () => {
  it("computes estimated_monthly_rent = eur_per_m2_month * m2_built when a profile assumption is set", () => {
    const result = estimateRent(
      { m2_built: 80 },
      { rent_assumption: { eur_per_m2_month: 12.5 } },
    );
    expect(result.method).toBe("profile_assumption");
    expect(result.confidence).toBe("assumption");
    expect(result.estimated_monthly_rent).toBeCloseTo(1000, 6); // 80 * 12.5
    expect(result.eur_per_m2_month_used).toBe(12.5);
    expect(result.m2_used).toBe(80);
    expect(result.comparable_count).toBe(0);
  });

  it("returns the explicit no-assumption result — not a fabricated number — when the profile has no rent_assumption set", () => {
    const result = estimateRent({ m2_built: 80 }, {});
    expect(result.method).toBe("no_rent_assumption");
    expect(result.confidence).toBeNull();
    expect(result.estimated_monthly_rent).toBeNull();
    expect(result.eur_per_m2_month_used).toBeNull();
    expect(result.m2_used).toBeNull();
  });

  // Opus review fix: previously collapsed into "no_rent_assumption", which
  // told the user to set a rent assumption they had ALREADY set — wrong
  // instruction, since it's the property's own m2_built that's missing.
  // "no_property_size" is a distinct method value so the UI can render
  // correct, non-misleading copy for this case.
  it("gates on missing m2_built even when a rent assumption is set — returns 'no_property_size', NOT 'no_rent_assumption'", () => {
    const result = estimateRent({ m2_built: null }, { rent_assumption: { eur_per_m2_month: 12.5 } });
    expect(result.method).toBe("no_property_size");
    expect(result.method).not.toBe("no_rent_assumption");
    expect(result.estimated_monthly_rent).toBeNull();
  });

  it("gates on a zero/negative m2_built (bad data) rather than dividing/multiplying into a nonsensical rent — also 'no_property_size'", () => {
    const result = estimateRent({ m2_built: 0 }, { rent_assumption: { eur_per_m2_month: 12.5 } });
    expect(result.method).toBe("no_property_size");
    expect(result.estimated_monthly_rent).toBeNull();
  });

  it("returns 'no_rent_assumption' (not 'no_property_size') when the assumption itself is unset, even if m2_built is also missing", () => {
    const result = estimateRent({ m2_built: null }, {});
    expect(result.method).toBe("no_rent_assumption");
  });

  // Mutation-style check: two different assumptions on the same property
  // must produce two different (correctly scaled) rents, not a constant.
  it("scales linearly with the assumed €/m²/month figure", () => {
    const low = estimateRent({ m2_built: 100 }, { rent_assumption: { eur_per_m2_month: 8 } });
    const high = estimateRent({ m2_built: 100 }, { rent_assumption: { eur_per_m2_month: 16 } });
    expect(high.estimated_monthly_rent).toBeCloseTo(2 * (low.estimated_monthly_rent ?? 0), 6);
  });
});
