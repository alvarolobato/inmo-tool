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
    expect([...SEARCH_URL_PORTALS]).toEqual(["idealista", "aliseda", "hipoges"]);
  });
});

describe("buildSearchUrl", () => {
  it("builds one portal's tasks (an array)", () => {
    const result = buildSearchUrl("idealista", SCOPE);
    expect(result).not.toBeNull();
    // piso + chalet share the venta-viviendas section → a single idealista task.
    expect(result).toHaveLength(1);
    expect(result![0].portal).toBe("idealista");
    expect(result![0].url).toContain("idealista.com/areas/venta-viviendas");
  });

  it("returns null for a portal with no builder", () => {
    expect(buildSearchUrl("fotocasa", SCOPE)).toBeNull();
  });
});

describe("buildSearchUrls", () => {
  it("returns a flat task list across every capture portal in CAPTURE_PORTALS order", () => {
    const tasks = buildSearchUrls(SCOPE);
    // idealista: 1 viviendas task; aliseda: one task per type (piso, chalet);
    // hipoges: one task per typology (piso→flat, chalet→house).
    expect(tasks.map((t) => t.portal)).toEqual([
      "idealista",
      "aliseda",
      "aliseda",
      "hipoges",
      "hipoges",
    ]);
    for (const t of tasks) {
      expect(t.url).toMatch(/^https:\/\//);
      expect(typeof t.id).toBe("string");
      expect(typeof t.label).toBe("string");
      expect(Array.isArray(t.loosened)).toBe(true);
    }
  });

  it("gives every task a distinct, stable id", () => {
    const ids = buildSearchUrls(SCOPE).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Deterministic across calls.
    expect(buildSearchUrls(SCOPE).map((t) => t.id)).toEqual(ids);
  });

  it("carries per-task loosened flags (aliseda geography always widened)", () => {
    const tasks = buildSearchUrls(SCOPE);
    const aliseda = tasks.filter((t) => t.portal === "aliseda");
    expect(aliseda.every((t) => t.loosened.some((l) => l.constraint === "geography"))).toBe(true);
  });
});
