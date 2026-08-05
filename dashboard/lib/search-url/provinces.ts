/**
 * lat/lng → (comunidad, provincia) mapping for portals that search by Spanish
 * administrative-area slugs instead of a radius (issue #277, owner-reported
 * fix 2026-08-05).
 *
 * The profile scope carries geography as a radius around a geocoded point — NOT
 * a province name. Aliseda's pre-filtered search URL, however, is keyed on
 * `<comunidad>/<provincia>` path slugs, so we need to reduce the point to the
 * province that contains it. A single-operator tool covering two markets
 * (Costa del Sol and greater Sevilla) does NOT need a real geocoder: a small
 * bounding-box table of the provinces we actually operate in is sufficient and
 * easy to extend — add a row per province, ordered most-specific first.
 *
 * If a point falls outside every known box, {@link provinceForPoint} returns
 * null and the caller falls back to a broader (province-less) search and flags
 * the geography as loosened — broader, never narrower.
 */

/** A Spanish province the tool operates in, with its URL slugs + bounding box. */
export interface KnownProvince {
  /** Province URL slug, e.g. `"malaga"`. */
  provincia: string;
  /** Autonomous-community URL slug the province belongs to, e.g. `"andalucia"`. */
  comunidad: string;
  /**
   * Axis-aligned bounding box `[minLat, minLng, maxLat, maxLng]` (WGS84).
   * Deliberately generous — matching to the right province matters more than
   * hair-splitting a shared border, and over-matching only broadens the search.
   */
  bbox: readonly [number, number, number, number];
}

/**
 * The provinces this tool covers. Ordered most-specific first: a point in an
 * overlapping border strip resolves to the earlier entry (Costa del Sol before
 * Sevilla). Extend by adding rows.
 */
export const KNOWN_PROVINCES: readonly KnownProvince[] = [
  // Málaga / Costa del Sol. Owner-confirmed example (2026-08-05): Estepona
  // (36.4268, -5.1468) → andalucia/malaga.
  { provincia: "malaga", comunidad: "andalucia", bbox: [36.28, -5.62, 37.28, -3.68] },
  // Greater Sevilla.
  { provincia: "sevilla", comunidad: "andalucia", bbox: [36.95, -6.55, 38.13, -4.55] },
];

/**
 * The known province whose bounding box contains `center` (`[lat, lng]`), or
 * null if the point is outside every box (caller broadens + flags geography).
 */
export function provinceForPoint(center: readonly [number, number]): KnownProvince | null {
  const [lat, lng] = center;
  for (const p of KNOWN_PROVINCES) {
    const [minLat, minLng, maxLat, maxLng] = p.bbox;
    if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) return p;
  }
  return null;
}
