/**
 * Unit tests for the search-URL public API + scope normaliser (issue #267).
 */

import { describe, it, expect } from "vitest";
import {
  buildSearchUrl,
  buildSearchUrls,
  canonicalScopeFromProfile,
  SEARCH_URL_PORTALS,
} from "@/lib/search-url";
import type { Scope } from "@/lib/profiles-schema";

const SCOPE: Scope = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 8 },
  property_types: ["piso", "chalet"],
  price_min: 90000,
  price_max: 250000,
  size_min: 55,
  size_max: 140,
  hard_exclusions: {},
};

describe("canonicalScopeFromProfile", () => {
  it("flattens a profile scope into portal-neutral criteria", () => {
    const c = canonicalScopeFromProfile(SCOPE);
    expect(c.center).toEqual([40.4168, -3.7038]);
    expect(c.radiusKm).toBe(8);
    expect(c.propertyTypes).toEqual(["piso", "chalet"]);
    expect(c.priceMin).toBe(90000);
    expect(c.priceMax).toBe(250000);
    expect(c.sizeMin).toBe(55);
    expect(c.sizeMax).toBe(140);
    // Profile scope carries no rooms field today.
    expect(c.roomsMin).toBeUndefined();
  });

  it("leaves absent optional bounds undefined", () => {
    const minimal: Scope = {
      geography: { type: "radius", center: [41.38, 2.17], radius_km: 5 },
      property_types: ["piso"],
      hard_exclusions: {},
    };
    const c = canonicalScopeFromProfile(minimal);
    expect(c.priceMin).toBeUndefined();
    expect(c.priceMax).toBeUndefined();
    expect(c.sizeMin).toBeUndefined();
    expect(c.sizeMax).toBeUndefined();
  });
});

describe("SEARCH_URL_PORTALS", () => {
  it("lists the capture portals that have a builder", () => {
    expect([...SEARCH_URL_PORTALS]).toEqual(["idealista", "aliseda"]);
  });
});

describe("buildSearchUrl", () => {
  it("builds one portal's URL", () => {
    const result = buildSearchUrl("idealista", SCOPE);
    expect(result).not.toBeNull();
    expect(result!.portal).toBe("idealista");
    expect(result!.url).toContain("idealista.com/areas/venta-viviendas");
  });

  it("returns null for a portal with no builder", () => {
    expect(buildSearchUrl("fotocasa", SCOPE)).toBeNull();
  });
});

describe("buildSearchUrls", () => {
  it("builds every capture portal's URL in CAPTURE_PORTALS order", () => {
    const urls = buildSearchUrls(SCOPE);
    expect(urls.map((u) => u.portal)).toEqual(["idealista", "aliseda"]);
    for (const u of urls) {
      expect(u.url).toMatch(/^https:\/\//);
      expect(Array.isArray(u.loosened)).toBe(true);
    }
  });

  it("carries per-portal loosened flags (aliseda geography always widened)", () => {
    const urls = buildSearchUrls(SCOPE);
    const aliseda = urls.find((u) => u.portal === "aliseda")!;
    expect(aliseda.loosened.some((l) => l.constraint === "geography")).toBe(true);
    const idealista = urls.find((u) => u.portal === "idealista")!;
    // idealista renders this two-home-subtype scope faithfully.
    expect(idealista.loosened).toEqual([]);
  });
});
