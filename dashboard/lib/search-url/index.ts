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
import type {
  CanonicalSearchScope,
  PortalSearchUrl,
  PortalSearchUrlBuilder,
} from "./types";

export type {
  CanonicalSearchScope,
  LoosenableConstraint,
  LoosenedConstraint,
  PortalSearchUrl,
  PortalSearchUrlBuilder,
  PropertyType,
} from "./types";

/** Registered builders, keyed by portal. */
const BUILDERS: Record<string, PortalSearchUrlBuilder> = {
  [idealistaBuilder.portal]: idealistaBuilder,
  [alisedaBuilder.portal]: alisedaBuilder,
};

/** Capture portals that currently have a search-URL builder. */
export const SEARCH_URL_PORTALS: readonly string[] = CAPTURE_PORTALS.map(
  (p) => p.portal,
).filter((portal) => portal in BUILDERS);

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
 * Build the pre-filtered search URL for ONE portal from a profile scope, or
 * null if that portal has no builder registered.
 */
export function buildSearchUrl(portal: string, scope: Scope): PortalSearchUrl | null {
  const builder = BUILDERS[portal];
  if (!builder) return null;
  return builder.build(canonicalScopeFromProfile(scope));
}

/**
 * Build the pre-filtered search URL for every capture portal that has a
 * builder, in CAPTURE_PORTALS order. This is what the guided-capture UI opens
 * (one tab per portal) and what the API route returns for a profile.
 */
export function buildSearchUrls(scope: Scope): PortalSearchUrl[] {
  const canonical = canonicalScopeFromProfile(scope);
  const out: PortalSearchUrl[] = [];
  for (const { portal } of CAPTURE_PORTALS) {
    const builder = BUILDERS[portal];
    if (builder) out.push(builder.build(canonical));
  }
  return out;
}
