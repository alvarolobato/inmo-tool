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
import type { CodeMappingAxes } from "./drift";

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

/**
 * One discrete, openable pre-filtered search TASK (issue #277 restructure).
 *
 * A portal can search only ONE section at a time (idealista: one property-type
 * operation section; aliseda: one property-type path segment), so a single
 * profile fans out into SEVERAL tasks — one openable URL per (portal × section)
 * — instead of one merged URL with a "types widened" note. The Captura UI shows
 * each task as its own button.
 */
export interface SearchTask {
  /**
   * Stable, deterministic id — the SAME profile + filters always reproduce the
   * SAME id (a hash of portal + normalized filters; see ./task-id.ts). A
   * separate UI feature records last-run time keyed on this.
   */
  id: string;
  /** Portal key — matches `CAPTURE_PORTALS[].portal` in lib/worklist.ts. */
  portal: string;
  /** Human, Spanish-facing label, e.g. "Idealista — pisos en Estepona ≤200.000 €". */
  label: string;
  /** The openable, pre-filtered search URL. */
  url: string;
  /** Constraints the portal's URL grammar had to broaden (never narrow). */
  loosened: LoosenedConstraint[];
  /**
   * True when the URL came from a `profile_connector_filter` override — the
   * owner pinned it by hand (tier 0, issue #478). Verbatim, `loosened: []`.
   * Undefined/false for a derived (builder or learned-example) task.
   */
  overridden?: boolean;
}

/** A per-portal search-URL builder. One per capture-capable portal. */
export interface PortalSearchUrlBuilder {
  /** Portal key — matches `CAPTURE_PORTALS[].portal` in lib/worklist.ts. */
  readonly portal: string;
  /**
   * Map canonical scope → this portal's pre-filtered search TASKS (one per
   * searchable section; at least one).
   */
  build(scope: CanonicalSearchScope): SearchTask[];
  /**
   * This connector's CODE mapping, per axis — the hard-coded slugs/codes the
   * builder emits, exposed so drift detection (lib/search-url/drift.ts) can diff
   * them against the portal's captured filter catalog (issue #371, D-090). Pure
   * & static; every URL-building portal implements it.
   */
  codeMapping(): CodeMappingAxes;
}

// ─── Capture-to-infer: learn URL grammars from real navigated URLs (issue #293)

/**
 * The decoded, portal-neutral filters a {@link PortalSearchUrlParser.parse}
 * recovers from a real search URL — the best-effort structural inverse of what
 * {@link PortalSearchUrlBuilder.build} encoded. A field the parser did not
 * recognise is simply left undefined (never fabricated).
 *
 * Geography under the owner-confirmed slug grammar (#296) rides in the URL PATH
 * as a `<municipio>-<provincia>` (idealista) or `<comunidad>/<provincia>`
 * (aliseda) slug — NOT a polyline. `locationSlug` is that literal path segment;
 * `center` is its approximate `[lat, lng]` centroid resolved from the known
 * municipio/province tables, used only for same-rough-area matching (both
 * undefined for a national / unresolved search).
 */
export interface ParsedSearchFilters {
  /** Portal section the URL targets (idealista operation / aliseda tipo-plural). */
  section: string;
  /** Property types the URL narrows to, in canonical order. */
  propertyTypes: PropertyType[];
  /** The literal location path slug the URL carries, or "" (national/unresolved). */
  locationSlug: string;
  priceMin?: number;
  priceMax?: number;
  sizeMin?: number;
  sizeMax?: number;
  roomsMin?: number;
  /** Approximate `[lat, lng]` centroid of `locationSlug`, when resolvable. */
  center?: [number, number];
  /**
   * How the URL expresses geography (issue #471):
   *   - undefined → the legacy `<municipio>-<provincia>` slug in the path;
   *   - `"shape"` → an `/areas/…?shape=((<polyline>))` drawn polygon (the
   *     builder's new default). `shapeVertexCount` carries the ring size and
   *     `center` the polygon centroid;
   *   - `"multi"` → a `/multi/venta-viviendas/<zone-codes>/…` multi-zone URL
   *     (recognised as an opaque, verbatim pinned-override shape — not generated).
   * Both `"shape"` and `"multi"` are CONCRETE, code-pinned geometry: the
   * resolver never lets a learned example relocate them (see resolve.ts, #444).
   */
  geoKind?: "shape" | "multi";
  /** Vertex count of a decoded `shape` polygon (geoKind === "shape"). */
  shapeVertexCount?: number;
}

/**
 * The result of decoding one real search URL: the recognised filters, a
 * deterministic `categoryKey` (the CATEGORICAL axis we match a profile on
 * exactly — section + sorted property types, never geography or numeric
 * ranges), and a `template` — the original URL with every continuous numeric
 * value swapped for a named placeholder (`{price_min}` …) so a profile's own
 * values can be substituted back in later. Everything the parser did NOT
 * recognise stays literal in `template`.
 */
export interface ParsedSearchUrl {
  filters: ParsedSearchFilters;
  categoryKey: string;
  template: string;
}

/**
 * A per-portal URL parser — the structural inverse of the same portal's
 * {@link PortalSearchUrlBuilder}. One per capture-capable portal that supports
 * capture-to-infer (issue #293). Kept honest by round-trip tests:
 * `parse(build(scope))` decodes back to `scope`'s filters, and re-substituting
 * those filters into `template` reproduces the original URL byte-for-byte.
 */
export interface PortalSearchUrlParser {
  /** Portal key — matches the builder's `portal`. */
  readonly portal: string;
  /** Decode a real search URL, or null if it isn't this portal's search grammar. */
  parse(url: string): ParsedSearchUrl | null;
  /**
   * Substitute a profile scope's numeric values into a stored `template`,
   * returning the resulting URL and any profile constraints the template had no
   * placeholder for (the portal genuinely can't express them → broadened,
   * reported like `build()` does).
   */
  substitute(
    template: string,
    scope: CanonicalSearchScope,
  ): { url: string; unfilled: LoosenableConstraint[] };
}
