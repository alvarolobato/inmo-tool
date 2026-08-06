/**
 * Unit tests for the discovered filter-catalog layer (issue #336, D-063;
 * reframed detection-only by issue #371, D-089): the canonical-type resolver and
 * the ingest payload validator. The self-healing "prefer the discovered slug/
 * subtipo over the seed" path was REMOVED per the owner — URL building is 100%
 * code-driven — so those tests now assert the Aliseda builder IGNORES any
 * catalog and always emits its hard-coded map. Drift detection lives in
 * ./drift.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  canonicalPropertyType,
  validateCatalogPayload,
  lastPathSegment,
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

describe("lastPathSegment", () => {
  it("returns the last non-empty path segment, ignoring query/hash", () => {
    expect(lastPathSegment("/comprar-viviendas/pisos")).toBe("pisos");
    expect(lastPathSegment("/comprar-locales?x=1")).toBe("comprar-locales");
    expect(lastPathSegment("/")).toBeNull();
    expect(lastPathSegment("")).toBeNull();
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

describe("aliseda builder is code-driven (no self-healing from any catalog)", () => {
  const ESTEPONA: readonly [number, number] = [36.4268, -5.1468];
  const scope = (types: CanonicalSearchScope["propertyTypes"]): CanonicalSearchScope => ({
    center: ESTEPONA,
    radiusKm: 5,
    propertyTypes: types,
  });

  it("folds atico onto the seed `pisos` (subtipo 36) and flags the approximate map", () => {
    const [task] = alisedaBuilder.build(scope(["atico"]));
    // Aliseda has no ático bucket → the code map folds atico onto pisos and
    // flags it; discovery never overrides this (D-089).
    expect(task.url).toContain("/comprar-viviendas/pisos/");
    expect(task.url).toContain("subtipo=36");
    expect(task.loosened.some((l) => l.constraint === "property_types")).toBe(true);
  });

  it("keeps the confirmed piso seed intact and unflagged", () => {
    const [seed] = alisedaBuilder.build(scope(["piso"]));
    expect(seed.url).toContain("/comprar-viviendas/pisos/");
    expect(seed.url).toContain("subtipo=36");
    expect(seed.loosened.every((l) => l.constraint !== "property_types")).toBe(true);
  });
});
