/**
 * capture-search-url.js — Pure helpers for the "Capturar URL de búsqueda"
 * action (issue #475, part of #471).
 *
 * The owner draws a zone on Idealista ("Dibuja tu zona"), which encodes the
 * polygon into the results-page URL as a `shape=` query param. This action
 * captures that RAW results URL (verbatim, `shape=` and all) + the page title
 * so the dashboard can persist it for later decoding — the first step toward
 * decoding/re-encoding Idealista's polygon grammar (#471 P1).
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
  // The only portal #475/#471 target: the drawn-zone `shape=` grammar is
  // Idealista's. The dashboard endpoint enforces the same host rule server-side
  // (never trust the client), but validating here gives instant popup feedback.
  const IDEALISTA_HOST_SUFFIX = "idealista.com";

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
   * True when `url` is a valid http(s) URL on idealista.com (or a subdomain).
   * A `javascript:`/`data:` URL whose "host" merely spells idealista.com is
   * rejected — hostForUrl only returns for an http(s) scheme.
   */
  function isIdealistaUrl(url) {
    const host = hostForUrl(url);
    if (!host) return false;
    return host === IDEALISTA_HOST_SUFFIX || host.endsWith("." + IDEALISTA_HOST_SUFFIX);
  }

  /**
   * Build the capture payload the extension POSTs to the dashboard. Returns
   * `{ url, title, host, capturedAt }` for a valid Idealista results URL, or
   * null otherwise (the caller shows an "unsupported page" message instead of
   * sending garbage). `title` is trimmed and may be empty. `capturedAt` is an
   * ISO-8601 UTC timestamp; an injectable `now` keeps the unit test deterministic.
   */
  function buildSearchUrlCapture(input, now) {
    const url = input && typeof input.url === "string" ? input.url.trim() : "";
    const host = hostForUrl(url);
    if (!host || !isIdealistaUrl(url)) return null;
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
    hostForUrl: hostForUrl,
    isIdealistaUrl: isIdealistaUrl,
    buildSearchUrlCapture: buildSearchUrlCapture,
    IDEALISTA_HOST_SUFFIX: IDEALISTA_HOST_SUFFIX,
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
