/**
 * Shared helpers for the per-portal URL parsers (capture-to-infer, issue #293).
 *
 * Client-safe: pure code, no `pg`. The parsers (portals/*.ts) and the
 * server-only resolver (resolve.ts) both import from here.
 */

import { PROPERTY_TYPES } from "@/lib/profiles-schema";
import { KNOWN_MUNICIPIOS } from "./municipios";
import { KNOWN_PROVINCES } from "./provinces";
import type { LoosenableConstraint, PropertyType } from "./types";

/**
 * The named placeholders a `template` uses for each continuous numeric value.
 * Chosen to be regex-safe and human-legible when eyeballing a stored template.
 */
export const PLACEHOLDER = {
  priceMin: "{price_min}",
  priceMax: "{price_max}",
  sizeMin: "{size_min}",
  sizeMax: "{size_max}",
} as const;

/** The scope numeric field ↔ placeholder ↔ loosenable-constraint mapping. */
export const NUMERIC_FIELDS = [
  { key: "priceMin", placeholder: PLACEHOLDER.priceMin, constraint: "price_min" },
  { key: "priceMax", placeholder: PLACEHOLDER.priceMax, constraint: "price_max" },
  { key: "sizeMin", placeholder: PLACEHOLDER.sizeMin, constraint: "size_min" },
  { key: "sizeMax", placeholder: PLACEHOLDER.sizeMax, constraint: "size_max" },
] as const satisfies ReadonlyArray<{
  key: "priceMin" | "priceMax" | "sizeMin" | "sizeMax";
  placeholder: string;
  constraint: LoosenableConstraint;
}>;

/** Property types in the canonical PROPERTY_TYPES order (deterministic). */
export function inCanonicalOrder(types: readonly PropertyType[]): PropertyType[] {
  const wanted = new Set(types);
  return PROPERTY_TYPES.filter((t) => wanted.has(t));
}

/**
 * The categorical match axis for an example / profile TASK: the portal section.
 * Under the owner-confirmed slug grammar (#296) each portal searches one
 * section at a time and the section IS the property-type granularity (idealista
 * operation `venta-viviendas`; aliseda tipo-plural `pisos`), so the section
 * alone is the categorical identity we match on. Geography and numeric ranges
 * are matched separately (area by centroid proximity, numerics by
 * substitution). Examples are always scoped to one portal, so a bare section
 * never collides across portals.
 */
export function makeCategoryKey(section: string): string {
  return section;
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km between two `[lat, lng]` points (haversine). */
export function haversineKm(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Centroid of a province bbox `[minLat, minLng, maxLat, maxLng]`. */
function bboxCenter(
  bbox: readonly [number, number, number, number],
): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

/**
 * Approximate `[lat, lng]` centroid for a location slug the parser recovered
 * from a URL, used only for same-rough-area matching — the inverse of how the
 * builders resolve a point to a slug:
 *   - idealista `<municipio>-<provincia>` → the known municipio's centroid;
 *   - idealista `<provincia>-provincia`   → the known province's bbox centre;
 *   - aliseda   `<comunidad>/<provincia>` → the known province's bbox centre.
 * Returns undefined for "" (national) or a slug not in the known tables.
 */
export function centerForLocationSlug(slug: string): [number, number] | undefined {
  if (!slug) return undefined;

  // Aliseda: `<comunidad>/<provincia>`.
  if (slug.includes("/")) {
    const [comunidad, provincia] = slug.split("/");
    const p = KNOWN_PROVINCES.find(
      (kp) => kp.comunidad === comunidad && kp.provincia === provincia,
    );
    return p ? bboxCenter(p.bbox) : undefined;
  }

  // Idealista province fallback: `<provincia>-provincia`.
  if (slug.endsWith("-provincia")) {
    const provincia = slug.slice(0, -"-provincia".length);
    const p = KNOWN_PROVINCES.find((kp) => kp.provincia === provincia);
    return p ? bboxCenter(p.bbox) : undefined;
  }

  // Idealista municipio: `<municipio>-<provincia>`.
  const m = KNOWN_MUNICIPIOS.find((km) => `${km.municipio}-${km.provincia}` === slug);
  return m ? [m.center[0], m.center[1]] : undefined;
}
