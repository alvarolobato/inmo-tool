// @vitest-environment node
/**
 * Unit tests for the capture-URL helper (issue #529) — the URL a harvester opens
 * for a search task, which diverges from the canonical `url` only for an
 * Idealista map-view (drawn-zone) search.
 */

import { describe, it, expect } from "vitest";

import { toCaptureUrl } from "@/lib/search-url/capture-url";

const MAP =
  "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_700000/mapa-google?shape=%28%28abc%7C_def%29%29";
const LISTING =
  "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_700000/?shape=%28%28abc%7C_def%29%29";

describe("toCaptureUrl — the URL a harvester should open (#529)", () => {
  it("strips /mapa-google for an Idealista map-view search (→ listing form)", () => {
    expect(toCaptureUrl("idealista", MAP)).toBe(LISTING);
  });

  it("preserves the shape= query byte-for-byte (never re-encodes the polyline)", () => {
    const shape = (u: string) => new URL(u).search;
    expect(shape(toCaptureUrl("idealista", MAP))).toBe(shape(MAP));
  });

  it("is a no-op for an Idealista URL that is already a listing form (idempotent)", () => {
    expect(toCaptureUrl("idealista", LISTING)).toBe(LISTING);
    expect(toCaptureUrl("idealista", toCaptureUrl("idealista", MAP))).toBe(LISTING);
  });

  it("is identity for a non-Idealista portal even if the path contains mapa-google", () => {
    const aliseda = "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga";
    expect(toCaptureUrl("aliseda", aliseda)).toBe(aliseda);
    // The dispatch keys on portal, not host — an unrelated portal is untouched.
    expect(toCaptureUrl("altamira", MAP)).toBe(MAP);
  });

  it("returns non-map / unparseable Idealista URLs unchanged", () => {
    const slug = "https://www.idealista.com/venta-viviendas/estepona-malaga/";
    expect(toCaptureUrl("idealista", slug)).toBe(slug);
    expect(toCaptureUrl("idealista", "not a url")).toBe("not a url");
  });
});
