/**
 * Unit tests for `scopesEqual` — the gate that decides whether a profile save
 * enqueues a quick-refresh crawl (issue #245). These are the mutation-check
 * for "only on a real scope change": each case pins one axis so that flipping
 * the comparison (e.g. dropping the property_types check, or treating
 * false/undefined as different) fails a test.
 */
import { describe, it, expect } from "vitest";
import { scopesEqual, type Scope } from "@/lib/profiles-schema";

const BASE: Scope = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
  property_types: ["piso"],
  hard_exclusions: {},
};

/** Deep clone so a test can mutate without touching BASE. */
function clone(s: Scope): Scope {
  return JSON.parse(JSON.stringify(s));
}

describe("scopesEqual — identical", () => {
  it("a scope equals itself", () => {
    expect(scopesEqual(BASE, clone(BASE))).toBe(true);
  });
});

describe("scopesEqual — geography", () => {
  it("a radius change is NOT equal", () => {
    const b = clone(BASE);
    b.geography.radius_km = 10;
    expect(scopesEqual(BASE, b)).toBe(false);
  });

  it("a center-latitude change is NOT equal", () => {
    const b = clone(BASE);
    b.geography.center = [41.0, -3.7038];
    expect(scopesEqual(BASE, b)).toBe(false);
  });

  it("a center-longitude change is NOT equal", () => {
    const b = clone(BASE);
    b.geography.center = [40.4168, -3.0];
    expect(scopesEqual(BASE, b)).toBe(false);
  });
});

describe("scopesEqual — property_types (set semantics)", () => {
  it("reordering property_types IS equal (order carries no meaning)", () => {
    const a: Scope = { ...clone(BASE), property_types: ["piso", "local"] };
    const b: Scope = { ...clone(BASE), property_types: ["local", "piso"] };
    expect(scopesEqual(a, b)).toBe(true);
  });

  it("adding a property_type is NOT equal", () => {
    const b: Scope = { ...clone(BASE), property_types: ["piso", "local"] };
    expect(scopesEqual(BASE, b)).toBe(false);
  });

  it("swapping the single type is NOT equal", () => {
    const b: Scope = { ...clone(BASE), property_types: ["local"] };
    expect(scopesEqual(BASE, b)).toBe(false);
  });
});

describe("scopesEqual — numeric bounds", () => {
  it("a price_max change is NOT equal", () => {
    const b = clone(BASE);
    b.price_max = 300000;
    expect(scopesEqual(BASE, b)).toBe(false);
  });

  it("a size_min change is NOT equal", () => {
    const b = clone(BASE);
    b.size_min = 50;
    expect(scopesEqual(BASE, b)).toBe(false);
  });

  it("same explicit bound IS equal", () => {
    const a = clone(BASE);
    a.price_max = 250000;
    const b = clone(BASE);
    b.price_max = 250000;
    expect(scopesEqual(a, b)).toBe(true);
  });
});

describe("scopesEqual — hard_exclusions (false == absent)", () => {
  it("an absent exclusions block equals an explicit-false one (toggle on then off)", () => {
    const a: Scope = { ...clone(BASE), hard_exclusions: {} };
    const b: Scope = { ...clone(BASE), hard_exclusions: { requires_elevator: false } };
    expect(scopesEqual(a, b)).toBe(true);
  });

  it("undefined hard_exclusions equals an explicit empty one", () => {
    const a = clone(BASE);
    delete (a as { hard_exclusions?: unknown }).hard_exclusions;
    expect(scopesEqual(a, { ...clone(BASE), hard_exclusions: {} })).toBe(true);
  });

  it("turning an exclusion ON is NOT equal", () => {
    const b: Scope = { ...clone(BASE), hard_exclusions: { requires_elevator: true } };
    expect(scopesEqual(BASE, b)).toBe(false);
  });
});

// Issue #659/D-147: the unfiltered-scope sentinels. A radius<->everywhere or
// list<->"all" transition IS a scope change — it changes which properties
// can match (drops the haversine clause / the ANY() clause), so D-040's
// quick refresh (re-materialize + full sweep) must fire on it exactly like
// a real radius/center/type-list edit does above.
describe("scopesEqual — everywhere/all sentinels (issue #659)", () => {
  it("radius -> everywhere is NOT equal", () => {
    const b: Scope = { ...clone(BASE), geography: { type: "everywhere" } };
    expect(scopesEqual(BASE, b)).toBe(false);
  });

  it("everywhere -> everywhere (identical) IS equal", () => {
    const a: Scope = { geography: { type: "everywhere" }, property_types: ["piso"], hard_exclusions: {} };
    const b: Scope = { geography: { type: "everywhere" }, property_types: ["piso"], hard_exclusions: {} };
    expect(scopesEqual(a, b)).toBe(true);
  });

  it("explicit types -> 'all' is NOT equal", () => {
    const b: Scope = { ...clone(BASE), property_types: "all" };
    expect(scopesEqual(BASE, b)).toBe(false);
  });

  it("'all' -> 'all' (identical) IS equal", () => {
    const a: Scope = { ...clone(BASE), property_types: "all" };
    const b: Scope = { ...clone(BASE), property_types: "all" };
    expect(scopesEqual(a, b)).toBe(true);
  });

  it("'all' is NOT equal to an explicit list naming every single type — different STATED scopes", () => {
    const a: Scope = { ...clone(BASE), property_types: "all" };
    const b: Scope = {
      ...clone(BASE),
      property_types: ["piso", "chalet", "atico", "local", "nave", "garaje", "terreno", "edificio"],
    };
    expect(scopesEqual(a, b)).toBe(false);
  });
});
