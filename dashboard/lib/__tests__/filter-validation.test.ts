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

  it("flags a malformed shape URL (not the ((polyline)) grammar) as unparseable", () => {
    const url = "https://www.idealista.com/areas/venta-viviendas/?shape=abc123";
    const d = decodeFilterUrl("idealista", url, scope());
    expect(d.unparseable).toBe(true);
    expect(d.chips).toEqual([]);
    expect(d.sectionKey).toBe("");
  });

  it("decodes a drawn-polygon (shape=) URL into a vertex-count chip (#471)", () => {
    // The owner-captured Dos Hermanas specimen: 10-vertex closed ring.
    const url =
      "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_700000/mapa-google?shape=%28%28%7DhpbFl%7Clc%40asJia%40unDijBl_%40coElp%40glA%7C%7EFslCpvJmTpp%40vuFurA%7CdHobCjp%40%29%29";
    const d = decodeFilterUrl("idealista", url, scope());
    expect(d.unparseable).toBe(false);
    expect(d.sectionKey).toBe("venta-viviendas");
    expect(d.chips.some((c) => /polígono dibujado \(10 vértices\)/.test(c))).toBe(true);
  });

  it("decodes a multi-zone URL into a zone-count chip (#471)", () => {
    const url =
      "https://www.idealista.com/multi/venta-viviendas/ac0,ac2,acY,acZ,adb,cuZ/con-precio-hasta_700000/";
    const d = decodeFilterUrl("idealista", url, scope());
    expect(d.unparseable).toBe(false);
    expect(d.sectionKey).toBe("venta-viviendas");
    expect(d.chips.some((c) => /6 zonas Idealista \(multi\)/.test(c))).toBe(true);
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
