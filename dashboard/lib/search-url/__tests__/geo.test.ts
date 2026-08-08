/**
 * Unit tests for the Idealista drawn-area geometry helpers (issue #471 P2).
 *
 * Pinned to the owner-captured real specimen (2026-08-08, issue #471 comment
 * "✅ Specimen real capturado"): a Dos Hermanas drawn zone whose `shape` value,
 * URL-decoded, is `((<polyline>))` for a 10-vertex closed ring, precision 5,
 * lat,lng. These tests are the feasibility gate — they prove our encoder
 * reproduces a REAL portal-drawn shape byte-for-byte, which the reverted #277
 * builder never established.
 */

import { describe, it, expect } from "vitest";
import {
  encodePolyline,
  decodePolyline,
  circlePolygon,
  polygonCentroid,
  encodeShapeValue,
  decodeShapeValue,
  shapeUrl,
} from "@/lib/search-url/geo";

// ─── The captured specimen ───────────────────────────────────────────────────

/** The raw `shape` param value as captured from the address bar (percent-encoded). */
const SPECIMEN_SHAPE_ENCODED =
  "%28%28%7DhpbFl%7Clc%40asJia%40unDijBl_%40coElp%40glA%7C%7EFslCpvJmTpp%40vuFurA%7CdHobCjp%40%29%29";

/** The polyline body (inside the `((…))` wrapper), URL-decoded. */
const SPECIMEN_POLYLINE = "}hpbFl|lc@asJia@unDijBl_@coElp@glA|~FslCpvJmTpp@vuFurA|dHobCjp@";

/** The full captured URL. */
const SPECIMEN_URL =
  "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_700000/mapa-google?shape=" +
  SPECIMEN_SHAPE_ENCODED;

/** The 10 vertices the specimen decodes to (closed ring; last == first). */
const SPECIMEN_VERTICES: Array<[number, number]> = [
  [37.28031, -5.96951],
  [37.33984, -5.96402],
  [37.36795, -5.94685],
  [37.36276, -5.91355],
  [37.35485, -5.90119],
  [37.3139, -5.87853],
  [37.25381, -5.8751],
  [37.24588, -5.91458],
  [37.25927, -5.96161],
  [37.28031, -5.96951],
];

const EARTH_RADIUS_KM = 6371;
function haversineKm(a: readonly [number, number], b: readonly [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

describe("polyline round-trip pinned to the captured Idealista specimen", () => {
  it("decodePolyline recovers the 10 specimen vertices", () => {
    const verts = decodePolyline(SPECIMEN_POLYLINE);
    expect(verts).toHaveLength(10);
    verts.forEach(([lat, lng], i) => {
      expect(lat).toBeCloseTo(SPECIMEN_VERTICES[i][0], 5);
      expect(lng).toBeCloseTo(SPECIMEN_VERTICES[i][1], 5);
    });
    // Closed ring: last vertex repeats the first.
    expect(verts[0]).toEqual(verts[verts.length - 1]);
  });

  it("encodePolyline reproduces the specimen polyline body byte-for-byte", () => {
    expect(encodePolyline(SPECIMEN_VERTICES)).toBe(SPECIMEN_POLYLINE);
  });

  it("encode(decode(specimen)) is the identity on the polyline body", () => {
    expect(encodePolyline(decodePolyline(SPECIMEN_POLYLINE))).toBe(SPECIMEN_POLYLINE);
  });

  it("encodeShapeValue reproduces the captured percent-encoded shape byte-for-byte", () => {
    expect(encodeShapeValue(SPECIMEN_VERTICES)).toBe(SPECIMEN_SHAPE_ENCODED);
  });

  it("decodeShapeValue inverts the captured shape param", () => {
    const ring = decodeShapeValue(SPECIMEN_SHAPE_ENCODED)!;
    expect(ring).toHaveLength(10);
    expect(ring[0][0]).toBeCloseTo(37.28031, 5);
    expect(ring[0][1]).toBeCloseTo(-5.96951, 5);
  });

  it("shapeUrl reproduces the full captured URL from the specimen ring", () => {
    expect(shapeUrl("venta-viviendas", ["precio-hasta_700000"], SPECIMEN_VERTICES)).toBe(
      SPECIMEN_URL,
    );
  });
});

describe("circlePolygon", () => {
  it("returns a CLOSED ring of nVertices+1 points (default 24)", () => {
    const ring = circlePolygon(37.3, -5.9, 5);
    expect(ring).toHaveLength(25);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it.each([
    ["Dos Hermanas r=5 n=24", [37.3, -5.9], 5, 24],
    ["Estepona r=30 n=24", [36.4268, -5.1468], 30, 24],
    ["small r=5 n=8", [37.3, -5.9], 5, 8],
  ] as const)("circumscribes the circle (contains it fully): %s", (_n, c, r, n) => {
    const ring = circlePolygon(c[0], c[1], r, n);
    for (let i = 0; i < ring.length - 1; i++) {
      // Every vertex is at/beyond the radius…
      expect(haversineKm(c, ring[i])).toBeGreaterThanOrEqual(r);
      // …and every edge midpoint too → the whole disk is inside the polygon.
      const mid: [number, number] = [
        (ring[i][0] + ring[i + 1][0]) / 2,
        (ring[i][1] + ring[i + 1][1]) / 2,
      ];
      expect(haversineKm(c, mid)).toBeGreaterThanOrEqual(r);
    }
  });

  it("centroid of the generated ring is the centre point", () => {
    const c: [number, number] = [37.3, -5.9];
    const centroid = polygonCentroid(circlePolygon(c[0], c[1], 5));
    expect(centroid[0]).toBeCloseTo(c[0], 3);
    expect(centroid[1]).toBeCloseTo(c[1], 3);
  });

  it("a larger radius yields a strictly larger (different) polygon", () => {
    const small = encodePolyline(circlePolygon(37.3, -5.9, 5));
    const large = encodePolyline(circlePolygon(37.3, -5.9, 30));
    expect(small).not.toBe(large);
  });
});
