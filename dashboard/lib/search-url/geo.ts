/**
 * Geometry helpers for portals that search by a drawn map area (issue #267).
 *
 * The profile scope expresses geography as a radius around a geocoded point.
 * Idealista's map search ("dibuja tu zona") takes a polygon encoded as a
 * Google Encoded Polyline (the same algorithm Google Maps uses), wrapped in
 * `((…))`, in a `shape` query param. So to turn radius-from-a-point into an
 * idealista search we approximate the circle with a regular polygon and encode
 * its vertices. A polygon is a faithful (not loosened) rendering of a circle,
 * so geography carries no loosened-constraint flag on portals that accept it.
 *
 * These are pure functions with no portal knowledge, unit-tested directly.
 */

const EARTH_RADIUS_KM = 6371;

/** Number of vertices used to approximate the search circle. */
export const CIRCLE_POLYGON_POINTS = 24;

/**
 * Vertices of a regular polygon approximating a circle of `radiusKm` around
 * `[lat, lng]`, as `[lat, lng]` pairs walking counter-clockwise from due east.
 * The ring is not explicitly closed (the encoder / consumer closes it).
 */
export function circlePolygon(
  center: readonly [number, number],
  radiusKm: number,
  points: number = CIRCLE_POLYGON_POINTS,
): Array<[number, number]> {
  const [lat, lng] = center;
  const latRad = (lat * Math.PI) / 180;
  // Angular radius in degrees along a meridian; longitude scales by cos(lat).
  const dLat = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const cosLat = Math.cos(latRad);
  // Near the poles cosLat → 0; clamp so we never divide by ~0 and produce a
  // wildly wide longitude span. Spain is nowhere near this, but a defensive
  // floor keeps the function total.
  const dLng = dLat / Math.max(Math.abs(cosLat), 1e-6);

  const ring: Array<[number, number]> = [];
  for (let i = 0; i < points; i++) {
    const theta = (2 * Math.PI * i) / points;
    const vLat = lat + dLat * Math.sin(theta);
    const vLng = lng + dLng * Math.cos(theta);
    ring.push([vLat, vLng]);
  }
  return ring;
}

/**
 * Encode a single signed coordinate component into Google's Encoded Polyline
 * Algorithm representation (precision 5). Shared by lat and lng deltas.
 */
function encodeSignedNumber(num: number): string {
  let sgnNum = num << 1;
  if (num < 0) sgnNum = ~sgnNum;
  let out = "";
  while (sgnNum >= 0x20) {
    out += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  out += String.fromCharCode(sgnNum + 63);
  return out;
}

/**
 * Encode a list of `[lat, lng]` points as a Google Encoded Polyline
 * (precision 5). Deterministic — the unit tests pin exact output.
 */
export function encodePolyline(points: ReadonlyArray<readonly [number, number]>): string {
  let lastLat = 0;
  let lastLng = 0;
  let result = "";
  for (const [lat, lng] of points) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    result += encodeSignedNumber(iLat - lastLat);
    result += encodeSignedNumber(iLng - lastLng);
    lastLat = iLat;
    lastLng = iLng;
  }
  return result;
}

/**
 * The value idealista puts in its `shape` query param for a drawn area: the
 * polygon's Google-encoded polyline wrapped in `((…))`. Returned UNescaped;
 * the caller URL-encodes it when assembling the query string.
 */
export function idealistaShape(
  center: readonly [number, number],
  radiusKm: number,
  points: number = CIRCLE_POLYGON_POINTS,
): string {
  return `((${encodePolyline(circlePolygon(center, radiusKm, points))}))`;
}
