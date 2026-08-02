import { describe, it, expect } from "vitest";
import { buildScopeWhereClause } from "../scope-query";
import type { Scope } from "@/lib/profiles-schema";

function baseScope(overrides: Partial<Scope> = {}): Scope {
  return {
    geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
    property_types: ["piso"],
    hard_exclusions: {},
    ...overrides,
  };
}

describe("buildScopeWhereClause", () => {
  it("includes a NULL-safe Haversine geography condition parameterized with lat, lon, radius in order", () => {
    const { whereSql, params } = buildScopeWhereClause(baseScope());
    expect(whereSql).toContain("property.lat IS NOT NULL AND property.lon IS NOT NULL");
    expect(whereSql).toMatch(/<= \$3/);
    expect(params.slice(0, 3)).toEqual([40.4168, -3.7038, 5]);
  });

  it("filters property_type with = ANY over a text[] param", () => {
    const { whereSql, params } = buildScopeWhereClause(
      baseScope({ property_types: ["piso", "atico"] }),
    );
    expect(whereSql).toContain("property.property_type = ANY($4::text[])");
    expect(params[3]).toEqual(["piso", "atico"]);
  });

  it("omits size/price conditions entirely when unset (no dangling AND, no null params)", () => {
    const { whereSql, params } = buildScopeWhereClause(baseScope());
    expect(whereSql).not.toContain("m2_built");
    expect(whereSql).not.toContain("current_price");
    expect(params).not.toContain(null);
    expect(params).not.toContain(undefined);
  });

  it("filters m2_built (not m2_useful) for size_min/size_max", () => {
    const { whereSql, params } = buildScopeWhereClause(
      baseScope({ size_min: 40, size_max: 90 }),
    );
    // $1-$3 geography, $4 property_types, so size starts at $5.
    expect(whereSql).toContain("property.m2_built >= $5");
    expect(whereSql).toContain("property.m2_built <= $6");
    expect(whereSql).not.toContain("m2_useful");
    expect(params.slice(4)).toEqual([40, 90]);
  });

  it("filters price against MIN(current_price) across active listings via a scalar subquery, not a JOIN", () => {
    const { whereSql, params } = buildScopeWhereClause(
      baseScope({ price_min: 100000, price_max: 300000 }),
    );
    expect(whereSql).toContain("SELECT MIN(listing.current_price) FROM listing");
    expect(whereSql).toContain("listing.property_id = property.id");
    expect(whereSql).toContain("listing.status = 'active'");
    expect(params.slice(4)).toEqual([100000, 300000]);
  });

  it("applies only the provided half of a price/size band (price_min without price_max)", () => {
    const { whereSql, params } = buildScopeWhereClause(baseScope({ price_min: 150000 }));
    expect(whereSql).toContain(">= $5");
    expect(whereSql).not.toContain("<= $6");
    expect(params[4]).toBe(150000);
  });

  it("requires_elevator excludes properties without a known elevator (IS TRUE, not = true)", () => {
    const { whereSql } = buildScopeWhereClause(
      baseScope({ hard_exclusions: { requires_elevator: true } }),
    );
    // IS TRUE (not `= true`) so a NULL has_elevator (unknown) is correctly
    // excluded rather than matching via NULL = true's UNKNOWN-is-falsy quirk
    // being accidentally relied upon instead of stated explicitly.
    expect(whereSql).toContain("property.has_elevator IS TRUE");
  });

  it("excludes_ground_floor treats NULL/unknown floor as NOT ground floor (included, not excluded)", () => {
    const { whereSql, params } = buildScopeWhereClause(
      baseScope({ hard_exclusions: { excludes_ground_floor: true } }),
    );
    expect(whereSql).toContain("LOWER(COALESCE(property.floor, ''))");
    expect(params.at(-1)).toBe("bajo");
  });

  it("omits hard_exclusions conditions when unset or false", () => {
    const { whereSql: withEmpty } = buildScopeWhereClause(baseScope({ hard_exclusions: {} }));
    expect(withEmpty).not.toContain("has_elevator");
    expect(withEmpty).not.toContain("floor");

    const { whereSql: withFalse } = buildScopeWhereClause(
      baseScope({
        hard_exclusions: { requires_elevator: false, excludes_ground_floor: false },
      }),
    );
    expect(withFalse).not.toContain("has_elevator");
    expect(withFalse).not.toContain("floor");
  });

  it("composes a full scope into a single AND-joined WHERE fragment with correctly sequential $n placeholders", () => {
    const { whereSql, params } = buildScopeWhereClause(
      baseScope({
        price_min: 100000,
        price_max: 400000,
        size_min: 40,
        size_max: 120,
        hard_exclusions: { requires_elevator: true, excludes_ground_floor: true },
      }),
    );
    // Every placeholder used must correspond to exactly one param, positionally.
    const placeholders = [...whereSql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const maxPlaceholder = Math.max(...placeholders);
    expect(maxPlaceholder).toBe(params.length);
    expect(new Set(placeholders).size).toBe(params.length);
  });

  it("throws rather than silently matching everything for an unsupported geography type", () => {
    const bad = {
      ...baseScope(),
      geography: { type: "polygon" } as unknown as Scope["geography"],
    };
    expect(() => buildScopeWhereClause(bad)).toThrow();
  });
});
