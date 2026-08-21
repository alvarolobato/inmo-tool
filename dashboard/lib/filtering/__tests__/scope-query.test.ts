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

  // Regression test for a real bug (PR #57 review): the active-listing
  // requirement previously lived only inside the price-band subquery, so a
  // profile with no price filter had no status requirement at all and
  // could materialize sold/withdrawn/expired properties as candidates.
  it("requires at least one active SALE listing unconditionally, even with no price band set", () => {
    const { whereSql } = buildScopeWhereClause(baseScope());
    // "AND listing.operation = 'sale'" (issue #31): every search profile
    // is a sale-candidate thesis; without this, a rental property (no
    // active sale listing at all, only an active RENT one) would pass
    // this EXISTS on the strength of its rent listing and materialize as
    // if it were a sale candidate. See rent-estimate.ts's module
    // docstring for the full cross-contamination reasoning.
    expect(whereSql).toContain(
      "EXISTS (SELECT 1 FROM listing WHERE listing.property_id = property.id AND listing.status = 'active' AND listing.operation = 'sale')",
    );
  });

  it("omits size/price conditions entirely when unset (no dangling AND, no null params)", () => {
    const { whereSql, params } = buildScopeWhereClause(baseScope());
    expect(whereSql).not.toContain("m2_built");
    expect(whereSql).not.toContain("current_price");
    expect(params).not.toContain(null);
    expect(params).not.toContain(undefined);
  });

  it("filters m2_built (not m2_useful) for size_min/size_max, via the #28 extract fallback", () => {
    const { whereSql, params } = buildScopeWhereClause(
      baseScope({ size_min: 40, size_max: 90 }),
    );
    // #182: the size band now coalesces property.m2_built with a
    // high-confidence extracted value, but property.m2_built still wins when
    // present (COALESCE order) and the extract subquery binds no params, so
    // $1-$3 geography, $4 property_types, size still at $5/$6.
    expect(whereSql).toContain("COALESCE(property.m2_built, (SELECT (ax.result->>'m2_built')::numeric");
    expect(whereSql).toMatch(/>= \$5/);
    expect(whereSql).toMatch(/<= \$6/);
    // The confidence gate (issue #182 EC-1/EC-2) is on the m2_built field.
    expect(whereSql).toContain("confidence_per_field'->>'m2_built')::numeric >= 0.6");
    expect(whereSql).not.toContain("m2_useful");
    expect(params.slice(4)).toEqual([40, 90]);
  });

  it("filters price against MIN(current_price) across active SALE listings via a scalar subquery, not a JOIN", () => {
    const { whereSql, params } = buildScopeWhereClause(
      baseScope({ price_min: 100000, price_max: 300000 }),
    );
    expect(whereSql).toContain("SELECT MIN(listing.current_price) FROM listing");
    expect(whereSql).toContain("listing.property_id = property.id");
    expect(whereSql).toContain("listing.status = 'active'");
    // issue #31: without this, a rental property's monthly rent (an order
    // of magnitude below any sale price) could pass a price-band filter
    // meant for purchase prices.
    expect(whereSql).toContain("listing.operation = 'sale'");
    expect(params.slice(4)).toEqual([100000, 300000]);
  });

  it("applies only the provided half of a price/size band (price_min without price_max)", () => {
    const { whereSql, params } = buildScopeWhereClause(baseScope({ price_min: 150000 }));
    expect(whereSql).toContain(">= $5");
    expect(whereSql).not.toContain("<= $6");
    expect(params[4]).toBe(150000);
  });

  it("requires_elevator excludes ONLY a confidently-known missing elevator (IS NOT FALSE), consulting the #28 extract fallback", () => {
    const { whereSql } = buildScopeWhereClause(
      baseScope({ hard_exclusions: { requires_elevator: true } }),
    );
    // #182 EC-2: `IS NOT FALSE`, not `IS TRUE`. A hard exclusion removes only
    // what is KNOWN-bad (same rule excludes_ground_floor applies to an
    // unpublished floor). A NULL/unknown elevator — including a
    // below-threshold extraction the fallback drops — is kept, not rejected;
    // only property.has_elevator=false or a >= 0.6 extraction of false
    // excludes.
    expect(whereSql).toContain("COALESCE(property.has_elevator, (SELECT (ax.result->>'has_elevator')::boolean");
    expect(whereSql).toContain("IS NOT FALSE");
    expect(whereSql).toContain("confidence_per_field'->>'has_elevator')::numeric >= 0.6");
    expect(whereSql).not.toContain("property.has_elevator IS TRUE");
  });

  it("excludes_ground_floor treats NULL/unknown floor as NOT ground floor (included, not excluded), consulting the #28 extract fallback", () => {
    const { whereSql, params } = buildScopeWhereClause(
      baseScope({ hard_exclusions: { excludes_ground_floor: true } }),
    );
    // #182: floor now coalesces property.floor with a high-confidence
    // extracted value before the ground-floor comparison; property.floor
    // still wins when present, and both-NULL still resolves to '' <> 'bajo'
    // (kept, not excluded). The extract subquery binds no params, so 'bajo'
    // is still the last positional param.
    expect(whereSql).toContain("LOWER(COALESCE(COALESCE(property.floor, (SELECT (ax.result->>'floor')");
    expect(whereSql).toContain("confidence_per_field'->>'floor')::numeric >= 0.6");
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

  // Regression test for a real bug (PR #57): the Haversine expression is
  // assembled from several hand-concatenated string fragments, and an
  // earlier draft dropped a separator between two of them, producing SQL
  // like "$1cos(radians(..." — a plain missing-space/operator typo, not a
  // build-tool artifact (see the corrected root-cause note on `ph()` above).
  // That defect only surfaced by hitting a real running container; this
  // test exists so a similar concatenation mistake fails here instead.
  it("produces a well-formed Haversine expression with no missing separators between fragments", () => {
    const { whereSql } = buildScopeWhereClause(baseScope());

    // A placeholder or a closing paren must never be immediately followed
    // by an identifier character with no operator/space/paren between them
    // (the exact shape of the "$1cos(radians(" corruption).
    expect(whereSql).not.toMatch(/\$\d+[a-zA-Z]/);
    expect(whereSql).not.toMatch(/\)[a-zA-Z]/);

    // Every '(' must have a matching ')' — a dropped fragment boundary in
    // string concatenation commonly manifests as unbalanced parens too.
    const opens = (whereSql.match(/\(/g) ?? []).length;
    const closes = (whereSql.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);

    // Pin the exact known-good shape of the multi-part Haversine expression
    // so any future hand-edit to the fragment list is caught immediately.
    expect(whereSql).toContain(
      "(6371 * acos(least(1, greatest(-1, " +
        "cos(radians($1)) * cos(radians(property.lat)) * " +
        "cos(radians(property.lon) - radians($2)) + " +
        "sin(radians($1)) * sin(radians(property.lat))" +
        "))))",
    );
  });
});

/**
 * Issue #659/D-147: the unfiltered-scope sentinels. Four combinations —
 * radius+list (already covered above), everywhere+list, radius+all,
 * everywhere+all — each asserted on ACTUAL SQL-shape behaviour, not just
 * that the sentinel parses (the decorative trap the issue explicitly warns
 * against): the unconditional active-SALE EXISTS must survive every
 * combination (D-016), the haversine/lat-lon clause must be ABSENT for
 * "everywhere", and the ANY(...) type clause must be ABSENT for "all" —
 * never bound as NULL.
 */
describe("buildScopeWhereClause — unfiltered sentinels (issue #659)", () => {
  const SALE_EXISTS =
    "EXISTS (SELECT 1 FROM listing WHERE listing.property_id = property.id AND listing.status = 'active' AND listing.operation = 'sale')";

  it("everywhere + explicit types: no haversine/lat-lon clause, sale EXISTS survives, ANY(...) type clause present", () => {
    const { whereSql, params } = buildScopeWhereClause(
      baseScope({ geography: { type: "everywhere" }, property_types: ["piso"] }),
    );
    expect(whereSql).not.toContain("property.lat");
    expect(whereSql).not.toContain("property.lon");
    expect(whereSql).not.toMatch(/acos/);
    expect(whereSql).toContain(SALE_EXISTS);
    expect(whereSql).toContain("property.property_type = ANY(");
    expect(params).toEqual([["piso"]]);
  });

  it("radius + 'all' types: haversine clause present, sale EXISTS survives, NO ANY(...) clause, no NULL bound", () => {
    const { whereSql, params } = buildScopeWhereClause(baseScope({ property_types: "all" }));
    expect(whereSql).toContain("property.lat IS NOT NULL AND property.lon IS NOT NULL");
    expect(whereSql).toContain(SALE_EXISTS);
    expect(whereSql).not.toContain("property.property_type = ANY(");
    // Only the 3 geography params (lat, lon, radius) — never a 4th
    // undefined/null property_types bind.
    expect(params).toEqual([40.4168, -3.7038, 5]);
    expect(params).not.toContain(undefined);
    expect(params).not.toContain(null);
  });

  it("everywhere + 'all': ONLY the unconditional sale EXISTS — no geography clause, no type clause, no params at all", () => {
    const { whereSql, params } = buildScopeWhereClause(
      baseScope({ geography: { type: "everywhere" }, property_types: "all" }),
    );
    expect(whereSql).toBe(SALE_EXISTS);
    expect(params).toEqual([]);
  });

  it("everywhere geography never throws (only a truly unrecognised type does)", () => {
    expect(() =>
      buildScopeWhereClause(baseScope({ geography: { type: "everywhere" } })),
    ).not.toThrow();
  });

  it("price/size/exclusions stages still compose correctly on top of an everywhere+all base", () => {
    const { whereSql, params } = buildScopeWhereClause(
      baseScope({
        geography: { type: "everywhere" },
        property_types: "all",
        price_max: 200000,
        hard_exclusions: { requires_elevator: true },
      }),
    );
    expect(whereSql).toContain(SALE_EXISTS);
    expect(whereSql).toContain("<= $" + params.length); // price_max is the last param
    expect(whereSql).toContain("IS NOT FALSE"); // requires_elevator
    // Every placeholder still maps 1:1 to a param — no gaps introduced by
    // omitting the geography/type clauses.
    const placeholders = [...whereSql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(new Set(placeholders).size).toBe(params.length);
    expect(Math.max(...placeholders)).toBe(params.length);
  });
});
