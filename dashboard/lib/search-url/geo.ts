/**
 * Geometry helpers for Idealista's drawn-area ("dibuja tu zona") search — the
 * `shape=` polygon grammar (issues #267, #471).
 *
 * A profile expresses geography as a radius around a geocoded point. Idealista's
 * map search takes a polygon encoded as a Google Encoded Polyline (precision 5,
 * lat,lng order), wrapped in `((…))`, in a `shape` query param on an
 * `/areas/<operation>/…/mapa-google` path. So to turn radius-from-a-point into
 * an Idealista search we approximate the circle with a regular polygon and
 * encode its vertices.
 *
 * CONFIRMED grammar (owner-captured specimen, 2026-08-08 — see issue #471,
 * comment "✅ Specimen real capturado"): a Dos Hermanas drawn area produced
 *
 *   https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_700000/mapa-google?shape=%28%28…%29%29
 *
 * whose `shape`, URL-decoded, is `((<polyline>))` — a 10-vertex CLOSED ring
 * (last == first), precision-5, lat,lng. The `geo.test.ts` round-trip is pinned
 * to that specimen: decodePolyline(specimen) recovers the 10 vertices and
 * encodePolyline(those) reproduces the specimen body byte-for-byte (Google
 * polyline is deterministic). The #277 builder that b414538 reverted was
 * reverse-engineered without a real URL; this module is pinned to one.
 *
 * The circle→polygon ring CIRCUMSCRIBES the circle (contains it fully): the
 * open-decision #1 in #471 chose the contract-faithful "broaden, never narrow"
 * option over an inscribed under-covering polygon. Over-coverage is ~0.9% and
 * the feed-side haversine filter (scope-query.ts) trims it — the shape URL only
 * governs RECALL.
 *
 * Pure functions, no portal/DB knowledge beyond the Idealista URL shape in
 * {@link shapeUrl}; unit-tested directly.
 */

const EARTH_RADIUS_KM = 6371;

/** Number of vertices used to approximate the search circle. */
export const CIRCLE_POLYGON_POINTS = 24;

/**
 * A tiny over-scale on the circumscribed radius so the polygon rigorously
 * CONTAINS the circle: a regular polygon whose apothem equals `r` touches the
 * circle at each edge midpoint, but a straight lat/lng edge dips a fraction of a
 * metre inside the great-circle apothem. 1.002 lifts every edge midpoint back
 * outside `r` (verified in geo.test.ts). Cost: ~0.2% extra over-coverage, which
 * the feed haversine trims.
 */
const CIRCUMSCRIBE_SAFETY = 1.002;

// ─── Google Encoded Polyline (precision 5) ───────────────────────────────────

/**
 * Encode a single signed integer into Google's Encoded Polyline representation
 * (the signed-zigzag + 5-bit-chunk scheme). Shared by lat and lng deltas.
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
 * Decode a Google Encoded Polyline (precision 5) back into `[lat, lng]` pairs —
 * the inverse of {@link encodePolyline}. Used by the tests and by the parser
 * (vertex-count display + centroid) when it decodes an owner-navigated shape URL.
 */
export function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const len = encoded.length;
  const readDelta = (): number => {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < len) {
    lat += readDelta();
    lng += readDelta();
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

// ─── Circle → polygon ────────────────────────────────────────────────────────

/** Great-circle destination point from `[lat,lng]` at `bearing` (rad), `distKm`. */
function destination(
  lat: number,
  lng: number,
  bearingRad: number,
  distKm: number,
): [number, number] {
  const dr = distKm / EARTH_RADIUS_KM;
  const la1 = (lat * Math.PI) / 180;
  const lo1 = (lng * Math.PI) / 180;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(bearingRad),
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(dr) * Math.cos(la1),
      Math.cos(dr) - Math.sin(la1) * Math.sin(la2),
    );
  return [(la2 * 180) / Math.PI, (lo2 * 180) / Math.PI];
}

/**
 * A regular polygon CIRCUMSCRIBING a circle of `radiusKm` around
 * `(centerLat, centerLng)`, as `[lat, lng]` pairs. The ring is CLOSED — the last
 * vertex repeats the first (matching the owner-captured specimen). Vertices sit
 * at `radiusKm · sec(π/n) · safety` from the centre so the polygon fully
 * contains the circle. `nVertices` defaults to {@link CIRCLE_POLYGON_POINTS}.
 */
export function circlePolygon(
  centerLat: number,
  centerLng: number,
  radiusKm: number,
  nVertices: number = CIRCLE_POLYGON_POINTS,
): Array<[number, number]> {
  const n = Math.max(3, Math.floor(nVertices));
  const circumRadius = (radiusKm / Math.cos(Math.PI / n)) * CIRCUMSCRIBE_SAFETY;
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const bearing = (2 * Math.PI * i) / n;
    ring.push(destination(centerLat, centerLng, bearing, circumRadius));
  }
  ring.push([ring[0][0], ring[0][1]]); // close the ring
  return ring;
}

/** The `[lat, lng]` centroid (mean of the distinct vertices) of a closed ring. */
export function polygonCentroid(ring: ReadonlyArray<readonly [number, number]>): [number, number] {
  // Drop the closing duplicate if present so it doesn't double-weight vertex 0.
  const pts =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  const n = pts.length || 1;
  let sLat = 0;
  let sLng = 0;
  for (const [lat, lng] of pts) {
    sLat += lat;
    sLng += lng;
  }
  return [sLat / n, sLng / n];
}

// ─── shape= value + URL ──────────────────────────────────────────────────────

const SHAPE_ORIGIN = "https://www.idealista.com";

/**
 * The percent-encoded value Idealista puts in its `shape` query param: the
 * polygon's Google-encoded polyline wrapped in `((…))`, then URL-escaped the way
 * Idealista does it — `(`→`%28`, `)`→`%29`, and `~`→`%7E` (encodeURIComponent
 * leaves `~` alone; Idealista escapes it). Reproduces the captured specimen
 * byte-for-byte.
 */
export function encodeShapeValue(ring: ReadonlyArray<readonly [number, number]>): string {
  const body = encodePolyline(ring);
  return `%28%28${encodeURIComponent(body).replace(/~/g, "%7E")}%29%29`;
}

/**
 * Decode a raw `shape` query-param value (percent-encoded or not) into its ring
 * of `[lat, lng]` vertices, or null if it isn't the `((<polyline>))` grammar.
 */
export function decodeShapeValue(raw: string): Array<[number, number]> | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const m = /^\(\((.+)\)\)$/.exec(decoded.trim());
  if (!m) return null;
  const ring = decodePolyline(m[1]);
  return ring.length > 0 ? ring : null;
}

/**
 * Build the Idealista drawn-area search URL for a polygon ring:
 *
 *   /areas/<operation>[/con-<t1>,<t2>,…]/mapa-google?shape=((<polyline>))
 *
 * `conTokens` are the same `con-` filter tokens the slug builder emits (price,
 * rooms, size) — they ride in the PATH before `/mapa-google`, exactly where the
 * captured specimen carried `con-precio-hasta_700000`. The `shape` value is
 * percent-encoded per {@link encodeShapeValue}.
 */
export function shapeUrl(
  operation: string,
  conTokens: readonly string[],
  ring: ReadonlyArray<readonly [number, number]>,
  origin: string = SHAPE_ORIGIN,
): string {
  const conPart = conTokens.length > 0 ? `/con-${conTokens.join(",")}` : "";
  return `${origin}/areas/${operation}${conPart}/mapa-google?shape=${encodeShapeValue(ring)}`;
}
