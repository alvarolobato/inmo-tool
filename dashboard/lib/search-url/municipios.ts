/**
 * lat/lng → municipio (+ provincia) mapping for portals that search by a city
 * slug (issue #277, owner-reported idealista fix 2026-08-05).
 *
 * Idealista's pre-filtered URL is keyed on a `<municipio>-<provincia>` path
 * segment (finer than Aliseda's province-level `<comunidad>/<provincia>`), e.g.
 * `estepona-malaga`. The profile scope carries geography as a radius around a
 * geocoded point, not a city name, so we resolve the point to the NEAREST known
 * municipio centroid within {@link MAX_MATCH_KM}. Outside that radius we return
 * null and the caller falls back to a province-level (or national) search and
 * flags the geography as broadened — broader, never narrower.
 *
 * As with provinces.ts, a single-operator tool covering two markets does not
 * need a geocoder: a small centroid table of the towns we actually work in is
 * enough. Add rows as new towns come up.
 */

/** A Spanish municipio the tool operates in, with its idealista slugs + centroid. */
export interface KnownMunicipio {
  /** Municipio URL slug, e.g. `"estepona"`. */
  municipio: string;
  /** Province URL slug the municipio belongs to, e.g. `"malaga"`. */
  provincia: string;
  /** Approximate town-centre `[lat, lng]` (WGS84) for nearest-match. */
  center: readonly [number, number];
}

/** Furthest a point may sit from a known centroid and still resolve to it (km). */
export const MAX_MATCH_KM = 12;

/**
 * Municipios in the tool's two markets (Costa del Sol / málaga and greater
 * Sevilla). Idealista city slugs follow `<municipio>-<provincia>` even for
 * capitals (`malaga-malaga`, `sevilla-sevilla`). Owner-confirmed example
 * (2026-08-05): Estepona (36.4268, -5.1468) → `estepona-malaga`.
 */
export const KNOWN_MUNICIPIOS: readonly KnownMunicipio[] = [
  // Costa del Sol — province málaga.
  { municipio: "estepona", provincia: "malaga", center: [36.4268, -5.1468] }, // owner-confirmed
  { municipio: "manilva", provincia: "malaga", center: [36.3766, -5.2493] },
  { municipio: "marbella", provincia: "malaga", center: [36.5099, -4.8863] },
  { municipio: "mijas", provincia: "malaga", center: [36.5959, -4.637] },
  { municipio: "fuengirola", provincia: "malaga", center: [36.5397, -4.6244] },
  { municipio: "benalmadena", provincia: "malaga", center: [36.5988, -4.5166] },
  { municipio: "torremolinos", provincia: "malaga", center: [36.6249, -4.4996] },
  { municipio: "malaga", provincia: "malaga", center: [36.7213, -4.4214] },
  // Greater Sevilla — province sevilla.
  { municipio: "sevilla", provincia: "sevilla", center: [37.3891, -5.9845] },
  { municipio: "dos-hermanas", provincia: "sevilla", center: [37.2836, -5.9222] },
  { municipio: "alcala-de-guadaira", provincia: "sevilla", center: [37.3387, -5.8386] },
  { municipio: "mairena-del-aljarafe", provincia: "sevilla", center: [37.34, -6.0728] },
];

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two `[lat, lng]` points, in kilometres. */
function haversineKm(a: readonly [number, number], b: readonly [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The known municipio nearest to `center` within {@link MAX_MATCH_KM}, or null
 * if the point is too far from every known town (caller broadens + flags).
 */
export function municipioForPoint(center: readonly [number, number]): KnownMunicipio | null {
  let best: KnownMunicipio | null = null;
  let bestKm = Infinity;
  for (const m of KNOWN_MUNICIPIOS) {
    const km = haversineKm(center, m.center);
    if (km < bestKm) {
      bestKm = km;
      best = m;
    }
  }
  return best !== null && bestKm <= MAX_MATCH_KM ? best : null;
}
