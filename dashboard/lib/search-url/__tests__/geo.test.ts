/**
 * Unit tests for the map-area geometry helpers (issue #267).
 */

import { describe, it, expect } from "vitest";
import {
  circlePolygon,
  encodePolyline,
  idealistaShape,
  CIRCLE_POLYGON_POINTS,
} from "@/lib/search-url/geo";

/** Reference decoder (Google Encoded Polyline, precision 5) for round-trips. */
function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function haversineKm(a: readonly [number, number], b: readonly [number, number]): number {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe("encodePolyline", () => {
  it("matches Google's canonical reference example", () => {
    // The documented reference vector from Google's Encoded Polyline spec.
    const points: Array<[number, number]> = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    expect(encodePolyline(points)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  });

  it("round-trips through a reference decoder", () => {
    const points: Array<[number, number]> = [
      [40.4168, -3.7038],
      [41.3874, 2.1686],
    ];
    const decoded = decodePolyline(encodePolyline(points));
    expect(decoded).toHaveLength(2);
    for (let i = 0; i < points.length; i++) {
      expect(decoded[i][0]).toBeCloseTo(points[i][0], 4);
      expect(decoded[i][1]).toBeCloseTo(points[i][1], 4);
    }
  });
});

describe("circlePolygon", () => {
  const center: [number, number] = [40.4168, -3.7038]; // Madrid
  const radiusKm = 10;

  it("returns the requested number of vertices (default 24)", () => {
    expect(circlePolygon(center, radiusKm)).toHaveLength(CIRCLE_POLYGON_POINTS);
    expect(circlePolygon(center, radiusKm, 8)).toHaveLength(8);
  });

  it("places every vertex ~radiusKm from the centre", () => {
    for (const v of circlePolygon(center, radiusKm)) {
      // Polygon vertices sit exactly on the circle; tolerance covers the
      // small-angle flat-earth approximation used in circlePolygon.
      expect(haversineKm(center, v)).toBeCloseTo(radiusKm, 0);
    }
  });

  it("starts due east of the centre (theta=0)", () => {
    const [first] = circlePolygon(center, radiusKm);
    expect(first[0]).toBeCloseTo(center[0], 5); // same latitude
    expect(first[1]).toBeGreaterThan(center[1]); // further east
  });
});

describe("idealistaShape", () => {
  it("wraps the encoded polygon in ((…))", () => {
    const shape = idealistaShape([40.4168, -3.7038], 5);
    expect(shape.startsWith("((")).toBe(true);
    expect(shape.endsWith("))")).toBe(true);
    // Inner content decodes back to the circle polygon.
    const inner = shape.slice(2, -2);
    expect(decodePolyline(inner)).toHaveLength(CIRCLE_POLYGON_POINTS);
  });

  it("is deterministic for the same input", () => {
    const a = idealistaShape([40.4168, -3.7038], 7);
    const b = idealistaShape([40.4168, -3.7038], 7);
    expect(a).toBe(b);
  });
});
