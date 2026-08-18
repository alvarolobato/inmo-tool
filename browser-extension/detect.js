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
  //
  // isListingPath: URL-shape gate for "this is a SEARCH / RESULTS page" — the
  //   page that lists many properties, each linking to its own detail page.
  //   This is the batch-capture entry point (issue #262): from such a page the
  //   extension harvests every detail link and drives them through the worklist
  //   queue. Kept strict for the same reason as isDetailPath — a false positive
  //   would harvest junk anchors.
  //   - Idealista search/results URLs are `/venta-viviendas/…`,
  //     `/alquiler-viviendas/…`, `/venta-locales/…`, etc., plus the
  //     `/areas/<op>-…` aggregate pages. A leading `/(venta|alquiler)-` or
  //     `/areas/(venta|alquiler)-` segment is the signal; detail pages
  //     (`/inmueble/<id>`) and the home (`/`) don't match.
  //   - Aliseda results live under a `/comprar…` / `/alquilar…` /
  //     `/alquiler…` path ROOT. The real search URL (owner-confirmed, #296/#318)
  //     is `/comprar-viviendas/pisos/andalucia/malaga?…` — path
  //     `/comprar-viviendas/`, NOT `/comprar/…`. So the gate is a leading
  //     `/(comprar|alquilar|alquiler)` prefix with NO trailing-slash
  //     requirement, matching `/comprar-viviendas`, `/alquiler-viviendas`,
  //     `/comprar`, `/comprar/vivienda/malaga`, etc. Detail pages are
  //     `/inmueble/<id>` (a different root), so they never match here — listing
  //     and detail stay mutually exclusive.
  var PORTALS = [
    {
      portal: "idealista",
      hostSuffix: "idealista.com",
      isDetailPath: function (p) {
        return /^\/inmueble\/\d+\/?$/.test(p);
      },
      isListingPath: function (p) {
        return (
          /^\/(venta|alquiler)-[a-z]/.test(p) ||
          /^\/areas\/(venta|alquiler)-/.test(p)
        );
      },
      // Results-page pagination (issue #362). Idealista appends a
      // `pagina-<n>.htm` PATH segment to the search path: page 1 is the bare
      // `/venta-viviendas/madrid-madrid/`, page 2 is
      // `/venta-viviendas/madrid-madrid/pagina-2.htm`. VERIFIED from
      // idealista's robots.txt, which disallows `/*/pagina-*.htm` (the
      // pagination path family). The segment goes on the PATH, before any
      // `?query`/`#hash`, which are preserved.
      // …EXCEPT under `/areas/` (a drawn-polygon search), where the page
      // segment carries NO `.htm`: `/areas/venta-viviendas/<filtros>/pagina-2`.
      // Writing `/pagina-2.htm` there returns idealista's "no corresponde a
      // ninguna página" 404 even when page 2 demonstrably exists — verified by
      // hand against a live polygon search that has one. robots.txt only ever
      // documented the `.htm` family (`Disallow: /*/pagina-*.htm`), which is
      // why the original scheme looked complete; `/areas/` is a separate
      // family there too (`Disallow: /areas/`).
      pagination: { kind: "path-htm", extensionlessPathPrefixes: ["/areas/"] },
      // Map-view → listing-view normalisation (issue #506). Idealista renders a
      // drawn-area / polygon search as a MAP page whose path ends in the
      // `/mapa-google` segment (e.g.
      // `/areas/venta-viviendas/<filtros>/mapa-google?shape=((…))`). The map
      // page shows PINS, not detail-card anchors, so harvesting it yields zero
      // links and pagination breaks (`/mapa-google/pagina-2.htm` is invalid).
      // The listing (card) view of the SAME search is the identical path with
      // the `/mapa-google` segment removed, query preserved. toListingUrl()
      // reads this to strip that segment at harvest time. Only Idealista has a
      // map view; the other portals leave this unset and toListingUrl is a
      // no-op for them.
      mapPathSegment: "mapa-google",
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
      isListingPath: function (p) {
        return /^\/(comprar|alquilar|alquiler)/.test(p);
      },
      // Results-page pagination (issue #362). Aliseda's results are a
      // CLIENT-SIDE-RENDERED Angular SPA (the server ships an empty
      // `<app-root>` — a raw fetch carries zero listing/pagination markup), so
      // NO clean page-N URL scheme could be verified statically against the
      // live site. Best-effort `?pagina=<n>` write scheme (page 1 drops the
      // param); the enumeration walk PREFERS the next-page URL harvested from
      // the RENDERED DOM (nextResultsUrlFromHrefs) over this guess. If the
      // rendered page exposes no numbered next-page anchor (e.g. infinite
      // scroll), enumeration stops after page 1 — documented in the PR.
      pagination: { kind: "query", param: "pagina" },
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
      // VERIFIED against two real captured Altamira detail pages (issue #271).
      // Detail URLs are
      //   /venta-de-<tipo>/<provincia>/<municipio>/segunda-mano/<REF>/<id>/1
      // (e.g. /venta-de-atico/pontevedra/sanxenxo/segunda-mano/
      //  9186_1001_PE0001/375859/1). The discriminators: a `-de-` type prefix
      // (`venta-de-…` / `alquiler-de-…`, NOT the `venta-viviendas` search
      // root) AND a trailing numeric listing id (optionally followed by a
      // photo-index segment). This corrects the earlier `/inmueble|/ficha`
      // guess from #280, which Altamira does not use. NOTE: manual capture via
      // the popup button works on ANY http(s) tab regardless of isDetailPath;
      // only the automatic fire-once capture depends on this.
      isDetailPath: function (p) {
        return /^\/(?:venta|alquiler)-de-[^/]+\/.+\/\d+(?:\/\d+)?\/?$/.test(p);
      },
      // Search/results pages are `/venta-viviendas/…` / `/alquiler-viviendas/…`
      // (and sibling `/venta-locales/…` etc.) — a `-viviendas`/`-locales` root
      // WITHOUT the `-de-` type prefix. The negative lookahead keeps a detail
      // URL (`/venta-de-…`) from ever matching here.
      isListingPath: function (p) {
        return /^\/(?:venta|alquiler)-(?!de-)[a-z]+(?:\/|$)/.test(p);
      },
      // Results-page pagination (issue #362). Altamira sits behind an Akamai
      // WAF that 403s any non-session request (its own ETL connector abandons
      // server-side access entirely), so no page-N URL scheme could be
      // verified statically. Best-effort `?pagina=<n>` write scheme (page 1
      // drops the param); like Aliseda, the enumeration walk PREFERS the
      // rendered DOM's next-page anchor (nextResultsUrlFromHrefs) and stops
      // after page 1 if the rendered page exposes no numbered next control.
      pagination: { kind: "query", param: "pagina" },
      readySelectors: [
        "#soloPrecio",
        "h2.titulo",
        ".caracteristicas",
        "main",
        "h1",
      ],
    },
    {
      portal: "hipoges",
      hostSuffix: "realestate.hipoges.com",
      // Grounded in the site's own public Angular route table (main-*.js /
      // chunk-*.js — a static client bundle every visitor's browser
      // downloads, not an API call; see etl/connectors/hipoges.py's module
      // docstring for the full route list). Detail URLs are
      // `/<lang>/detail/<id>` or `/<lang>/<investment>/detail/<id>`,
      // optionally suffixed `/contact-received` or `/unavailable` on the SAME
      // id. `<investment>` is an unconfirmed category segment. DOM extraction
      // beyond this URL shape is an unvalidated draft (D-111) — no real
      // capture exists yet to verify readySelectors against.
      isDetailPath: function (p) {
        return /^\/[a-z]{2}\/(?:[^/]+\/)?detail\/[^/]+/i.test(p);
      },
      // Search/listing routes are `/<lang>/(sale|rent)/<typology>/<country>/…`
      // or the `/<lang>/(area|countries|map|point)/…` variants. NOTE: not
      // strictly disjoint from isDetailPath above — `/es/map/detail/999`
      // matches BOTH (the `map/` marker fires here, and `detail` fires
      // there since `:investment` is unconstrained). Harmless in practice
      // (every consumer resolves detail first — see pageRoleForUrl below)
      // but real, verified by Opus review (PR #548, N4) — unlike the other
      // three portals, this one is not mutually exclusive by construction.
      // The `sale`/`rent` tokens are inferred from the site's own public
      // i18n key names, not directly observed on a live URL — unconfirmed.
      isListingPath: function (p) {
        return /^\/[a-z]{2}\/(?:(?:sale|rent)\/|area\/|countries\/|map\/|point\/)/i.test(
          p
        );
      },
      // Results-page pagination: unknown scheme (no real search page has been
      // observed). Best-effort `?pagina=<n>` write scheme matching the other
      // capture-only portals; the enumeration walk PREFERS the rendered DOM's
      // next-page anchor over this guess, same as aliseda/altamira.
      pagination: { kind: "query", param: "pagina" },
      // No real detail page has been captured, so no readySelectors are
      // grounded — the generic h1/main fallback (DEFAULT_READY_SELECTORS)
      // plus the body-text-volume floor in isRenderReady() is all this portal
      // gets until the calibration issue linked from D-111 lands real ones.
      readySelectors: ["main", "h1"],
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

  /**
   * The capture portal for which `url` is a SEARCH / RESULTS listing page, or
   * null. Used by the popup to decide whether to offer "Capturar todas (N)"
   * (batch capture, issue #262). null for detail pages, home pages,
   * unsupported hosts and non-http(s).
   */
  function listingPortalForUrl(url) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    var cfg = portalConfigForHost(parsed.hostname);
    if (!cfg || typeof cfg.isListingPath !== "function") return null;
    return cfg.isListingPath(parsed.pathname) ? cfg.portal : null;
  }

  /** True iff `url` is a supported search/results listing page. */
  function isListingUrl(url) {
    return listingPortalForUrl(url) !== null;
  }

  /**
   * The supported capture portal a URL's HOST belongs to, for ANY page role
   * (issue #237 guided capture). Unlike detailPortalForUrl / listingPortalForUrl
   * this ignores the path — it only asks "is this a capture-supported portal at
   * all". null for unsupported hosts and non-http(s). Pure.
   */
  function supportedPortalForUrl(url) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    var cfg = portalConfigForHost(parsed.hostname);
    return cfg ? cfg.portal : null;
  }

  /**
   * The capture ROLE of the page at `url`, used by the popup to pick between
   * capturing and the guided panel (issue #237). One of:
   *   "detail"  — a listing-DETAIL page (single/auto capture applies)
   *   "listing" — a SEARCH/results page (batch capture applies)
   *   "other"   — a SUPPORTED portal, but a page we can't capture (home, saved
   *               search, account, filter form) → the popup shows GUIDANCE
   *               (worklist progress + "open the next pending listing") instead
   *               of blindly capturing a non-listing page and erroring.
   *   null      — unsupported host or non-http(s) (the popup keeps its universal
   *               manual-capture escape hatch there).
   * Pure — no DOM/chrome — so the routing decision is unit-testable.
   */
  function pageRoleForUrl(url) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    var cfg = portalConfigForHost(parsed.hostname);
    if (!cfg) return null;
    if (cfg.isDetailPath(parsed.pathname)) return "detail";
    if (
      typeof cfg.isListingPath === "function" &&
      cfg.isListingPath(parsed.pathname)
    ) {
      return "listing";
    }
    return "other";
  }

  /**
   * Harvest the detail-page URLs from a rendered listing/search page (issue
   * #262). `hrefs` is the list of anchor hrefs already resolved to absolute
   * URLs (a content script passes `[...document.querySelectorAll('a[href]')]
   * .map(a => a.href)`; `a.href` is always absolute). Returns the subset that
   * are real listing-DETAIL URLs, de-duplicated by canonical `matchKey` so the
   * same listing linked twice (photo + title anchor) seeds one worklist row.
   *
   * If `portal` is given, only detail URLs for that portal are kept — a listing
   * page occasionally links out to another supported portal, and a batch run is
   * scoped to the portal the operator is actually browsing.
   *
   * Pure: no DOM, no chrome, no network — unit-tested directly.
   */
  function extractDetailUrls(hrefs, portal) {
    var out = [];
    var seen = Object.create(null);
    if (!hrefs || typeof hrefs.length !== "number") return out;
    for (var i = 0; i < hrefs.length; i++) {
      var href = hrefs[i];
      if (typeof href !== "string") continue;
      var p = detailPortalForUrl(href);
      if (!p) continue;
      if (portal && p !== portal) continue;
      var key = matchKey(href);
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push(href.trim());
    }
    return out;
  }

  // ── Results-page pagination (issue #362) ──────────────────────────────────
  //
  // The batch capture historically harvested detail links off ONLY the current
  // results page's DOM — so a search with N pages captured just page 1 (the
  // owner reported this on Aliseda). These PURE helpers let the batch flow walk
  // every results page: given a results URL, derive the URL of a specific page
  // (`resultsPageUrl`) or the next page (`nextResultsUrl`), and — when a portal
  // renders its pagination client-side with no clean URL scheme — pick the
  // next-page anchor out of the rendered DOM's hrefs (`nextResultsUrlFromHrefs`).
  //
  // Bounded so a pathological "next page always exists" loop can't run away.
  var RESULTS_PAGE_CAP = 40;

  /** The `pagination` config for the portal whose host owns `parsed`, or null. */
  function paginationConfigForParsed(parsed) {
    var cfg = portalConfigForHost(parsed.hostname);
    return cfg && cfg.pagination ? cfg.pagination : null;
  }

  /**
   * The 1-based results-page number encoded in `url`, or 1 when none is present
   * (page 1 is the canonical, indicator-free URL). Recognises ALL the schemes
   * this module writes — idealista's `/pagina-<n>.htm` path segment, its
   * extensionless `/areas/` twin `/pagina-<n>` (D-110), and the
   * `?pagina=`/`?page=`/`?pag=` query params — regardless of portal, so the
   * DOM-anchor fallback can read a "next page" link whatever shape it takes.
   * Pure; returns 1 for an unparseable URL.
   */
  function currentResultsPage(url) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return 1;
    }
    var m = /\/pagina-(\d+)\.htm$/i.exec(parsed.pathname);
    if (m) return parseInt(m[1], 10) || 1;
    m = /\/pagina[/-](\d+)(?:\/|$)/i.exec(parsed.pathname);
    if (m) return parseInt(m[1], 10) || 1;
    try {
      var params = parsed.searchParams;
      var keys = ["pagina", "page", "pag"];
      for (var i = 0; i < keys.length; i++) {
        if (params.has(keys[i])) {
          var n = parseInt(params.get(keys[i]), 10);
          if (n > 0) return n;
        }
      }
    } catch (e) {
      /* searchParams unavailable — ignore */
    }
    return 1;
  }

  /**
   * The URL of results page `n` (1-based) for the same search as `url`, using
   * the portal's own write scheme. Page 1 returns the canonical,
   * indicator-free URL (any existing page indicator is stripped). Preserves the
   * rest of the path, the query (minus the page key) and the hash. Pure;
   * returns null for an unparseable URL, an unsupported portal, or `n < 1`.
   */
  function resultsPageUrl(url, n) {
    if (typeof n !== "number" || n < 1) return null;
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return null;
    }
    var pg = paginationConfigForParsed(parsed);
    if (!pg) return null;
    if (pg.kind === "path-htm") {
      // Strip any existing `/pagina-<n>.htm`, normalise a trailing slash, then
      // append the segment for pages ≥ 2. Query + hash ride along untouched.
      // Strips BOTH written forms: `.htm` and the extensionless `/areas/` one.
      var path = parsed.pathname.replace(/\/pagina-\d+(?:\.htm)?\/?$/i, "");
      // Defensive (issue #506): a map-view path would otherwise produce an
      // invalid `/mapa-google/pagina-2.htm`. Strip the portal's map segment here
      // too so pagination is always built on the LISTING path — this mirrors
      // toListingUrl, which the enumeration walk already applies upstream.
      var cfgP = portalConfigForHost(parsed.hostname);
      if (cfgP && cfgP.mapPathSegment) {
        var segP = cfgP.mapPathSegment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        path = path.replace(new RegExp("/" + segP + "(?=/|$)", "i"), "");
      }
      if (!/\/$/.test(path)) path += "/";
      // Which of the two forms this path family uses (see the config comment).
      var extensionless = false;
      if (pg.extensionlessPathPrefixes) {
        for (var pi = 0; pi < pg.extensionlessPathPrefixes.length; pi++) {
          if (path.indexOf(pg.extensionlessPathPrefixes[pi]) === 0) {
            extensionless = true;
            break;
          }
        }
      }
      if (n > 1) path += "pagina-" + n + (extensionless ? "" : ".htm");
      parsed.pathname = path;
      return parsed.toString();
    }
    if (pg.kind === "query") {
      var param = pg.param || "pagina";
      try {
        parsed.searchParams.delete(param);
        if (n > 1) parsed.searchParams.set(param, String(n));
      } catch (e) {
        return null;
      }
      return parsed.toString();
    }
    return null;
  }

  /**
   * The URL of the results page AFTER `url` (current page + 1) via the portal's
   * write scheme, or null when `url` isn't a supported results URL. This is the
   * clean-URL path; a caller that has the rendered DOM can prefer
   * nextResultsUrlFromHrefs when a portal renders pagination client-side.
   */
  function nextResultsUrl(url) {
    return resultsPageUrl(url, currentResultsPage(url) + 1);
  }

  /**
   * Fallback for portals that render pagination client-side with no clean URL
   * scheme (issue #362): given the anchor hrefs harvested off the RENDERED
   * results page plus the current URL, return the href that points at the NEXT
   * results page (current page + 1) for `portal`, or null. Matches any scheme
   * currentResultsPage understands (path or query), so it works whether the
   * rendered "siguiente" link is `?pagina=2`, `/pagina-2.htm`, etc. Pure.
   */
  function nextResultsUrlFromHrefs(hrefs, currentUrl, portal) {
    if (!hrefs || typeof hrefs.length !== "number") return null;
    var want = currentResultsPage(currentUrl) + 1;
    for (var i = 0; i < hrefs.length; i++) {
      var href = hrefs[i];
      if (typeof href !== "string") continue;
      if (listingPortalForUrl(href) !== portal) continue;
      if (currentResultsPage(href) !== want) continue;
      return href.trim();
    }
    return null;
  }

  /**
   * Map-view → listing-view URL normalisation (issue #506).
   *
   * The owner may pin an Idealista search whose URL is the MAP view
   * (`/areas/venta-viviendas/<filtros>/mapa-google?shape=((…))`). That page
   * renders PINS, not detail-card anchors, so guided capture harvests nothing
   * and pagination breaks (`/mapa-google/pagina-2.htm` is not a valid results
   * URL). This returns the LISTING (card) view of the same search — the exact
   * same URL with the portal's map path segment (`mapa-google`) removed — so the
   * harvest tab renders cards and `resultsPageUrl` can append `pagina-N.htm` on a
   * valid listing path. Applied at CONSUMPTION time only (the enumeration path);
   * the pinned URL is still stored/decoded verbatim (D-101).
   *
   * Byte-for-byte contract:
   *   - Only Idealista (the sole portal with a `mapPathSegment`) is transformed;
   *     aliseda/altamira/any other host and any non-http(s) or unparseable URL
   *     are returned UNCHANGED (the original string, not a re-serialised one).
   *   - Strips a WHOLE `/<mapPathSegment>` path segment (segment boundary on both
   *     sides: a leading `/` and a following `/` or end-of-path). Nothing else in
   *     the path is touched; a `mapa-google` substring inside another segment is
   *     never matched.
   *   - Ensures a single trailing slash on the resulting path so the listing form
   *     is `/areas/venta-viviendas/<filtros>/?shape=…` (matches Idealista's own
   *     listing URLs and keeps `resultsPageUrl` producing `…/pagina-2.htm`).
   *   - The QUERY and HASH ride along verbatim. The `shape=((…))` value (raw or
   *     percent-encoded) is never re-encoded or otherwise altered — only the
   *     pathname field is reassigned; `URL` preserves `.search`/`.hash` as-is.
   *   - Idempotent: a URL that is already a listing path (no map segment) is a
   *     no-op, and toListingUrl(toListingUrl(u)) === toListingUrl(u).
   * Pure — no DOM/chrome.
   */
  function toListingUrl(url) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return url;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    var cfg = portalConfigForHost(parsed.hostname);
    if (!cfg || !cfg.mapPathSegment) return url;
    // Match `/<segment>` as a whole path segment (boundary before: the literal
    // leading slash; boundary after: a `/` or the end of the path).
    var seg = cfg.mapPathSegment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var re = new RegExp("/" + seg + "(?=/|$)", "i");
    var newPath = parsed.pathname.replace(re, "");
    if (newPath === parsed.pathname) return url; // already a listing path — no-op
    if (!/\/$/.test(newPath)) newPath += "/";
    // Reassign ONLY the pathname; `.search` and `.hash` stay byte-for-byte.
    parsed.pathname = newPath;
    return parsed.toString();
  }

  // ── Batch auto-start signal (issue #297) ──────────────────────────────────
  //
  // The dashboard's "Abrir búsqueda" opens a portal search URL carrying a
  // signal so the extension AUTO-STARTS the batch on that tab — no popup, no
  // banner click. The signal is either the fragment `#inmo-capture` (preferred:
  // invisible to the portal, never sent to its server) or a query key
  // `?inmo-capture` (fallback when the URL already has a fragment). This must
  // agree byte-for-byte with dashboard/lib/extension-capture.ts `withCaptureSignal`.
  var CAPTURE_SIGNAL = "inmo-capture";

  // ── URL-building discovery signal (issue #336) ────────────────────────────
  //
  // The dashboard's /etl/discovery "Iniciar descubrimiento" opens a portal
  // SEARCH page carrying `#inmo-discover` (query fallback `?inmo-discover`) so
  // the content script runs the OPTION-ENUMERATION pass (discover.js) instead
  // of the listing-capture pass. Same fragment-preferred contract as
  // CAPTURE_SIGNAL; must agree byte-for-byte with the dashboard opener.
  var DISCOVER_SIGNAL = "inmo-discover";

  // ── Validation-mode signal (issue #478 P3) ────────────────────────────────
  //
  // The dashboard's "Validar filtros" page opens a portal search URL carrying
  // `#inmo-validate=<profileId>:<connector>` (query fallback
  // `?inmo-validate=<profileId>:<connector>`) so the content script puts the tab
  // in VALIDATION MODE — no batch autostart, no listing banner, no detail
  // auto-capture — while the owner tunes the search and hands the URL back as
  // this connector's pinned filter. Same fragment-preferred contract as the
  // other signals, but WITH a payload; must agree byte-for-byte with the
  // dashboard opener dashboard/lib/extension-validate.ts `withValidateSignal`.
  var VALIDATE_SIGNAL = "inmo-validate";

  /** True iff `url` carries the given fragment/query signal. Pure; false on parse error. */
  function urlSignalPresent(url, signal) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return false;
    }
    if (parsed.hash.replace(/^#/, "") === signal) return true;
    try {
      if (parsed.searchParams.has(signal)) return true;
    } catch (e) {
      /* searchParams unavailable — ignore */
    }
    return false;
  }

  /**
   * True iff `url` carries the batch auto-start signal (see CAPTURE_SIGNAL).
   * Pure — no DOM/chrome. Returns false for an unparseable URL.
   */
  function captureSignalPresent(url) {
    return urlSignalPresent(url, CAPTURE_SIGNAL);
  }

  /**
   * True iff `url` carries the URL-building discovery signal (issue #336).
   * Pure — no DOM/chrome. Returns false for an unparseable URL.
   */
  function discoverSignalPresent(url) {
    return urlSignalPresent(url, DISCOVER_SIGNAL);
  }

  /**
   * Return `url` tagged with the batch auto-start signal (issue #529 — the map-view
   * "convert" path re-navigates to the listing form and wants it to autostart).
   * Preferred form is the `#inmo-capture` fragment; if the URL already carries a
   * fragment, fall back to the `?inmo-capture` query key rather than clobbering it.
   * Idempotent (either form already present → unchanged) and never throws — returns
   * the input untouched on a parse failure. MUST agree byte-for-byte with the
   * dashboard's lib/extension-capture.ts `withCaptureSignal`.
   */
  function withCaptureSignal(url) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return url;
    }
    if (parsed.hash.replace(/^#/, "") === CAPTURE_SIGNAL) return parsed.toString();
    try {
      if (parsed.searchParams.has(CAPTURE_SIGNAL)) return parsed.toString();
    } catch (e) {
      /* searchParams unavailable — ignore */
    }
    if (!parsed.hash) {
      parsed.hash = CAPTURE_SIGNAL;
      return parsed.toString();
    }
    // Already has a fragment — don't clobber it; use the query fallback instead.
    try {
      parsed.searchParams.set(CAPTURE_SIGNAL, "1");
    } catch (e) {
      /* searchParams unavailable — return unchanged */
    }
    return parsed.toString();
  }

  /**
   * Return `url` with the auto-start signal removed (both the `#inmo-capture`
   * fragment and the `?inmo-capture` query-key forms). Used when handing the
   * search page's OWN url to the capture-to-infer learner (issue #293/#303) so
   * the learned grammar never picks up our synthetic signal. Pure; returns the
   * input unchanged on a parse failure.
   */
  function stripCaptureSignal(url) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return url;
    }
    if (parsed.hash.replace(/^#/, "") === CAPTURE_SIGNAL) parsed.hash = "";
    try {
      if (parsed.searchParams.has(CAPTURE_SIGNAL)) {
        parsed.searchParams.delete(CAPTURE_SIGNAL);
      }
    } catch (e) {
      /* searchParams unavailable — ignore */
    }
    return parsed.toString();
  }

  /**
   * The raw signal VALUE carried by `url` for `signal` (the part after `=`), or
   * null when absent. Reads the fragment form `#<signal>=<value>` first, then
   * the query form `?<signal>=<value>` (already percent-decoded by searchParams).
   * Pure; null on parse error.
   */
  function urlSignalValue(url, signal) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return null;
    }
    var hashKey = parsed.hash.replace(/^#/, "");
    var prefix = signal + "=";
    if (hashKey.indexOf(prefix) === 0) {
      return hashKey.slice(prefix.length);
    }
    try {
      if (parsed.searchParams.has(signal)) {
        return parsed.searchParams.get(signal);
      }
    } catch (e) {
      /* searchParams unavailable — ignore */
    }
    return null;
  }

  /**
   * Parse the validation-mode signal payload (issue #478 P3) out of `url`:
   * `#inmo-validate=<profileId>:<connector>` (or the `?inmo-validate=` query
   * fallback). Returns `{ profileId, connector }` for a well-formed payload
   * (positive integer id + non-empty connector), or null otherwise. Pure — no
   * DOM/chrome. Must agree with dashboard/lib/extension-validate.ts
   * `withValidateSignal`.
   */
  function validateSignalPayload(url) {
    var raw = urlSignalValue(url, VALIDATE_SIGNAL);
    if (raw == null || raw === "") return null;
    var idx = raw.indexOf(":");
    if (idx <= 0) return null;
    var pidStr = raw.slice(0, idx);
    var connector = raw.slice(idx + 1);
    if (!/^\d+$/.test(pidStr)) return null;
    var profileId = parseInt(pidStr, 10);
    if (!(profileId > 0)) return null;
    if (!connector) return null;
    return { profileId: profileId, connector: connector };
  }

  /**
   * True iff `url` carries a well-formed validation-mode signal (issue #478 P3).
   * Pure — no DOM/chrome. Returns false for an unparseable URL / bad payload.
   */
  function validateSignalPresent(url) {
    return validateSignalPayload(url) !== null;
  }

  /**
   * Return `url` with the validation-mode signal removed (both the
   * `#inmo-validate=…` fragment and the `?inmo-validate=…` query-key forms).
   * Used before the content script hands the tab's URL back as a pinned filter
   * (and by the on-load history.replaceState) so the synthetic signal is NEVER
   * persisted. Pure; returns the input unchanged on a parse failure.
   */
  function stripValidateSignal(url) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return url;
    }
    var hashKey = parsed.hash.replace(/^#/, "");
    if (hashKey === VALIDATE_SIGNAL || hashKey.indexOf(VALIDATE_SIGNAL + "=") === 0) {
      parsed.hash = "";
    }
    try {
      if (parsed.searchParams.has(VALIDATE_SIGNAL)) {
        parsed.searchParams.delete(VALIDATE_SIGNAL);
      }
    } catch (e) {
      /* searchParams unavailable — ignore */
    }
    return parsed.toString();
  }

  /**
   * The pure "should the capture loops STAY SUPPRESSED?" verdict for validation
   * mode (issue #478 P3). A tab is in validation mode when EITHER the URL still
   * carries the validate signal (first load, before the fragment is stripped) OR
   * the background has recorded this tab as a validation tab (`validationActive`,
   * which survives the in-portal navigation that drops the fragment). When true,
   * startAutoCaptureLoop / startListingLoop early-return — no banner, no
   * autostart, no detail auto-capture. Pure — no DOM/chrome.
   */
  function inValidationMode(url, validationActive) {
    return validationActive === true || validateSignalPresent(url);
  }

  /**
   * Shape the "Usar esta URL como filtro" save payload (issue #478 P3): combine
   * the per-tab validation `state` ({ profileId, connector }) with the tab's
   * current `url` (signal-stripped), validating it's an http(s) URL. Returns
   * `{ profileId, connector, url, source:'extension' }` or null. Pure — the
   * background worker re-validates + attaches the admin key before the PUT, and
   * the server re-derives the portal from the host (never client-claimed).
   */
  function buildValidationSavePayload(state, url) {
    if (!state || !(state.profileId > 0) || !state.connector) return null;
    var cleanUrl = stripValidateSignal(url);
    var parsed;
    try {
      parsed = new URL(String(cleanUrl).trim());
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return {
      profileId: state.profileId,
      connector: state.connector,
      url: cleanUrl,
      source: "extension",
    };
  }

  /**
   * Decide what a content script should do on the page at `url`, given the
   * detail URLs it harvested. Pure — the DOM/chrome wiring in content-script.js
   * calls this and acts on the verdict, so the decision itself is unit-testable.
   *
   * Returns one of:
   *   { action: "none" }                         — not a listing, or nothing to capture
   *   { action: "autostart", portal, count }     — listing + signal + ≥1 detail URL
   *   { action: "banner",    portal, count }     — listing + ≥1 detail URL, no signal
   *   { action: "convert", portal, listingUrl }  — Idealista map-view (pins, zero
   *                                                 anchors): listingUrl is the card
   *                                                 form of the same search (#529)
   *
   * `count` is detailUrls.length. Auto-start requires the app-supplied signal so
   * capture stays human-initiated in spirit (the owner clicked "Abrir búsqueda");
   * without it the owner gets the manual banner button instead.
   */
  function listingCaptureAction(url, detailUrls) {
    var portal = listingPortalForUrl(url);
    var count =
      detailUrls && typeof detailUrls.length === "number" ? detailUrls.length : 0;
    if (!portal) return { action: "none" };
    if (count === 0) {
      // Zero anchors harvested. A drawn-zone Idealista search renders as a MAP of
      // PINS (`/mapa-google?shape=…`) — an isListingPath match with no detail
      // anchors. Rather than silently poll to a dead deadline (issue #529),
      // surface the LISTING (card) form of the SAME search, where capture works.
      // toListingUrl strips `/mapa-google` and rides the query + hash (incl. any
      // capture signal) along verbatim; it is a no-op for any non-map URL, so
      // `listingUrl !== url` fires this for exactly the Idealista map-view case.
      var listingUrl = toListingUrl(url);
      if (listingUrl !== url) {
        return { action: "convert", portal: portal, listingUrl: listingUrl };
      }
      return { action: "none" };
    }
    return {
      action: captureSignalPresent(url) ? "autostart" : "banner",
      portal: portal,
      count: count,
    };
  }

  /**
   * Build (but do NOT append) the in-page capture banner element (issue #297).
   * `doc` is injected (the content script passes `document`) so it's testable
   * against a jsdom document with no chrome APIs. The banner is a small, fixed,
   * Inmo-Tool-branded, dismissible bar whose primary button invokes `onCapture`
   * and whose "×" invokes `onDismiss`. Styled so it can't be confused with the
   * portal's own UI and never blocks page content. Returns the root element, or
   * null if it can't be built.
   */
  function buildCaptureBanner(doc, opts) {
    if (!doc || typeof doc.createElement !== "function") return null;
    var o = opts || {};
    var count = typeof o.count === "number" ? o.count : 0;

    var root = doc.createElement("div");
    root.id = "inmo-capture-banner";
    root.setAttribute("data-inmo-banner", "1");
    Object.assign(root.style, {
      position: "fixed",
      top: "14px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      gap: "14px",
      maxWidth: "92vw",
      background: "#0f172a",
      color: "#fff",
      font: "500 13px/1.4 -apple-system, Segoe UI, Roboto, sans-serif",
      padding: "10px 14px",
      borderRadius: "12px",
      boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
      border: "1px solid rgba(255,255,255,0.12)",
    });

    var label = doc.createElement("span");
    label.setAttribute("data-inmo-banner-label", "1");
    // `o.label` overrides the default copy (issue #529: the map-view "convert"
    // banner reads "ver esta zona como lista y capturar" instead of a count).
    label.textContent =
      typeof o.label === "string" && o.label
        ? o.label
        : "Inmo-Tool: capturar las " + count + " propiedades de esta búsqueda";
    label.style.whiteSpace = "nowrap";
    label.style.overflow = "hidden";
    label.style.textOverflow = "ellipsis";

    var capture = doc.createElement("button");
    capture.id = "inmo-capture-banner-start";
    capture.setAttribute("data-inmo-banner-start", "1");
    capture.type = "button";
    capture.textContent =
      typeof o.buttonText === "string" && o.buttonText ? o.buttonText : "Capturar todas";
    Object.assign(capture.style, {
      flexShrink: "0",
      padding: "6px 14px",
      font: "600 13px/1 -apple-system, Segoe UI, Roboto, sans-serif",
      color: "#0f172a",
      background: "#fff",
      border: "none",
      borderRadius: "8px",
      cursor: "pointer",
    });
    if (typeof o.onCapture === "function") {
      capture.addEventListener("click", function () {
        o.onCapture();
      });
    }

    var dismiss = doc.createElement("button");
    dismiss.id = "inmo-capture-banner-dismiss";
    dismiss.setAttribute("data-inmo-banner-dismiss", "1");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Descartar");
    dismiss.textContent = "×"; // ×
    Object.assign(dismiss.style, {
      flexShrink: "0",
      width: "24px",
      height: "24px",
      lineHeight: "22px",
      textAlign: "center",
      font: "600 16px/1 -apple-system, Segoe UI, Roboto, sans-serif",
      color: "#fff",
      background: "transparent",
      border: "none",
      borderRadius: "6px",
      cursor: "pointer",
    });
    if (typeof o.onDismiss === "function") {
      dismiss.addEventListener("click", function () {
        o.onDismiss();
      });
    }

    root.appendChild(label);
    root.appendChild(capture);
    root.appendChild(dismiss);
    return root;
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
    listingPortalForUrl: listingPortalForUrl,
    isListingUrl: isListingUrl,
    supportedPortalForUrl: supportedPortalForUrl,
    pageRoleForUrl: pageRoleForUrl,
    extractDetailUrls: extractDetailUrls,
    RESULTS_PAGE_CAP: RESULTS_PAGE_CAP,
    currentResultsPage: currentResultsPage,
    resultsPageUrl: resultsPageUrl,
    nextResultsUrl: nextResultsUrl,
    nextResultsUrlFromHrefs: nextResultsUrlFromHrefs,
    toListingUrl: toListingUrl,
    isRenderReady: isRenderReady,
    createCaptureGuard: createCaptureGuard,
    CAPTURE_SIGNAL: CAPTURE_SIGNAL,
    DISCOVER_SIGNAL: DISCOVER_SIGNAL,
    VALIDATE_SIGNAL: VALIDATE_SIGNAL,
    captureSignalPresent: captureSignalPresent,
    discoverSignalPresent: discoverSignalPresent,
    withCaptureSignal: withCaptureSignal,
    stripCaptureSignal: stripCaptureSignal,
    validateSignalPayload: validateSignalPayload,
    validateSignalPresent: validateSignalPresent,
    stripValidateSignal: stripValidateSignal,
    inValidationMode: inValidationMode,
    buildValidationSavePayload: buildValidationSavePayload,
    listingCaptureAction: listingCaptureAction,
    buildCaptureBanner: buildCaptureBanner,
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
