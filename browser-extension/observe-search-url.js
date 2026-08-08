/**
 * observe-search-url.js — Pure helpers for the PASSIVE Idealista search-URL
 * observer (issue #488, part of #471, builds on #476).
 *
 * Unlike the intentional "Capturar URL de búsqueda" action (#475/#476,
 * capture-search-url.js), this powers a passive OBSERVER: as the owner browses
 * Idealista search/results pages, the content script forwards every distinct
 * search URL it sees so the owner can analyse Idealista's filtering/drawn-zone
 * grammar in bulk (#471). Observation is observe-only — it never captures a
 * listing, never navigates, and stays out of the way of validation mode (#478).
 *
 * This file is INTENTIONALLY side-effect-free at load (no chrome.*, no DOM), so
 * it can be:
 *   - importScripts()'d by the MV3 service worker (background.js),
 *   - loaded via <script src> / as a content script (content-script.js reads
 *     self.InmoObserve), and
 *   - require()'d by the vitest unit tests (dashboard/__tests__).
 * Same dual-publish pattern as detect.js / capture-search-url.js.
 */
(function () {
  "use strict";

  const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
  // #488/#471 target Idealista only — the drawn-zone/`shape=` grammar is theirs.
  const IDEALISTA_HOST_SUFFIX = "idealista.com";

  /**
   * Parse a URL, returning the URL object only for a valid http(s) URL on
   * idealista.com (or a subdomain). null otherwise (bad scheme, other host,
   * unparseable, look-alike host).
   */
  function parseIdealista(url) {
    if (typeof url !== "string") return null;
    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch {
      return null;
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== IDEALISTA_HOST_SUFFIX && !host.endsWith("." + IDEALISTA_HOST_SUFFIX)) {
      return null;
    }
    return parsed;
  }

  /**
   * True when `url` is an Idealista SEARCH / RESULTS page worth observing:
   *   - a `/venta-…` / `/alquiler-…` listado path, OR
   *   - an `/areas/…` (drawn-zone aggregate) path, OR
   *   - a `/multi/…` (multi-zone) path, OR
   *   - any Idealista URL carrying a `shape=` drawn-zone param.
   * The home page (`/`), detail pages (`/inmueble/<id>`) and other pages are
   * NOT observable. Pure — no DOM/chrome. Returns false on any parse failure.
   */
  function isObservableIdealistaUrl(url) {
    const parsed = parseIdealista(url);
    if (!parsed) return false;
    const path = parsed.pathname;
    if (/^\/(venta|alquiler)-[a-z]/.test(path)) return true;
    if (/^\/areas(\/|$)/.test(path)) return true;
    if (/^\/multi(\/|$)/.test(path)) return true;
    try {
      if (parsed.searchParams.has("shape")) return true;
    } catch {
      /* searchParams unavailable — ignore */
    }
    return false;
  }

  /**
   * Canonical DEDUP key for an observed URL: lowercased host (leading `www.`
   * stripped) + path (trailing slash stripped) + the query params sorted by key
   * (values preserved, `shape=` included so distinct drawn zones stay distinct).
   * Scheme and fragment are dropped. This is the per-session (and server-side)
   * de-dup key — two visits to the same search, in any param order, collapse to
   * one. Pure; returns null for a non-observable / unparseable URL.
   */
  function normalizeObservedUrl(url) {
    const parsed = parseIdealista(url);
    if (!parsed) return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    let query = "";
    try {
      const pairs = [...parsed.searchParams.entries()];
      pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
      query = pairs.map(([k, v]) => `${k}=${v}`).join("&");
    } catch {
      query = "";
    }
    return host + path + (query ? "?" + query : "");
  }

  /**
   * Build the payload the observer forwards to the dashboard. Returns
   * `{ url, title, host, capturedAt }` for an OBSERVABLE Idealista search URL,
   * or null otherwise (the caller drops it silently — observation is passive).
   * `url` is kept VERBATIM (trimmed only) so `shape=` survives undecoded.
   * `capturedAt` is an ISO-8601 UTC timestamp; an injectable `now` keeps the
   * unit test deterministic.
   */
  function buildObservedCapture(input, now) {
    const url = input && typeof input.url === "string" ? input.url.trim() : "";
    const parsed = parseIdealista(url);
    if (!parsed || !isObservableIdealistaUrl(url)) return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const title =
      input && typeof input.title === "string" ? input.title.trim() : "";
    const when = now instanceof Date ? now : new Date();
    return {
      url,
      title,
      host,
      capturedAt: when.toISOString(),
    };
  }

  const api = {
    isObservableIdealistaUrl: isObservableIdealistaUrl,
    normalizeObservedUrl: normalizeObservedUrl,
    buildObservedCapture: buildObservedCapture,
    IDEALISTA_HOST_SUFFIX: IDEALISTA_HOST_SUFFIX,
  };

  // Publish for the service worker (importScripts) and content scripts —
  // both share `self` as the global.
  if (typeof self !== "undefined") {
    self.InmoObserve = api;
  }
  // Publish for the unit tests (Node/vitest).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
