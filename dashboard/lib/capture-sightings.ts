/**
 * Sighting-id extraction for the guided-capture worklist path (issue #639
 * review, C1) — the TypeScript mirror of `etl/capture.py`'s
 * `_sighting_ids_from_detail_urls` / `_normalize_detail_path` /
 * `_GONE_URL_SUFFIXES`.
 *
 * Why this exists in TWO languages: `etl/capture.py`'s sighting write only
 * runs for a manually-captured single results page whose HTML lands in
 * `extension_capture` — the PRODUCTION path (D-088's results-page walk,
 * `browser-extension/background.js` `renderAndHarvest`) never posts HTML to
 * `POST /api/extension/capture` at all. It POSTs the harvested detail URLs
 * straight to `POST /api/etl/worklist { via: 'derived' }`
 * (`lib/db/worklist.ts` `addWorklistUrls`), which runs in THIS Node process
 * against the SAME `listing` table. This module is the id-extraction logic
 * that write needs, kept pure/client-safe (no `pg` import) so it stays
 * trivially unit-testable — mirroring the `lib.ts`/`lib/db` split this
 * codebase already uses elsewhere (`lib/worklist.ts` vs `lib/db/worklist.ts`).
 *
 * MUST stay in lockstep with `etl/capture.py`'s Python versions — both are
 * covered by a shared table of (portal, url) -> id cases asserted in each
 * language's own suite (`etl/tests/test_capture.py::TestSightingIdExtraction`
 * / `lib/__tests__/capture-sightings.test.ts`).
 */

// Mirrors etl/capture.py's per-connector `_EXTERNAL_ID_RE` / the regex each
// connector's own `external_id_from_url` uses.
const EXTERNAL_ID_PATTERNS: Readonly<Record<string, RegExp>> = {
  idealista: /\/inmueble\/(\d+)\//,
  aliseda: /\/inmueble\/([A-Za-z0-9._-]+)/,
  altamira: /\/(\d{4,})(?:\/\d+)?\/?$/,
  hipoges: /\/[a-z]{2}\/(?:[^/]+\/)?detail\/([^/?#]+)/i,
};

// Mirrors etl/capture.py's `_GONE_URL_SUFFIXES` (issue #639 review, C3): the
// portal's OWN "this advert is gone" route must never count as a sighting.
const GONE_URL_SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  hipoges: ["/unavailable", "/contact-received"],
};

/**
 * The bare PATH of a harvested detail href — query string and fragment
 * stripped, trailing slash guaranteed. Returns "" for an unparseable URL.
 *
 * Mirrors `etl/capture.py`'s `_normalize_detail_path` (issue #639 review,
 * C4): a harvested URL (a walked results page's own DOM, or a `<a href>`)
 * can carry a query string, a fragment, or lack the trailing slash a
 * connector's id regex was calibrated for — see that function's docstring
 * for the full reasoning.
 */
export function normalizeDetailPath(href: string): string {
  let path: string;
  try {
    path = new URL(href).pathname;
  } catch {
    return "";
  }
  if (path && !path.endsWith("/")) path += "/";
  return path;
}

/**
 * External id for one harvested detail URL under `portal`, or null when the
 * portal is unknown, no id can be extracted, or the URL's normalized path
 * matches the portal's own "this advert is gone" route
 * ({@link GONE_URL_SUFFIXES}, issue #639 review C3).
 */
export function sightingIdFromUrl(portal: string, url: string): string | null {
  const pattern = EXTERNAL_ID_PATTERNS[portal];
  if (!pattern) return null;
  const path = normalizeDetailPath(url);
  if (!path) return null;
  const goneSuffixes = GONE_URL_SUFFIXES[portal];
  if (goneSuffixes) {
    const trimmed = path.replace(/\/+$/, "");
    if (goneSuffixes.some((suffix) => trimmed.endsWith(suffix))) return null;
  }
  const match = pattern.exec(path);
  return match ? match[1] : null;
}

/**
 * External ids for a batch of harvested (portal, url) pairs, grouped by
 * portal — de-duped per portal, insertion-order preserved. A pair that
 * doesn't resolve to an id (unknown portal, unextractable shape, or a
 * portal 'gone' route) is silently dropped from the result; a caller that
 * wants a drop count should compare the returned per-portal counts against
 * how many pairs it passed in for that portal.
 */
export function sightingIdsByPortal(
  pairs: readonly { portal: string; url: string }[],
): Map<string, string[]> {
  const byPortal = new Map<string, Set<string>>();
  for (const { portal, url } of pairs) {
    const id = sightingIdFromUrl(portal, url);
    if (id == null) continue;
    let set = byPortal.get(portal);
    if (!set) {
      set = new Set();
      byPortal.set(portal, set);
    }
    set.add(id);
  }
  const result = new Map<string, string[]>();
  for (const [portal, ids] of byPortal) result.set(portal, [...ids]);
  return result;
}
