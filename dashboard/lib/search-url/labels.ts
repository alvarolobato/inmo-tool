/**
 * Human, Spanish-facing label helpers for search tasks (issue #277).
 *
 * Labels are cosmetic (the openable URL is the load-bearing part), so these are
 * deliberately simple. They are shared by both portal builders so a task always
 * reads the same way, e.g. "Idealista — pisos en Estepona ≤200.000 €".
 */

import type { PropertyType } from "./types";

/** Display name per portal key. */
export function portalDisplayName(portal: string): string {
  if (portal === "idealista") return "Idealista";
  if (portal === "aliseda") return "Aliseda";
  return portal.length > 0 ? portal[0].toUpperCase() + portal.slice(1) : portal;
}

/** Spanish plural (accented) of each property type, for display in a label. */
const DISPLAY_PLURAL: Record<PropertyType, string> = {
  piso: "pisos",
  chalet: "chalets",
  atico: "áticos",
  local: "locales",
  nave: "naves",
  garaje: "garajes",
  terreno: "terrenos",
  edificio: "edificios",
};

/** Comma-joined display plurals for a set of types, e.g. "pisos, áticos". */
export function typesLabel(types: readonly PropertyType[]): string {
  return types.map((t) => DISPLAY_PLURAL[t]).join(", ");
}

/** Turn a URL slug like `estepona-malaga` or `andalucia/malaga` into "Estepona". */
export function locationLabel(slug: string): string {
  if (!slug) return "toda España";
  // Take the first path/segment token and title-case its words.
  const first = slug.split("/")[0].split("-")[0];
  return first.length > 0 ? first[0].toUpperCase() + first.slice(1) : slug;
}

/** " ≤200.000 €" / " ≥50.000 €" / " 50.000–200.000 €" / "" (thousands with es-ES). */
export function priceLabel(min?: number, max?: number): string {
  const fmt = (n: number) => Math.round(n).toLocaleString("es-ES");
  if (min !== undefined && max !== undefined) return ` ${fmt(min)}–${fmt(max)} €`;
  if (max !== undefined) return ` ≤${fmt(max)} €`;
  if (min !== undefined) return ` ≥${fmt(min)} €`;
  return "";
}

/** Assemble the full task label: "<Portal> — <types> en <location><price>". */
export function taskLabel(
  portal: string,
  types: readonly PropertyType[],
  locationSlug: string,
  priceMin?: number,
  priceMax?: number,
): string {
  return `${portalDisplayName(portal)} — ${typesLabel(types)} en ${locationLabel(locationSlug)}${priceLabel(priceMin, priceMax)}`;
}

/**
 * Label for a drawn-polygon (shape) task (issue #471): a polyline is not
 * self-describing the way `dos-hermanas-sevilla` was, so the label keeps the
 * nearest-municipio name (or province, or "zona") plus the radius so the
 * operator can tell what area a task covers — e.g.
 * "Idealista — pisos ~Dos Hermanas (r=5 km) ≤200.000 €".
 */
export function shapeTaskLabel(
  portal: string,
  types: readonly PropertyType[],
  nearestName: string,
  radiusKm: number,
  priceMin?: number,
  priceMax?: number,
): string {
  const km = Math.round(radiusKm * 10) / 10;
  return `${portalDisplayName(portal)} — ${typesLabel(types)} ~${nearestName} (r=${km} km)${priceLabel(priceMin, priceMax)}`;
}

/**
 * The inline prefix a LoosenedConstraint renders with in the UI (issue #561
 * review, N6). Every constraint except "grammar" names a specific dropped or
 * broadened VALUE inside an otherwise-confirmed grammar, so "ampliada:"
 * ("broadened:") is accurate for it. "grammar" is different in kind: it
 * flags that a TOKEN in the URL itself is an unconfirmed guess -- the search
 * may not be broader at all, it may be a wrong page entirely (a 404 or a
 * redirect elsewhere) -- so "ampliada:" would misstate the risk.
 */
export function loosenedPrefixLabel(constraint: string): string {
  return constraint === "grammar" ? "sin confirmar:" : "ampliada:";
}
