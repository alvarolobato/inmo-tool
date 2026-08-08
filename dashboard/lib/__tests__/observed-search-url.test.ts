// @vitest-environment node
/**
 * Unit tests for the pure observed-search-URL helpers (issue #488, part of
 * #471): the server-side host/observable check + de-dup normalization (which
 * must mirror the extension helper), and the review-only analysis helpers
 * (type badge + `shape=` vertex count).
 */

import { describe, it, expect } from "vitest";
import {
  isObservableIdealistaUrl,
  normalizeObservedUrl,
  observedUrlType,
  shapeVertexCount,
} from "../observed-search-url";

const LISTADO = "https://www.idealista.com/venta-viviendas/estepona-malaga/";
const AREAS = "https://www.idealista.com/areas/venta-viviendas/?shape=AAA";
const MULTI = "https://www.idealista.com/multi/venta-viviendas/madrid/";

describe("isObservableIdealistaUrl", () => {
  it("accepts listado / areas / multi / shape URLs", () => {
    expect(isObservableIdealistaUrl(LISTADO)).toBe(true);
    expect(isObservableIdealistaUrl(AREAS)).toBe(true);
    expect(isObservableIdealistaUrl(MULTI)).toBe(true);
  });

  it("rejects the home page, detail pages and other portals", () => {
    expect(isObservableIdealistaUrl("https://www.idealista.com/")).toBe(false);
    expect(isObservableIdealistaUrl("https://www.idealista.com/inmueble/123/")).toBe(false);
    expect(isObservableIdealistaUrl("https://example.com/venta-viviendas/")).toBe(false);
  });
});

describe("normalizeObservedUrl", () => {
  it("is order- and www/trailing-slash-insensitive", () => {
    const a = normalizeObservedUrl("https://www.idealista.com/venta-viviendas/x/?b=2&a=1");
    const b = normalizeObservedUrl("https://idealista.com/venta-viviendas/x?a=1&b=2#f");
    expect(a).toBe("idealista.com/venta-viviendas/x?a=1&b=2");
    expect(a).toBe(b);
  });

  it("returns null for non-idealista URLs", () => {
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
