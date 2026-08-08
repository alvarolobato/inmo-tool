import { describe, it, expect } from "vitest";
import { decodeFilterUrl } from "@/lib/filter-validation";
import type { Scope } from "@/lib/profiles-schema";

function scope(overrides: Partial<Scope> = {}): Scope {
  return {
    geography: { type: "radius", center: [37.3891, -5.9845], radius_km: 5 },
    property_types: ["piso"],
    ...overrides,
  } as Scope;
}

describe("decodeFilterUrl (issue #478 P2)", () => {
  it("decodes a recognised idealista URL into chips with the categoryKey as sectionKey", () => {
    const url = "https://www.idealista.com/venta-viviendas/sevilla-sevilla/";
    const d = decodeFilterUrl("idealista", url, scope());
    expect(d.unparseable).toBe(false);
    expect(d.sectionKey).not.toBe("");
    expect(d.chips.some((c) => c.startsWith("Sección:"))).toBe(true);
    expect(d.chips.some((c) => c.includes("sevilla-sevilla"))).toBe(true);
  });

  it("warns when the profile has a price_max the URL does not filter", () => {
    const url = "https://www.idealista.com/venta-viviendas/sevilla-sevilla/";
    const d = decodeFilterUrl("idealista", url, scope({ price_max: 200000 }));
    expect(d.warnings.some((w) => /precio máximo/i.test(w))).toBe(true);
  });

  it("does not warn about price when the URL filters the same price_max", () => {
    const url = "https://www.idealista.com/venta-viviendas/sevilla-sevilla/con-precio-hasta_200000/";
    const d = decodeFilterUrl("idealista", url, scope({ price_max: 200000 }));
    expect(d.warnings.some((w) => /precio máximo/i.test(w))).toBe(false);
  });

  it("flags an unparseable URL (unknown grammar / shape=) with an empty sectionKey", () => {
    const url = "https://www.idealista.com/areas/venta-viviendas/?shape=abc123";
    const d = decodeFilterUrl("idealista", url, scope());
    expect(d.unparseable).toBe(true);
    expect(d.chips).toEqual([]);
    expect(d.sectionKey).toBe("");
  });

  it("treats an empty URL as nothing to decode (not unparseable)", () => {
    const d = decodeFilterUrl("altamira", "", scope());
    expect(d.unparseable).toBe(false);
    expect(d.chips).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it("flags a portal with no parser as unparseable", () => {
    const d = decodeFilterUrl("altamira", "https://www.altamirainmuebles.com/venta/x", scope());
    expect(d.unparseable).toBe(true);
  });
});
