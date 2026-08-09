/**
 * capture-search-url.js — Pure helpers for the "Capturar URL de búsqueda"
 * action (issue #475, part of #471; generalized to all capture portals in #510).
 *
 * The owner is on a portal search/results page and clicks the popup button; this
 * captures that RAW results URL (verbatim, `shape=` and all) + the page title so
 * the dashboard can persist it for later decoding. On Idealista this feeds the
 * drawn-zone `shape=` grammar work (#471 P1); on aliseda/altamira it accumulates
 * the search-URL corpus each portal's own URL grammar is built from (#510 → the
 * altamira grammar of #514).
 *
 * Capture is INTENTIONAL and path-agnostic: the button/host gate only asks "is
 * this one of the capture portals?" (host suffix), not "is this a results page"
 * — the owner decides what is worth capturing. The dashboard endpoint enforces
 * the same host rule server-side (never trust the client) and derives the portal
 * from the host; validating here just gives instant popup feedback.
 *
 * This file is INTENTIONALLY side-effect-free at load (no chrome.*, no DOM), so
 * it can be:
 *   - importScripts()'d by the MV3 service worker (background.js),
 *   - loaded via <script src> in the popup (popup.html → popup.js), and
 *   - require()'d by the vitest unit tests (dashboard/__tests__).
 * Same dual-publish pattern as detect.js.
 */
(function () {
  "use strict";

  const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
  // The portals the extension can capture. Mirror of the dashboard's
  // CAPTURE_PORTALS (dashboard/lib/worklist.ts) and etl/capture.py's
  // `_CAPTURE_CONNECTORS` — the three lists must stay in step (adding a portal
  // is a one-line edit in each). Ordered idealista → aliseda → altamira.
  const CAPTURE_PORTALS = [
    { portal: "idealista", hostSuffix: "idealista.com" },
    { portal: "aliseda", hostSuffix: "alisedainmobiliaria.com" },
    { portal: "altamira", hostSuffix: "altamirainmuebles.com" },
  ];

  /**
   * Normalise a URL's hostname (lowercase, drop a leading `www.`), or null when
   * the string isn't a parseable http(s) URL.
   */
  function hostForUrl(url) {
    if (typeof url !== "string") return null;
    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch {
      return null;
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  }

  /**
   * The capture portal `url`'s HOST belongs to (exact host or a subdomain of a
   * capture portal's suffix), or null. A `javascript:`/`data:` URL whose "host"
   * merely spells a portal domain is rejected — hostForUrl only returns for an
   * http(s) scheme. Pure — no DOM/chrome.
   */
  function capturePortalForUrl(url) {
    const host = hostForUrl(url);
    if (!host) return null;
    for (let i = 0; i < CAPTURE_PORTALS.length; i++) {
      const s = CAPTURE_PORTALS[i].hostSuffix;
      if (host === s || host.endsWith("." + s)) return CAPTURE_PORTALS[i].portal;
    }
    return null;
  }

  /** True when `url` is a valid http(s) URL on a supported capture portal. */
  function isCaptureSearchUrl(url) {
    return capturePortalForUrl(url) !== null;
  }

  /**
   * Build the capture payload the extension POSTs to the dashboard. Returns
   * `{ url, title, host, portal, capturedAt }` for a URL on a supported capture
   * portal, or null otherwise (the caller shows an "unsupported page" message
   * instead of sending garbage). `title` is trimmed and may be empty.
   * `capturedAt` is an ISO-8601 UTC timestamp; an injectable `now` keeps the
   * unit test deterministic. The server re-derives `portal` from the host and
   * never trusts this value.
   */
  function buildSearchUrlCapture(input, now) {
    const url = input && typeof input.url === "string" ? input.url.trim() : "";
    const host = hostForUrl(url);
    const portal = capturePortalForUrl(url);
    if (!host || !portal) return null;
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
    hostForUrl: hostForUrl,
    capturePortalForUrl: capturePortalForUrl,
    isCaptureSearchUrl: isCaptureSearchUrl,
    buildSearchUrlCapture: buildSearchUrlCapture,
    CAPTURE_PORTALS: CAPTURE_PORTALS,
  };

  // Publish for the service worker (importScripts) and the popup (script tag) —
  // both share `self` as the global.
  if (typeof self !== "undefined") {
    self.InmoSearchUrl = api;
  }
  // Publish for the unit tests (Node/vitest).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
