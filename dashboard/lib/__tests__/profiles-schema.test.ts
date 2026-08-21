/**
 * Unit tests for the unfiltered-scope sentinels (issue #659, D-147):
 * `geography: {type:"everywhere"}` and `property_types: "all"` as STATED
 * values — never an absent/optional field (D-013's whole point). These
 * assert the actual parse BEHAVIOUR, not just that a sentinel "looks
 * valid" — a scope missing either field must still fail loudly.
 *
 * scopesEqual's sentinel-transition behaviour (the D-040 quick-refresh gate)
 * is covered alongside the rest of scopesEqual's cases in
 * lib/__tests__/scopes-equal.test.ts, not duplicated here.
 */
import { describe, it, expect } from "vitest";
import { ScopeSchema } from "../profiles-schema";

describe("ScopeSchema — unfiltered sentinels (issue #659)", () => {
  it("accepts geography: {type: 'everywhere'}", () => {
    const result = ScopeSchema.safeParse({
      geography: { type: "everywhere" },
      property_types: ["piso"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts property_types: 'all'", () => {
    const result = ScopeSchema.safeParse({
      geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
      property_types: "all",
    });
    expect(result.success).toBe(true);
  });

  it("accepts BOTH sentinels together (the intended novedades-profile shape)", () => {
    const result = ScopeSchema.safeParse({
      geography: { type: "everywhere" },
      property_types: "all",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an everywhere geography carrying extra radius fields (strict discriminated union)", () => {
    const result = ScopeSchema.safeParse({
      geography: { type: "everywhere", center: [40.4168, -3.7038], radius_km: 5 },
      property_types: "all",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown property_types string other than 'all'", () => {
    const result = ScopeSchema.safeParse({
      geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
      property_types: "everything",
    });
    expect(result.success).toBe(false);
  });

  // D-013's actual load-bearing behaviour: this is what must survive.
  it("still rejects a scope with geography ABSENT — D-013 fails loudly, not silently", () => {
    const result = ScopeSchema.safeParse({
      property_types: ["piso"],
    });
    expect(result.success).toBe(false);
  });

  it("still rejects a scope with property_types ABSENT", () => {
    const result = ScopeSchema.safeParse({
      geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
    });
    expect(result.success).toBe(false);
  });

  it("still rejects the historical DB column default '{}' entirely", () => {
    const result = ScopeSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("still rejects an empty property_types array (the sentinel is the ONLY way to mean 'everything')", () => {
    const result = ScopeSchema.safeParse({
      geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
      property_types: [],
    });
    expect(result.success).toBe(false);
  });
});
