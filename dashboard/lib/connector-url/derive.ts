/**
 * On-demand "derived" ETL-connector preview URL (issue #513).
 *
 * The "Validar filtros" page shows one row per registered ETL connector. Before
 * the ETL has swept a profile for the first time, that connector has NO
 * `connector_search_preview` row yet, so the row was URL-less ("pendiente de la
 * próxima ejecución del ETL") — the "pisos has no URL" trap the owner hit.
 *
 * This closes that gap WITHOUT any per-connector TypeScript (D-… grammar
 * design): a connector that publishes a {@link SearchUrlGrammar} already carries
 * everything needed to BUILD its entry URL in the browser. We resolve the
 * profile's geography to the slug the grammar's `source:"profile"` params expect
 * (the same province/municipio helpers the capture-portal resolver uses) and
 * fill them via {@link buildUrl}. The result is labelled "derivada (sin
 * verificar por ETL)" — it is a best-effort recall preview, NOT the authoritative
 * URL, which "Recalcular" (a real offline `search_previews()` run) still owns.
 *
 * Safety, generically enforced (never a per-connector special case):
 *  - the built URL must ROUND-TRIP its own grammar (`inferParams` ≠ null) —
 *    grammars with additional non-profile placeholders (fotocasa's zone, unicaja's
 *    many query fields) leave those empty, don't round-trip, and correctly fall
 *    back to the honest "pending" note rather than surfacing a malformed URL;
 *  - the built URL must not be a robots-forbidden shape (`rejection` == null),
 *    the same gate the pin flow enforces at save time.
 *
 * Server-only usage (the page loader) but pure — no DB, no `pg`.
 */

import type { Scope } from "@/lib/profiles-schema";
import { provinceForPoint } from "@/lib/search-url/provinces";
import { buildUrl, inferParams, rejection, type SearchUrlGrammar } from "./parse";

/** A best-effort, ETL-unverified preview built from the grammar for a profile. */
export interface DerivedPreview {
  /** The built entry URL (guaranteed to round-trip its grammar, not rejected). */
  url: string;
  /** The geography slug the profile resolved to (for the note / debugging). */
  geoSlug: string;
}

/**
 * Build a derived entry URL for `grammar` from `scope`, or null when the profile
 * geography can't be resolved to a slug or the built URL wouldn't round-trip /
 * would be robots-rejected (both → keep the honest "pending" note).
 *
 * Every `source:"profile"` grammar param is filled with the resolved province
 * slug — the safest single value: it is exactly what the province-keyed
 * connectors expect, and a valid (broader, never narrower) search term for the
 * city-slug connectors. Non-profile placeholders are left empty; the round-trip
 * gate then quietly drops any grammar for which that leaves a malformed URL.
 */
export function deriveGrammarPreview(
  grammar: SearchUrlGrammar,
  scope: Scope,
): DerivedPreview | null {
  // Issue #659/D-147: an "everywhere" scope has no center to resolve a
  // province slug from — same "keep the honest pending note" fallback as
  // an unresolvable center already had, not a crash on `.center`.
  const center = scope.geography.type === "radius" ? scope.geography.center : null;
  if (!center) return null;
  const province = provinceForPoint(center);
  const geoSlug = province?.provincia ?? null;
  if (geoSlug === null) return null;

  const params: Record<string, string> = {};
  for (const [key, meta] of Object.entries(grammar.params)) {
    if (meta.source === "profile") params[key] = geoSlug;
  }
  // No profile-sourced param to fill → nothing meaningful to derive.
  if (Object.keys(params).length === 0) return null;

  const url = buildUrl(grammar, params);
  // Only surface a URL the grammar can invert AND that isn't robots-forbidden —
  // otherwise fall back to the pending note (a malformed/blocked derived URL is
  // worse than none).
  if (inferParams(grammar, url) === null) return null;
  if (rejection(grammar, url) !== null) return null;
  return { url, geoSlug };
}
