/**
 * detect.js — Pure auto-capture detection helpers (issue #254).
 *
 * NO side effects at load time: no `window`/`document`/`chrome` access at the
 * top level, no event listeners. Everything here is a pure function of its
 * arguments so it can be unit-tested outside a browser
 * (dashboard/__tests__/extension-detect.test.ts) — the timing/wiring that DOES
 * touch the DOM and the chrome APIs lives in content-script.js.
 *
 * Loaded as the FIRST content script (before content-script.js) via
 * manifest.json's content_scripts[].js array, so both files share the same
 * isolated world. Since classic content scripts don't share top-level
 * `const`/`let` bindings across files, the API is published on `self.InmoDetect`
 * for content-script.js to read, and via CommonJS `module.exports` for tests.
 *
 * Design intent (issue #254): auto-capture ONLY a real listing-detail page the
 * human has ALREADY navigated to, once, after it has actually rendered. Be
 * conservative — a false negative just falls back to the manual popup button;
 * a false positive captures junk.
 */

(function () {
  "use strict";

  // ── Per-portal configuration ──────────────────────────────────────────────
  //
  // isDetailPath: URL-shape gate for "this is a listing-detail page, not a
  //   search-results / home / list page". Kept deliberately strict.
  //   - Idealista detail URLs are `/inmueble/<numeric-id>/` (e.g.
  //     /inmueble/106387165/). Search pages are /venta-viviendas/…,
  //     /alquiler-…, /areas/…, the home is /. Requiring a NUMERIC id after
  //     /inmueble/ excludes all of those.
  //   - Aliseda detail URLs are `/inmueble/<id>` where the id can be an
  //     alphanumeric slug (e.g. /inmueble/ANT1). Search/listing pages live
  //     under other path roots, so `/inmueble/<segment>` is a safe detail
  //     signal.
  //
  // readySelectors: DOM nodes whose presence (with text) signals the JS-rendered
  //   page body has actually painted. These are best-effort heuristics and
  //   should be re-verified against a live page if a site restructures — the
  //   generic `main` / `h1` fallbacks plus the body-text-volume floor in
  //   isRenderReady() keep it working even if the specific selectors drift.
  var PORTALS = [
    {
      portal: "idealista",
      hostSuffix: "idealista.com",
      isDetailPath: function (p) {
        return /^\/inmueble\/\d+\/?$/.test(p);
      },
      readySelectors: [
        "h1.main-info__title-main",
        ".info-data-price",
        ".main-info",
        "main",
        "h1",
      ],
    },
    {
      portal: "aliseda",
      hostSuffix: "alisedainmobiliaria.com",
      isDetailPath: function (p) {
        return /^\/inmueble\/[^/]+/.test(p);
      },
      readySelectors: [
        "[class*='ficha']",
        "[class*='detalle']",
        "[class*='precio']",
        "main",
        "h1",
      ],
    },
    {
      portal: "altamira",
      hostSuffix: "altamirainmuebles.com",
      // ⚠️ BEST-EFFORT / UNVERIFIED — issue #271. Altamira's real detail-URL
      // pattern has NOT yet been confirmed against a live page. This matches a
      // `/inmueble/<id>` or `/ficha/<id>` path segment (the common Spanish-portal
      // shapes), which is a reasonable guess but MUST be verified against a real
      // Altamira detail URL and tightened/corrected before relying on
      // auto-capture. NOTE: manual capture via the popup button works on ANY
      // http(s) tab regardless of isDetailPath, so the owner can already capture
      // an Altamira page (to seed the #271 connector) even if this heuristic is
      // wrong — only the automatic fire-once capture depends on it.
      isDetailPath: function (p) {
        return /^\/(?:inmueble|ficha)\/[^/]+/.test(p);
      },
      readySelectors: [
        "[class*='ficha']",
        "[class*='detalle']",
        "[class*='precio']",
        "main",
        "h1",
      ],
    },
  ];

  // Minimum trimmed text on a "key node" for it to count as rendered.
  var MIN_HEADING_TEXT = 3;
  // Minimum total rendered body text (chars). An un-rendered SPA shell has
  // almost no text (a few nav words); a rendered listing has thousands. This
  // floor is the primary anti-"empty shell" guard.
  var MIN_BODY_TEXT = 400;
  var DEFAULT_READY_SELECTORS = ["h1", "main"];

  /**
   * Canonical correlation key for a URL — MUST match lib/worklist.ts
   * `worklistMatchKey` / etl/capture.py `worklist_match_key`: lowercased host
   * with leading `www.` stripped + path with trailing slash stripped; scheme,
   * query and fragment dropped; path case preserved. Used here purely as the
   * fire-once key (so ?utm=… and a trailing slash don't re-trigger a capture
   * of the same listing). Returns "" for an unparseable URL.
   */
  function matchKey(url) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return "";
    }
    var host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!host) return "";
    var path = parsed.pathname.replace(/\/+$/, "");
    return host + path;
  }

  /** Portal config whose host suffix matches `host` (exact or subdomain), or null. */
  function portalConfigForHost(host) {
    var h = String(host).toLowerCase().replace(/^www\./, "");
    for (var i = 0; i < PORTALS.length; i++) {
      var c = PORTALS[i];
      if (h === c.hostSuffix || h.endsWith("." + c.hostSuffix)) return c;
    }
    return null;
  }

  /**
   * The capture portal for which `url` is a listing-DETAIL page, or null.
   * null for search-results/home/list pages, unsupported hosts, and non-http(s).
   */
  function detailPortalForUrl(url) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    var cfg = portalConfigForHost(parsed.hostname);
    if (!cfg) return null;
    return cfg.isDetailPath(parsed.pathname) ? cfg.portal : null;
  }

  /** True iff `url` is a supported listing-detail page. */
  function isDetailUrl(url) {
    return detailPortalForUrl(url) !== null;
  }

  function readySelectorsFor(portal) {
    for (var i = 0; i < PORTALS.length; i++) {
      if (PORTALS[i].portal === portal) return PORTALS[i].readySelectors;
    }
    return DEFAULT_READY_SELECTORS;
  }

  /**
   * Heuristic: has the JS-rendered detail page actually painted its content
   * (vs. an empty SPA shell captured too early)? Requires BOTH:
   *   1. a "key" content node present with non-trivial text, AND
   *   2. total body text above MIN_BODY_TEXT.
   * `doc` is injected (not the global `document`) so it's testable against
   * fabricated DOM fixtures. Never throws.
   */
  function isRenderReady(doc, portal) {
    if (!doc || typeof doc.querySelector !== "function") return false;
    var rs = doc.readyState;
    if (rs && rs !== "interactive" && rs !== "complete") return false;

    var selectors = readySelectorsFor(portal);
    var hasKeyNode = false;
    for (var i = 0; i < selectors.length; i++) {
      var el = null;
      try {
        el = doc.querySelector(selectors[i]);
      } catch (e) {
        el = null;
      }
      if (el && (el.textContent || "").trim().length >= MIN_HEADING_TEXT) {
        hasKeyNode = true;
        break;
      }
    }
    if (!hasKeyNode) return false;

    var bodyText = ((doc.body && doc.body.textContent) || "").trim();
    return bodyText.length >= MIN_BODY_TEXT;
  }

  /**
   * Fire-once guard keyed by (normalised) URL. Lifecycle per key:
   *   claim(key)  → true exactly once while the key is neither done nor
   *                 in-flight; marks it in-flight.
   *   settle(key) → mark done (a successful capture); never fires again.
   *   release(key)→ drop the in-flight mark WITHOUT marking done (a failed
   *                 capture), so a later retry can claim it again.
   * SPA route changes produce a NEW url → a new key → a fresh single capture.
   */
  function createCaptureGuard() {
    var done = Object.create(null);
    var inflight = Object.create(null);
    return {
      claim: function (key) {
        if (!key || done[key] || inflight[key]) return false;
        inflight[key] = true;
        return true;
      },
      settle: function (key) {
        if (!key) return;
        delete inflight[key];
        done[key] = true;
      },
      release: function (key) {
        if (!key) return;
        delete inflight[key];
      },
      isDone: function (key) {
        return !!(key && done[key]);
      },
      isInflight: function (key) {
        return !!(key && inflight[key]);
      },
    };
  }

  var api = {
    PORTALS: PORTALS,
    MIN_HEADING_TEXT: MIN_HEADING_TEXT,
    MIN_BODY_TEXT: MIN_BODY_TEXT,
    matchKey: matchKey,
    portalConfigForHost: portalConfigForHost,
    detailPortalForUrl: detailPortalForUrl,
    isDetailUrl: isDetailUrl,
    isRenderReady: isRenderReady,
    createCaptureGuard: createCaptureGuard,
  };

  // Publish for content-script.js (shared isolated world).
  if (typeof self !== "undefined") {
    self.InmoDetect = api;
  }
  // Publish for the unit tests (Node/vitest).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
