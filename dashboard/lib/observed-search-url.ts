/**
 * Pure helpers for the passively-observed search URLs (issue #488, part of #471;
 * generalized to all capture portals in #510). No DB / server imports — safe to
 * use from a server component (the review page) and the API route, and directly
 * unit-testable.
 *
 * Mirrors the extension's browser-extension/observe-search-url.js per-portal
 * specs + host check + normalization so the server re-derives the same de-dup
 * key it stores (never trusting the client) and accepts exactly what the
 * extension forwards, plus the review-only analysis helpers (type badge +
 * `shape=` vertex count) the extension has no need for.
 */

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

// Altamira listing-DETAIL path shape (mirror of the extension + detect.js):
// `/venta-de-<tipo>/…/<numeric-id>[/<photo>]`. Everything else under altamira is
// treated as an observable search page (permissive, #510).
const ALTAMIRA_DETAIL_RE = /^\/(?:venta|alquiler)-de-[^/]+\/.+\/\d+(?:\/\d+)?\/?$/;

// Hipoges listing-DETAIL path shape (mirror of the extension + detect.js,
// grounded in the site's own public Angular route table — see
// etl/connectors/hipoges.py's module docstring): `/<lang>/detail/<id>` or
// `/<lang>/<investment>/detail/<id>`. Everything else under Hipoges is
// treated as an observable search page (permissive, same posture as
// Altamira above — its search-URL grammar is not yet confirmed, D-111).
const HIPOGES_DETAIL_RE = /^\/[a-z]{2}\/(?:[^/]+\/)?detail\/[^/]+/i;

/**
 * Per-portal observer spec — the dashboard mirror of
 * browser-extension/observe-search-url.js's SEARCH_URL_PORTAL_SPECS. Host
 * suffixes match CAPTURE_PORTALS (lib/worklist.ts); the two + the extension must
 * stay in step. The shared unit fixture
 * (dashboard/__tests__/fixtures/search-url-observable.ts) pins server + extension
 * to identical verdicts.
 */
export const SEARCH_URL_PORTAL_SPECS: readonly {
  portal: string;
  hostSuffix: string;
  isSearchPath: (parsed: URL) => boolean;
}[] = [
  {
    portal: "idealista",
    hostSuffix: "idealista.com",
    isSearchPath: (parsed) => {
      const path = parsed.pathname;
      if (/^\/(venta|alquiler)-[a-z]/.test(path)) return true;
      if (/^\/areas(\/|$)/.test(path)) return true;
      if (/^\/multi(\/|$)/.test(path)) return true;
      try {
        if (parsed.searchParams.has("shape")) return true;
      } catch {
        /* ignore */
      }
      return false;
    },
  },
  {
    portal: "aliseda",
    hostSuffix: "alisedainmobiliaria.com",
    isSearchPath: (parsed) => /^\/(comprar|alquilar|alquiler)/.test(parsed.pathname),
  },
  {
    portal: "altamira",
    hostSuffix: "altamirainmuebles.com",
    // Permissive (#510): any non-detail, non-home path — the corpus #514 builds
    // altamira's URL grammar from.
    isSearchPath: (parsed) => {
      const path = parsed.pathname;
      if (path === "/" || path === "") return false;
      return !ALTAMIRA_DETAIL_RE.test(path);
    },
  },
  {
    portal: "hipoges",
    hostSuffix: "realestate.hipoges.com",
    // Permissive (D-111): any non-home, non-detail path — the corpus a
    // future search-URL builder would be reverse-engineered from (D-051's
    // capture-to-infer path), same posture as Altamira above.
    isSearchPath: (parsed) => {
      const path = parsed.pathname;
      if (path === "/" || path === "" || /^\/[a-z]{2}\/?$/i.test(path)) {
        return false; // home / bare locale root, e.g. "/" or "/es"
      }
      return !HIPOGES_DETAIL_RE.test(path);
    },
  },
];

/** The observed-URL "type" the review surface badges. */
export type ObservedUrlType = "areas" | "multi" | "plana";

/**
 * Parse `url` and, if its HOST belongs to a capture portal, return
 * `{ parsed, spec }`; null otherwise. Path is NOT considered here.
 */
function parsePortalUrl(
  url: string,
): { parsed: URL; spec: (typeof SEARCH_URL_PORTAL_SPECS)[number] } | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  for (const spec of SEARCH_URL_PORTAL_SPECS) {
    if (host === spec.hostSuffix || host.endsWith("." + spec.hostSuffix)) {
      return { parsed, spec };
    }
  }
  return null;
}

/**
 * The capture portal for which `url` is an OBSERVABLE search/results page, or
 * null (unsupported host, non-search page, or unparseable). MUST agree with the
 * extension helper's `observablePortalForUrl`.
 */
export function observablePortalForUrl(url: string): string | null {
  const hit = parsePortalUrl(url);
  if (!hit) return null;
  return hit.spec.isSearchPath(hit.parsed) ? hit.spec.portal : null;
}

/**
 * True when `url` is an OBSERVABLE search/results page on any supported capture
 * portal. MUST agree with the extension helper's `isObservableSearchUrl` so the
 * server accepts exactly what the extension forwards. Returns false on any parse
 * failure. Renamed from the idealista-only `isObservableIdealistaUrl` in #510.
 */
export function isObservableSearchUrl(url: string): boolean {
  return observablePortalForUrl(url) !== null;
}

/**
 * Canonical de-dup key for an observed URL — host (lowercased, `www.` stripped)
 * + path (trailing slash stripped) + query params sorted by key (values kept,
 * `shape=` included). Scheme + fragment dropped. Gated on the HOST being a
 * capture portal (not on the search-page predicate) so it stays byte-compatible
 * with the pre-#510 idealista rows. MUST agree with the extension helper's
 * `normalizeObservedUrl`. Returns null for a non-portal-host / unparseable URL.
 */
export function normalizeObservedUrl(url: string): string | null {
  const hit = parsePortalUrl(url);
  if (!hit) return null;
  const parsed = hit.parsed;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  let query = "";
  try {
    const pairs = [...parsed.searchParams.entries()];
    pairs.sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
    );
    query = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  } catch {
    query = "";
  }
  return host + path + (query ? "?" + query : "");
}

/**
 * Classify an observed URL for the review badge:
 *   - "multi" — a `/multi/…` multi-zone search
 *   - "areas" — an `/areas/…` drawn-zone aggregate search
 *   - "plana" — a plain `/venta-…`/`/alquiler-…` listado (path-based filters)
 * Falls back to "plana" for anything else observable (e.g. a bare host + shape).
 */
export function observedUrlType(url: string): ObservedUrlType {
  const hit = parsePortalUrl(url);
  const path = hit ? hit.parsed.pathname : "";
  if (/^\/multi(\/|$)/.test(path)) return "multi";
  if (/^\/areas(\/|$)/.test(path)) return "areas";
  return "plana";
}

/**
 * Decode a Google-style encoded polyline and return the number of coordinate
 * pairs (vertices) it encodes. Each point is a self-delimiting pair of signed
 * varints, so a CONCATENATION of several encoded polylines decodes to the sum
 * of their vertices — which is exactly what we want for a multi-polygon shape.
 * Best-effort: a malformed tail simply stops the count.
 */
function decodePolylineVertexCount(encoded: string): number {
  let index = 0;
  let count = 0;
  const len = encoded.length;
  while (index < len) {
    // Two varints per vertex (lat, then lng); we only need to walk them.
    for (let coord = 0; coord < 2; coord++) {
      let b: number;
      do {
        if (index >= len) return count; // truncated — stop cleanly
        b = encoded.charCodeAt(index++) - 63;
      } while (b >= 0x20);
    }
    count++;
  }
  return count;
}

/**
 * The number of drawn-zone vertices encoded in the URL's `shape=` param, or
 * null when the URL carries no `shape=`. Idealista encodes the drawn polygon(s)
 * as a Google-style polyline wrapped in parentheses (`((<enc>))`, and nested
 * groups for multi-polygon); we strip the wrapping parens and decode the
 * remaining polyline stream, so multi-zone shapes sum correctly. A best-effort
 * signal for quick analysis (#471), not a geometric guarantee.
 */
export function shapeVertexCount(url: string): number | null {
  let raw: string | null = null;
  try {
    raw = new URL(url.trim()).searchParams.get("shape");
  } catch {
    return null;
  }
  if (raw == null || raw === "") return null;
  const enc = raw.replace(/[()]/g, "");
  if (!enc) return 0;
  return decodePolylineVertexCount(enc);
}
