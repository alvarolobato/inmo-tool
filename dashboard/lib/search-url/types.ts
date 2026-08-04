/**
 * Per-portal pre-filtered search-URL builder — shared types (issue #267).
 *
 * Client-safe: pure types + no `pg` import, so the guided-capture UI (client
 * component) and the API route (server) can both import from this directory.
 *
 * The point of the module: turn a search profile's canonical scope
 * (geography radius, price band, property types, size band) into the search
 * URL each capture-capable portal understands, so "Abrir búsqueda" / "Empezar
 * captura" opens the portal already filtered to the profile. From there the
 * batch-capture-from-listing flow (#262) takes over.
 *
 * Best-effort by contract (issue #267): if a portal's URL grammar cannot
 * express a constraint, the builder MUST loosen it to something BROADER (more
 * results, never fewer) and record a {@link LoosenedConstraint} naming what it
 * dropped or widened — a hard constraint is never silently discarded.
 */

import type { PROPERTY_TYPES } from "@/lib/profiles-schema";

export type PropertyType = (typeof PROPERTY_TYPES)[number];

/**
 * The canonical, portal-neutral search criteria a builder consumes. Derived
 * from a profile's `Scope` by {@link import("./index").canonicalScopeFromProfile}.
 *
 * NB the current profile scope carries geography as a radius around a geocoded
 * point (lat/lng + km) — NOT a municipality name or slug — and has no rooms
 * field. `roomsMin` is kept here so a portal grammar can express rooms the day
 * the scope grows one; today the normaliser never sets it. See the module
 * README (docs/skills/search-url-builder.md) for the mapping table.
 */
export interface CanonicalSearchScope {
  /** Geocoded centre of the search radius, `[lat, lng]`. */
  center: readonly [number, number];
  /** Search radius in kilometres (profile geography is radius-from-a-point). */
  radiusKm: number;
  /** Property types the profile wants; at least one. */
  propertyTypes: readonly PropertyType[];
  /** Lower price bound in EUR, if the profile sets one. */
  priceMin?: number;
  /** Upper price bound in EUR, if the profile sets one. */
  priceMax?: number;
  /** Lower built-area bound in m², if the profile sets one. */
  sizeMin?: number;
  /** Upper built-area bound in m², if the profile sets one. */
  sizeMax?: number;
  /** Minimum rooms — reserved; profile scope has none today (see above). */
  roomsMin?: number;
}

/** The scope constraints a builder can report as dropped or widened. */
export type LoosenableConstraint =
  | "geography"
  | "property_types"
  | "price_min"
  | "price_max"
  | "size_min"
  | "size_max"
  | "rooms";

/**
 * A constraint the portal's URL grammar could not honour exactly. The builder
 * always errs BROADER (surfaces more listings), so the operator sees every
 * on-target property; `reason` explains what was widened so the UI can warn
 * "esta búsqueda es más amplia que el perfil (…)".
 */
export interface LoosenedConstraint {
  constraint: LoosenableConstraint;
  /** Human-readable (Spanish-facing) note on how it was broadened. */
  reason: string;
}

/** One portal's pre-filtered search URL plus any constraints it had to widen. */
export interface PortalSearchUrl {
  portal: string;
  url: string;
  loosened: LoosenedConstraint[];
}

/** A per-portal search-URL builder. One per capture-capable portal. */
export interface PortalSearchUrlBuilder {
  /** Portal key — matches `CAPTURE_PORTALS[].portal` in lib/worklist.ts. */
  readonly portal: string;
  /** Map canonical scope → this portal's pre-filtered search URL. */
  build(scope: CanonicalSearchScope): PortalSearchUrl;
}
