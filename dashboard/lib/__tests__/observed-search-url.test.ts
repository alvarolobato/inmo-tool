// @vitest-environment node
/**
 * Unit tests for the pure observed-search-URL helpers (issue #488, part of
 * #471; generalized to all capture portals in #510): the server-side
 * host/observable check + portal derivation + de-dup normalization (which must
 * mirror the extension helper — driven by the shared fixture), and the
 * review-only analysis helpers (type badge + `shape=` vertex count).
 */

import { describe, it, expect } from "vitest";
import {
  isObservableSearchUrl,
  observablePortalForUrl,
  normalizeObservedUrl,
  observedUrlType,
  shapeVertexCount,
} from "../observed-search-url";
import { OBSERVABLE_CASES } from "../../__tests__/fixtures/search-url-observable";

const LISTADO = "https://www.idealista.com/venta-viviendas/estepona-malaga/";
const AREAS = "https://www.idealista.com/areas/venta-viviendas/?shape=AAA";
const MULTI = "https://www.idealista.com/multi/venta-viviendas/madrid/";

describe("observablePortalForUrl / isObservableSearchUrl (shared fixture)", () => {
  for (const c of OBSERVABLE_CASES) {
    it(`${c.desc} → ${c.portal ?? "null"}`, () => {
      expect(observablePortalForUrl(c.url)).toBe(c.portal);
      expect(isObservableSearchUrl(c.url)).toBe(c.portal !== null);
    });
  }
});

describe("normalizeObservedUrl", () => {
  it("is order- and www/trailing-slash-insensitive", () => {
    const a = normalizeObservedUrl("https://www.idealista.com/venta-viviendas/x/?b=2&a=1");
    const b = normalizeObservedUrl("https://idealista.com/venta-viviendas/x?a=1&b=2#f");
    expect(a).toBe("idealista.com/venta-viviendas/x?a=1&b=2");
    expect(a).toBe(b);
  });

  it("normalizes aliseda + altamira hosts (host gate, not the search-page gate)", () => {
    expect(normalizeObservedUrl("https://www.alisedainmobiliaria.com/comprar-viviendas/malaga")).toBe(
      "alisedainmobiliaria.com/comprar-viviendas/malaga",
    );
    expect(normalizeObservedUrl("https://www.altamirainmuebles.com/venta-viviendas/pontevedra/")).toBe(
      "altamirainmuebles.com/venta-viviendas/pontevedra",
    );
  });

  it("returns null for non-portal URLs", () => {
    expect(normalizeObservedUrl("https://example.com/x")).toBeNull();
    expect(normalizeObservedUrl("nope")).toBeNull();
  });
});

describe("observedUrlType", () => {
  it("classifies multi / areas / plana", () => {
    expect(observedUrlType(MULTI)).toBe("multi");
    expect(observedUrlType(AREAS)).toBe("areas");
    expect(observedUrlType(LISTADO)).toBe("plana");
  });
});

describe("shapeVertexCount", () => {
  it("returns null when there is no shape= param", () => {
    expect(shapeVertexCount(LISTADO)).toBeNull();
  });

  it("decodes a Google-polyline shape to its vertex count", () => {
    // Google's documented example encodes 3 coordinate pairs.
    const enc = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
    const url = `https://www.idealista.com/areas/venta-viviendas/?shape=${encodeURIComponent(
      `((${enc}))`,
    )}`;
    expect(shapeVertexCount(url)).toBe(3);
  });

  it("sums vertices across a multi-polygon shape (concatenated polylines)", () => {
    const enc = "_p~iF~ps|U_ulLnnqC_mqNvxq`@"; // 3 points
    // Two polygons wrapped like idealista's nested-paren multi shape.
    const url = `https://www.idealista.com/multi/venta-viviendas/?shape=${encodeURIComponent(
      `((${enc}),(${enc}))`,
    )}`;
    expect(shapeVertexCount(url)).toBe(6);
  });

  it("returns 0 for an empty shape and null for an unparseable URL", () => {
    expect(shapeVertexCount("https://www.idealista.com/areas/?shape=%28%29")).toBe(0);
    expect(shapeVertexCount("not a url")).toBeNull();
  });
});
