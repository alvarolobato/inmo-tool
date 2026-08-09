/**
 * observe-search-url.js — Pure helpers for the PASSIVE search-URL observer
 * (issue #488, part of #471, builds on #476; generalized to all capture portals
 * in #510).
 *
 * Unlike the intentional "Capturar URL de búsqueda" action (#475/#476,
 * capture-search-url.js), this powers a passive OBSERVER: as the owner browses a
 * supported portal's search/results pages, the content script forwards every
 * distinct search URL it sees so the owner can analyse each portal's
 * filtering/drawn-zone grammar in bulk (#471 for idealista's `shape=`; #510/#514
 * for the aliseda/altamira grammars). Observation is observe-only — it never
 * captures a listing, never navigates, and stays out of the way of validation
 * mode (#478).
 *
 * Which pages count as "an observable search URL" is per-portal (see
 * SEARCH_URL_PORTAL_SPECS): idealista keeps its `/venta-…`/`/areas`/`/multi`/
 * `?shape=` predicate; aliseda observes its `/comprar…`/`/alquil…` result roots;
 * altamira is permissive (any non-detail path), so it accrues the search-URL
 * samples its URL grammar (#514) will be reverse-engineered from — the whole
 * point of #510.
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

  // Altamira listing-DETAIL path shape (mirror of detect.js's altamira
  // isDetailPath): `/venta-de-<tipo>/…/<numeric-id>[/<photo>]`. Everything else
  // under altamira is treated as an observable search page (permissive, #510).
  const ALTAMIRA_DETAIL_RE =
    /^\/(?:venta|alquiler)-de-[^/]+\/.+\/\d+(?:\/\d+)?\/?$/;

  /**
   * Per-portal observer spec: `{ portal, hostSuffix, isSearchPath(parsed) }`.
   * `isSearchPath` receives the parsed URL (path + query available) and returns
   * whether it is a SEARCH/results page worth observing. MUST agree with the
   * dashboard mirror SEARCH_URL_PORTAL_SPECS in lib/observed-search-url.ts and
   * with detect.js's per-portal `isListingPath`/`isDetailPath`; the shared unit
   * fixture (dashboard/__tests__/fixtures/search-url-observable.ts) pins both.
   */
  const SEARCH_URL_PORTAL_SPECS = [
    {
      portal: "idealista",
      hostSuffix: "idealista.com",
      // A `/venta-…`/`/alquiler-…` listado, an `/areas/…` (drawn-zone aggregate)
      // or `/multi/…` (multi-zone) path, OR any Idealista URL carrying a
      // `shape=` drawn-zone param.
      isSearchPath: function (parsed) {
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
      },
    },
    {
      portal: "aliseda",
      hostSuffix: "alisedainmobiliaria.com",
      // Aliseda result pages live under a `/comprar…`/`/alquilar…`/`/alquiler…`
      // path root (owner-confirmed #296/#318, mirror of detect.js isListingPath).
      // Detail pages are `/inmueble/<id>` (a different root) → never observed.
      isSearchPath: function (parsed) {
        return /^\/(comprar|alquilar|alquiler)/.test(parsed.pathname);
      },
    },
    {
      portal: "altamira",
      hostSuffix: "altamirainmuebles.com",
      // Permissive (#510): any non-detail, non-home path. Altamira's search-URL
      // grammar is unknown (that's #514) so we can't gate on a listado prefix
      // yet; capturing every non-detail page it browses is exactly how the
      // corpus needed to reverse-engineer that grammar gets built. Detail pages
      // (`/venta-de-…/<id>`) are excluded so listing/detail stay disjoint.
      isSearchPath: function (parsed) {
        const path = parsed.pathname;
        if (path === "/" || path === "") return false;
        return !ALTAMIRA_DETAIL_RE.test(path);
      },
    },
  ];

  /**
   * Parse `url` and, if its HOST belongs to a capture portal, return
   * `{ parsed, spec }`; null otherwise (bad scheme, unsupported host,
   * unparseable, look-alike host). Path is NOT considered here — callers that
   * need the search-page gate apply `spec.isSearchPath`.
   */
  function parsePortalUrl(url) {
    if (typeof url !== "string") return null;
    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch {
      return null;
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    for (let i = 0; i < SEARCH_URL_PORTAL_SPECS.length; i++) {
      const s = SEARCH_URL_PORTAL_SPECS[i].hostSuffix;
      if (host === s || host.endsWith("." + s)) {
        return { parsed: parsed, spec: SEARCH_URL_PORTAL_SPECS[i] };
      }
    }
    return null;
  }

  /**
   * The capture portal for which `url` is an OBSERVABLE search/results page, or
   * null. Pure — no DOM/chrome. Returns null on any parse failure, unsupported
   * host, or a non-search page (home/detail/etc. per the portal's spec).
   */
  function observablePortalForUrl(url) {
    const hit = parsePortalUrl(url);
    if (!hit) return null;
    return hit.spec.isSearchPath(hit.parsed) ? hit.spec.portal : null;
  }

  /**
   * True when `url` is an OBSERVABLE search/results page on any supported capture
   * portal. Pure; false on any parse failure. Renamed from the idealista-only
   * `isObservableIdealistaUrl` in #510.
   */
  function isObservableSearchUrl(url) {
    return observablePortalForUrl(url) !== null;
  }

  /**
   * Canonical DEDUP key for an observed URL: lowercased host (leading `www.`
   * stripped) + path (trailing slash stripped) + the query params sorted by key
   * (values preserved, `shape=` included so distinct drawn zones stay distinct).
   * Scheme and fragment are dropped. This is the per-session (and server-side)
   * de-dup key — two visits to the same search, in any param order, collapse to
   * one. Gated on the HOST being a capture portal (not on the search-page
   * predicate), so it is byte-compatible with the pre-#510 idealista behaviour.
   * Pure; returns null for a non-portal-host / unparseable URL.
   */
  function normalizeObservedUrl(url) {
    const hit = parsePortalUrl(url);
    if (!hit) return null;
    const parsed = hit.parsed;
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
   * `{ url, title, host, portal, capturedAt }` for an OBSERVABLE search URL on a
   * supported portal, or null otherwise (the caller drops it silently —
   * observation is passive). `url` is kept VERBATIM (trimmed only) so `shape=`
   * survives undecoded. `capturedAt` is an ISO-8601 UTC timestamp; an injectable
   * `now` keeps the unit test deterministic. The server re-derives `portal` from
   * the host and never trusts this value.
   */
  function buildObservedCapture(input, now) {
    const url = input && typeof input.url === "string" ? input.url.trim() : "";
    const portal = observablePortalForUrl(url);
    if (!portal) return null;
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const title =
      input && typeof input.title === "string" ? input.title.trim() : "";
    const when = now instanceof Date ? now : new Date();
    return {
      url,
      title,
      host,
      portal,
      capturedAt: when.toISOString(),
    };
  }

  const api = {
    SEARCH_URL_PORTAL_SPECS: SEARCH_URL_PORTAL_SPECS,
    observablePortalForUrl: observablePortalForUrl,
    isObservableSearchUrl: isObservableSearchUrl,
    normalizeObservedUrl: normalizeObservedUrl,
    buildObservedCapture: buildObservedCapture,
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
