/**
 * Pure helpers for the passively-observed Idealista search URLs (issue #488,
 * part of #471). No DB / server imports — safe to use from a server component
 * (the review page) and the API route, and directly unit-testable.
 *
 * Mirrors the extension's browser-extension/observe-search-url.js host check +
 * normalization so the server re-derives the same de-dup key it stores (never
 * trusting the client), plus the review-only analysis helpers (type badge +
 * `shape=` vertex count) the extension has no need for.
 */

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);
// #488/#471 target Idealista only — the drawn-zone/`shape=` grammar is theirs.
export const IDEALISTA_HOST_SUFFIX = "idealista.com";

/** The observed-URL "type" the review surface badges. */
export type ObservedUrlType = "areas" | "multi" | "plana";

/** Parse `url` to a URL only for a valid http(s) idealista.com host, else null. */
function parseIdealista(url: string): URL | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== IDEALISTA_HOST_SUFFIX && !host.endsWith("." + IDEALISTA_HOST_SUFFIX)) {
    return null;
  }
  return parsed;
}

/**
 * True when `url` is an Idealista search/results page worth observing (a
 * `/venta-…`/`/alquiler-…` listado, an `/areas/…` or `/multi/…` path, or any
 * Idealista URL carrying `shape=`). MUST agree with the extension helper's
 * `isObservableIdealistaUrl` so the server accepts exactly what the extension
 * forwards. Returns false on any parse failure.
 */
export function isObservableIdealistaUrl(url: string): boolean {
  const parsed = parseIdealista(url);
  if (!parsed) return false;
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
}

/**
 * Canonical de-dup key for an observed URL — host (lowercased, `www.` stripped)
 * + path (trailing slash stripped) + query params sorted by key (values kept,
 * `shape=` included). Scheme + fragment dropped. MUST agree with the extension
 * helper's `normalizeObservedUrl`. Returns null for a non-observable /
 * unparseable URL.
 */
export function normalizeObservedUrl(url: string): string | null {
  const parsed = parseIdealista(url);
  if (!parsed) return null;
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
  const parsed = parseIdealista(url);
  const path = parsed ? parsed.pathname : "";
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
