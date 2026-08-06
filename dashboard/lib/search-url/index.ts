/**
 * Per-portal PRE-FILTERED search-URL builder (issue #267).
 *
 * Public entry point. Turns a profile's canonical `Scope` into the search URL
 * each capture-capable portal understands, so guided capture ("Abrir búsqueda"
 * / "Empezar captura") opens the portal already filtered to the profile.
 *
 * Add a portal in three steps, all local:
 *   1. Add it to CAPTURE_PORTALS in lib/worklist.ts (the capture roster).
 *   2. Write a builder in ./portals/<name>.ts implementing PortalSearchUrlBuilder.
 *   3. Register it in BUILDERS below.
 * A capture portal with no builder is simply skipped (buildSearchUrls omits
 * it) — no crash, so the roster and the builder set can grow independently.
 *
 * Client-safe: only pure code + client-safe type imports (lib/profiles-schema,
 * lib/worklist). No `pg`.
 */

import type { Scope } from "@/lib/profiles-schema";
import { CAPTURE_PORTALS } from "@/lib/worklist";
import { idealistaBuilder } from "./portals/idealista";
import { alisedaBuilder } from "./portals/aliseda";
import type { CodeMappingAxes } from "./drift";
import type {
  CanonicalSearchScope,
  PortalSearchUrlBuilder,
  SearchTask,
} from "./types";

export type {
  CanonicalSearchScope,
  LoosenableConstraint,
  LoosenedConstraint,
  PortalSearchUrlBuilder,
  PropertyType,
  SearchTask,
} from "./types";

/**
 * Registered builders, keyed by portal. Exported so the server-only resolver
 * (./resolve.ts, issue #293) can reuse the exact same hand-written builders as
 * its fallback layer and to derive a profile's categoryKey (build → parse).
 */
export const BUILDERS: Record<string, PortalSearchUrlBuilder> = {
  [idealistaBuilder.portal]: idealistaBuilder,
  [alisedaBuilder.portal]: alisedaBuilder,
};

/** Capture portals that currently have a search-URL builder. */
export const SEARCH_URL_PORTALS: readonly string[] = CAPTURE_PORTALS.map(
  (p) => p.portal,
).filter((portal) => portal in BUILDERS);

/**
 * A connector's hard-coded CODE mapping (for drift detection, issue #371 /
 * D-090), or null if it has no registered builder. The route/page diffs this
 * against the portal's captured filter catalog via lib/search-url/drift.ts.
 */
export function codeMappingForPortal(portal: string): CodeMappingAxes | null {
  const builder = BUILDERS[portal];
  return builder ? builder.codeMapping() : null;
}

/**
 * Reduce a profile `Scope` to the portal-neutral criteria the builders
 * consume. Geography is a radius around a geocoded point; there is no rooms
 * field in the scope today (so `roomsMin` is never set — see types.ts).
 */
export function canonicalScopeFromProfile(scope: Scope): CanonicalSearchScope {
  return {
    center: scope.geography.center,
    radiusKm: scope.geography.radius_km,
    propertyTypes: scope.property_types,
    priceMin: scope.price_min,
    priceMax: scope.price_max,
    sizeMin: scope.size_min,
    sizeMax: scope.size_max,
  };
}

/**
 * Build the pre-filtered search TASKS for ONE portal from a profile scope, or
 * null if that portal has no builder registered. A portal can yield several
 * tasks (one per searchable section — see SearchTask).
 */
export function buildSearchUrl(portal: string, scope: Scope): SearchTask[] | null {
  const builder = BUILDERS[portal];
  if (!builder) return null;
  return builder.build(canonicalScopeFromProfile(scope));
}

/**
 * Build the flat list of pre-filtered search TASKS across every capture portal
 * that has a builder, in CAPTURE_PORTALS order (idealista tasks, then aliseda,
 * …). Each task is one openable, pre-filtered URL for a single (portal ×
 * section). This is what the API route returns for a profile; the Captura UI
 * renders each task as its own "Abrir búsqueda" button.
 */
export function buildSearchUrls(scope: Scope): SearchTask[] {
  const canonical = canonicalScopeFromProfile(scope);
  const out: SearchTask[] = [];
  for (const { portal } of CAPTURE_PORTALS) {
    const builder = BUILDERS[portal];
    if (builder) out.push(...builder.build(canonical));
  }
  return out;
}
