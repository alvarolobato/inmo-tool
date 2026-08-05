/**
 * Unit tests for the discovered option→fragment mapping layer (issue #336,
 * D-063): the canonical-type resolver, the payload validator, the prime/read
 * cache, and — end to end — the Aliseda builder preferring a discovered slug +
 * subtipo over its hard-coded seed while falling back to the seed when nothing
 * is discovered.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  canonicalPropertyType,
  validateCatalogPayload,
  primeDiscoveredCatalog,
  resetDiscoveredCatalogCache,
  discoveredSegmentFor,
} from "@/lib/search-url/discovered-mapping";
import { alisedaBuilder } from "@/lib/search-url/portals/aliseda";
import type { CanonicalSearchScope } from "@/lib/search-url/types";

describe("canonicalPropertyType", () => {
  it("maps accented / compound portal labels to our canonical type", () => {
    expect(canonicalPropertyType("Piso")).toBe("piso");
    expect(canonicalPropertyType("Ático")).toBe("atico"); // accent-insensitive
    expect(canonicalPropertyType("atico")).toBe("atico");
    expect(canonicalPropertyType("Chalet adosado")).toBe("chalet");
    expect(canonicalPropertyType("Chalet pareado")).toBe("chalet");
    expect(canonicalPropertyType("Local comercial")).toBe("local");
    expect(canonicalPropertyType("Nave industrial")).toBe("nave");
    expect(canonicalPropertyType("Plaza de garaje")).toBe("garaje");
    expect(canonicalPropertyType("Terreno / suelo")).toBe("terreno");
    expect(canonicalPropertyType("Edificio")).toBe("edificio");
  });

  it("returns null for labels outside our taxonomy", () => {
    expect(canonicalPropertyType("Dúplex")).toBeNull();
    expect(canonicalPropertyType("Estudio")).toBeNull();
    expect(canonicalPropertyType("")).toBeNull();
  });
});

describe("validateCatalogPayload", () => {
  const okAxes = {
    property_type: [
      { label: "Piso", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 },
    ],
  };

  it("accepts a well-formed catalog and normalizes capturedAt to ISO", () => {
    const r = validateCatalogPayload({
      source: "embedded-config",
      capturedAt: "2026-08-05T10:00:00Z",
      axes: okAxes,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("embedded-config");
      expect(r.capturedAt).toBe("2026-08-05T10:00:00.000Z");
      expect(r.axes.property_type).toHaveLength(1);
    }
  });

  it("defaults capturedAt to now when absent", () => {
    const r = validateCatalogPayload({ source: "form-options", axes: okAxes });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Number.isNaN(Date.parse(r.capturedAt))).toBe(false);
  });

  it("rejects a bad source", () => {
    const r = validateCatalogPayload({ source: "nope", axes: okAxes });
    expect(r).toEqual({ ok: false, reason: "invalid_source" });
  });

  it("rejects a non-object body / non-object axes / bad timestamp", () => {
    expect(validateCatalogPayload(null)).toEqual({ ok: false, reason: "body_not_object" });
    expect(validateCatalogPayload({ source: "form-options", axes: 3 })).toEqual({
      ok: false,
      reason: "invalid_axes",
    });
    expect(
      validateCatalogPayload({ source: "form-options", capturedAt: "not-a-date", axes: okAxes }),
    ).toEqual({ ok: false, reason: "invalid_capturedAt" });
  });

  it("drops malformed options and unknown axes, but requires at least one usable option", () => {
    const r = validateCatalogPayload({
      source: "form-options",
      axes: {
        property_type: [
          { label: "Piso", urlFragment: "/comprar-viviendas/pisos" },
          { label: "", urlFragment: "/x" }, // dropped: empty label
          { label: "Sin fragmento" }, // dropped: no urlFragment
        ],
        made_up_axis: [{ label: "x", urlFragment: "/y" }], // unknown axis dropped
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.axes.property_type).toHaveLength(1);
      expect((r.axes as Record<string, unknown>).made_up_axis).toBeUndefined();
    }
  });

  it("rejects a catalog with no options anywhere", () => {
    const r = validateCatalogPayload({ source: "form-options", axes: { property_type: [] } });
    expect(r).toEqual({ ok: false, reason: "no_options" });
  });
});

describe("discoveredSegmentFor + cache", () => {
  beforeEach(() => resetDiscoveredCatalogCache());
  afterEach(() => resetDiscoveredCatalogCache());

  it("returns null when nothing is primed (seed fallback)", () => {
    expect(discoveredSegmentFor("aliseda", "property_type", "piso")).toBeNull();
  });

  it("matches a canonical type by portal label and returns slug + code + category", () => {
    primeDiscoveredCatalog("aliseda", {
      property_type: [
        {
          label: "Ático",
          urlFragment: "/comprar-viviendas/aticos",
          subtipo: 40,
          category: "comprar-viviendas",
        },
      ],
    });
    expect(discoveredSegmentFor("aliseda", "property_type", "atico")).toEqual({
      slug: "aticos",
      code: 40,
      category: "comprar-viviendas",
      label: "Ático",
    });
    // A type with no matching discovered option → null (falls back to seed).
    expect(discoveredSegmentFor("aliseda", "property_type", "garaje")).toBeNull();
  });

  it("priming null clears the connector's catalog", () => {
    primeDiscoveredCatalog("aliseda", { property_type: [{ label: "Piso", urlFragment: "/x/pisos" }] });
    expect(discoveredSegmentFor("aliseda", "property_type", "piso")).not.toBeNull();
    primeDiscoveredCatalog("aliseda", null);
    expect(discoveredSegmentFor("aliseda", "property_type", "piso")).toBeNull();
  });
});

describe("aliseda builder composes with the discovered mapping", () => {
  const ESTEPONA: readonly [number, number] = [36.4268, -5.1468];
  const scope = (types: CanonicalSearchScope["propertyTypes"]): CanonicalSearchScope => ({
    center: ESTEPONA,
    radiusKm: 5,
    propertyTypes: types,
  });

  beforeEach(() => resetDiscoveredCatalogCache());
  afterEach(() => resetDiscoveredCatalogCache());

  it("prefers the discovered slug + subtipo over the seed and drops the guessed-plural flag", () => {
    // Seed folds atico onto `pisos` (subtipo 36) and flags it as approximate.
    // Discovery gives the real `aticos-lujo` slug + subtipo=40 → authoritative,
    // overriding the seed slug/code and dropping the property_types flag.
    primeDiscoveredCatalog("aliseda", {
      property_type: [{ label: "Ático", urlFragment: "/comprar-viviendas/aticos-lujo", subtipo: 40 }],
    });
    const [task] = alisedaBuilder.build(scope(["atico"]));
    expect(task.url).toContain("/comprar-viviendas/aticos-lujo/");
    expect(task.url).toContain("subtipo=40");
    // Only the always-present geography flag remains — no property_types flags.
    expect(task.loosened.every((l) => l.constraint !== "property_types")).toBe(true);
  });

  it("falls back to the hard-coded seed (with its flags) when nothing is discovered", () => {
    const [task] = alisedaBuilder.build(scope(["atico"]));
    // Seed behaviour on main (#338 / D-062): Aliseda has no ático bucket, so the
    // seed folds atico onto `pisos` (subtipo 36) and flags the approximate map.
    expect(task.url).toContain("/comprar-viviendas/pisos/");
    expect(task.url).toContain("subtipo=36");
    expect(task.loosened.some((l) => l.constraint === "property_types")).toBe(true);
  });

  it("keeps the confirmed piso seed intact and unflagged whether or not discovery ran", () => {
    // No discovery: piso is the owner-confirmed seed (slug pisos, subtipo 36).
    const [seed] = alisedaBuilder.build(scope(["piso"]));
    expect(seed.url).toContain("/comprar-viviendas/pisos/");
    expect(seed.url).toContain("subtipo=36");
    expect(seed.loosened.every((l) => l.constraint !== "property_types")).toBe(true);
  });
});
