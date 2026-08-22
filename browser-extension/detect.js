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
      //
      // The `(?:[^/]+\/)?` :investment slot is a WILDCARD, and that is what
      // made this wrong (issue #701). Hipoges' own home page links its blog
      // as `es/blog/detail/<slug>` — e.g.
      // `es/blog/detail/pisos-en-alcala-de-henares-oportunidades`, six of them
      // on the page, VERIFIED in production `extension_capture` id 3577 (the
      // owner's real capture of `/es`, pulled read-only). "blog" landed in the
      // :investment slot, so every one of those articles classified as a
      // listing-DETAIL page and was one "Capturar todas" away from being
      // ingested as a property. Nothing had been ingested yet, but the path
      // was open — the same defect #690/D-159 closed for Idealista's
      // non-advert pages.
      //
      // Excluded by NAME, not by shape: the asset-category tokens the bundle
      // hints at (auction/cdr/npl/occupied/rented/special) are unconfirmed, so
      // an allow-list would repeat the D-115 mistake of making a real URL
      // vanish because the vocabulary guess was wrong. A deny-list of the
      // non-asset sections actually OBSERVED linking through `detail/` keeps
      // the wildcard's tolerance and closes the one hole we can prove.
      isDetailPath: function (p) {
        return /^\/[a-z]{2}\/(?:(?!blog\/)[^/]+\/)?detail\/[^/]+/i.test(p);
      },
      // Search/listing routes are `/<lang>/<operation>/<typology>/<country>/
      // <town>[/<features>]` (5+ path segments after the domain) or the
      // `/<lang>/(area|countries|map|point)/…` variants.
      //
      // issue #561 review round 2 (the owner's real navigated URL,
      // `/es/venta/pisos-y-casas/espana/dos-hermanas_sevilla`, went
      // unrecognised): this used to hard-code `(sale|rent)` as the ONLY
      // accepted operation tokens, guessed from the wrong i18n axis (see
      // dashboard/lib/search-url/portals/hipoges.ts's module docstring for
      // the full trace — the real operation code is `venta`/`alquiler`,
      // confirmed from the public bundle, and even that is not guaranteed
      // exhaustive). Enumerating tokens here made the SAME mistake B2 made
      // in the search-URL parser: a real URL using a token this regex
      // didn't happen to allow-list simply vanished. This now matches the
      // route's SHAPE instead — any two non-"detail" segments (operation,
      // typology) followed by at least two more segments (country, town) —
      // so a future vocabulary surprise can't silently make the portal
      // unreachable again. MUST stay in lockstep with the Python mirror
      // (etl/listing_detect.py, D-069).
      //
      // The negative lookaheads on the first two segments are what keep
      // this from swallowing a detail URL: `/es/detail/999` puts "detail"
      // in the OPERATION position (excluded), `/es/<investment>/detail/
      // <id>[/…]` puts it in the TYPOLOGY position (excluded) — both of
      // isDetailPath's two shapes are covered. STRICTER than a plain shape
      // match, not looser.
      //
      // NOTE: still not strictly disjoint from isDetailPath above for the
      // LITERAL `area|countries|map|point` markers — `/es/map/detail/999`
      // matches BOTH (the `map/` marker fires here, and `detail` fires
      // there since `:investment` is unconstrained) — unchanged from the
      // original Opus review (PR #548, N4) finding, harmless in practice
      // since every consumer resolves detail first (see pageRoleForUrl
      // below). The shape-based branch added here does NOT introduce any
      // new instance of that overlap — it structurally excludes "detail".
      isListingPath: function (p) {
        return /^\/[a-z]{2}\/(?:(?:area|countries|map|point)(?:\/|$)|(?!detail(?:\/|$))[^/?#]+\/(?!detail(?:\/|$))[^/?#]+\/[^/?#]+\/[^/?#]+)/i.test(
          p
        );
      },
      // Results-page pagination: unknown scheme (no real search page has been
      // observed). Best-effort `?pagina=<n>` write scheme matching the other
      // capture-only portals; the enumeration walk PREFERS the rendered DOM's
      // next-page anchor over this guess, same as aliseda/altamira.
      pagination: { kind: "query", param: "pagina" },
      // ── Render readiness (issue #701) ───────────────────────────────────
      //
      // This used to be `["main", "h1"]`, and that pair is why the owner was
      // told "no hay anuncios que capturar" on a page showing 17. Both
      // selectors match Hipoges' PAGE FURNITURE, which Angular server-renders
      // before a single advert exists. Measured on production
      // `extension_capture` id 3576 — the owner's own
      // `/es/venta/pisos-y-casas/espana/dos-hermanas_sevilla` capture, 262 KB,
      // pulled read-only:
      //
      //   <main> present, <h1> = "17 Pisos y casas en venta en Dos Hermanas,
      //   Sevilla", body text 2,036 chars (floor is 400).
      //
      // So isRenderReady() returned TRUE on the very first 500 ms poll, the
      // harvest ran, and the results list at that instant was FOUR painted
      // cards plus THIRTEEN <p-skeleton> placeholders — the 17 he could see.
      // Readiness was reporting on the header, never on the adverts.
      //
      // Detail and listing pages are now judged SEPARATELY, because on this
      // portal they fail differently and the evidence for each is different.
      detailReadySelectors: [
        // Grounded in the real RARE-04347 capture (issue #547, D-146) — the
        // Angular component elements that only exist once the advert itself
        // has painted. See etl/tests/fixtures/hipoges_detail_RARE-04347.html
        // and hipoges.py, which parses these exact elements.
        "init-asset-detail-main-info",
        "init-asset-detail-features",
        "init-asset-detail-details",
        "init-asset-detail-description",
        // Deliberately NO "main"/"h1" fallback. On every other portal the
        // generic pair is a harmless safety net; here it is the bug. An empty
        // Hipoges shell satisfies both, which is how rows 3614-3617 came to be
        // captured with 3 of 26 fields.
      ],
      // A listing page's readiness is NOT a selector question on this portal —
      // see harvestSettleFor/mediaDetailRef below and isRenderReadyListing().
      // `init-front-list` is the results component and IS grounded (it is
      // present in id 3576), but it is present while the list is still all
      // skeletons, so on its own it proves nothing. It is kept only as the
      // "we are on the right page" half; the settle loop supplies the rest.
      listingReadySelectors: ["init-front-list"],
      // Skeleton placeholders are PrimeNG's loading state and are a real,
      // observed negative signal: id 3576 carried 13 of them, one per
      // not-yet-painted result. Soft, never absolute — the DETAIL page carries
      // 5 skeletons of its own, and below-the-fold results may be lazy, so
      // this only DELAYS readiness within the budget and can never deadlock
      // (see isRenderReadyListing: it is ignored once the harvest has settled).
      loadingSelectors: ["p-skeleton"],
      // Per-portal render budget (issue #701). Hipoges is the reason the
      // single global MAX_WAIT_MS is the wrong shape: Idealista is ready in
      // about a second, and a ceiling tuned for it truncates a portal that
      // server-renders its chrome first and streams its adverts in afterwards.
      // Raising the GLOBAL number would make every portal's give-up slower to
      // pay for one portal's slowness. 45 s is this portal's budget alone.
      //
      // Chosen, not measured: the honest render time is still unknown (#700 —
      // the 19.5 s figure quoted around #695 is seeded fixture data, and
      // `render_wait_ms` only started populating with extension 0.18.0). It is
      // set generously ON PURPOSE and paired with the `never_rendered` trace
      // below, so the next revision is driven by real numbers instead of a
      // second guess.
      maxWaitMs: 45000,
      // ── Detail URLs without anchors (issue #701) ────────────────────────
      //
      // THE root cause of "no hay anuncios que capturar". Hipoges result cards
      // are not links. In id 3576 the four FULLY PAINTED property cards —
      // real titles, m², prices — carry no <a href> at all; they navigate by
      // Angular click handler. The page's 65 anchors are nav, footer, social
      // and language links, and not one resolves to a detail URL. So
      // extractDetailUrls(), which reads a[href], returns 0 on a rendered
      // Hipoges search page no matter how long anyone waits. This is not a
      // timing bug and no readiness fix alone would have touched it.
      //
      // What the cards DO carry is the advert's own photo, and the CDN path
      // embeds the asset reference, lowercased, in its second-to-last segment:
      //
      //   https://hipoges.azureedge.net/imageshams/hams_es_frankel/rfra02005/
      //                                                    ^^^^^^^^^^^
      //     frre-20005/44680767_f0dde…png   ->   /<lang>/detail/FRRE-20005
      //     ^^^^^^^^^^
      //
      // CONFIRMED TWICE, independently, without touching the site:
      //   * `FRRE-20005` derived this way from id 3576 is already in
      //     production as a SUCCESSFULLY captured detail page — rows 3623 and
      //     3696, `https://realestate.hipoges.com/es/detail/FRRE-20005`.
      //   * the RARE-04347 detail capture's own gallery images sit under
      //     `.../rran01399/rare-04347/…`, matching its own URL id.
      // Different servicer prefixes (rfra/rran/bgal/rgnt), same rule.
      //
      // Narrow on purpose: host-pinned, and the reference must look like a
      // Hipoges asset code. A servicer prefix we have not seen simply yields
      // nothing rather than a fabricated URL.
      mediaDetailHostSuffix: "hipoges.azureedge.net",
      mediaDetailRef: function (pathname) {
        var m = /\/imageshams\/[^/]+\/[^/]+\/([a-z]{4}-\d{4,6})\//i.exec(pathname);
        return m ? m[1].toUpperCase() : null;
      },
      // Build the detail URL in the language the operator is actually browsing
      // in, rather than hard-coding `es` — the route is `:lang/detail/:id`.
      mediaDetailPath: function (ref, pageLang) {
        return "/" + (pageLang || "es") + "/detail/" + ref;
      },
      // How many consecutive polls the harvested count must hold steady before
      // a listing page counts as settled. Hipoges paints its results
      // progressively (4 of 17 at the moment of id 3576), so the FIRST
      // non-zero harvest is not the final one; firing on it would capture a
      // fraction of the search and silently drop the rest.
      harvestSettlePolls: 3,
    },
  ];

  // Minimum trimmed text on a "key node" for it to count as rendered.
  var MIN_HEADING_TEXT = 3;
  // Minimum total rendered body text (chars). An un-rendered SPA shell has
  // almost no text (a few nav words); a rendered listing has thousands. This
  // floor is the primary anti-"empty shell" guard.
  var MIN_BODY_TEXT = 400;
  var DEFAULT_READY_SELECTORS = ["h1", "main"];
  // Default render budget (ms). Portals override with `maxWaitMs`; see
  // maxWaitMsFor(). content-script.js reads this through the helper rather
  // than keeping its own copy, so there is ONE budget per portal, not two.
  var DEFAULT_MAX_WAIT_MS = 20000;

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

  /** ES5-safe `haystack.endsWith(needle)` — the file targets classic content scripts. */
  function endsWithSuffix(haystack, needle) {
    return haystack.length >= needle.length &&
      haystack.slice(haystack.length - needle.length) === needle;
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

  // ── "Capturar todo" batch-queue signal (issue #556) ───────────────────────
  //
  // The dashboard's global "Capturar todo" button (one per profile) can only
  // open ONE tab in its click's user gesture — popup blockers eat any further
  // `window.open` call. So it hands the REST of the ticked tasks to this ONE
  // tab as `?inmo-capture-queue=<json>` (a compact `[portal, captureUrl][]`
  // tuple array; ALWAYS the query form — `withCaptureSignal` already claims
  // the fragment slot for the byte-for-byte-pinned `#inmo-capture` signal, see
  // dashboard/lib/extension-capture.ts). This tab's content script reads it
  // (`parseCaptureQueue` below) and forwards it to background.js's
  // `startBatch`, which appends each entry to the #555/D-112 pending-search
  // queue — the SAME queue a manually-opened second search joins, just seeded
  // programmatically instead of by another `window.open`. Must agree
  // byte-for-byte with dashboard/lib/extension-capture.ts
  // `CAPTURE_QUEUE_SIGNAL` / `encodeCaptureQueue`.
  var CAPTURE_QUEUE_SIGNAL = "inmo-capture-queue";

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
   * the query form `?<signal>=<value>` (already percent-decoded by
   * searchParams). The FRAGMENT branch is percent-DECODED here explicitly
   * (issue #556 review N4) — `URL.hash` is never auto-decoded by the platform
   * the way `searchParams.get()` is, so a value written with
   * `encodeURIComponent` (as `withCaptureQueue` does — see
   * dashboard/lib/extension-capture.ts) would otherwise come back through
   * still percent-encoded and fail `JSON.parse` at the call site, silently
   * degrading to "no queue" instead of a real error. A malformed
   * percent-encoding (`decodeURIComponent` throwing) returns the raw slice
   * unchanged rather than null — the caller's own parsing (e.g. `JSON.parse`)
   * is left to fail safely on it. Pure; null on URL parse error.
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
      var raw = hashKey.slice(prefix.length);
      try {
        return decodeURIComponent(raw);
      } catch (e) {
        return raw;
      }
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
   * Parse the "Capturar todo" queue payload (issue #556) out of `url`:
   * `?inmo-capture-queue=<json>` (a `[portal, captureUrl][]` tuple array; the
   * fragment form is accepted too via `urlSignalValue` for symmetry, though
   * the dashboard opener always uses the query form — see CAPTURE_QUEUE_SIGNAL
   * above). Returns `[]` (never null, never throws) for absent/malformed
   * input, and silently drops any malformed individual entry rather than
   * rejecting the whole list — a bad entry must never lose the good ones.
   * Each entry is `{ portal, searchUrl }`, matching the shape
   * `background.js`'s `startBatch`/`InmoBatch.enqueueSearch` already expect.
   */
  function parseCaptureQueue(url) {
    var raw = urlSignalValue(url, CAPTURE_QUEUE_SIGNAL);
    if (raw == null || raw === "") return [];
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return [];
    }
    if (!Array.isArray(data)) return [];
    var out = [];
    for (var i = 0; i < data.length; i++) {
      var entry = data[i];
      if (
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        entry[0] &&
        typeof entry[1] === "string" &&
        entry[1]
      ) {
        out.push({ portal: entry[0], searchUrl: entry[1] });
      }
    }
    return out;
  }

  /**
   * Return `url` with the "Capturar todo" queue param removed — used before
   * handing this search page's own url to the capture-to-infer learner (issue
   * #303), the same reason `stripCaptureSignal` exists, so our synthetic
   * `inmo-capture-queue` param never pollutes a learned search-url example.
   * Pure; returns the input unchanged on a parse failure.
   */
  function stripCaptureQueue(url) {
    var parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (e) {
      return url;
    }
    if (parsed.hash.replace(/^#/, "").indexOf(CAPTURE_QUEUE_SIGNAL + "=") === 0) {
      parsed.hash = "";
    }
    try {
      if (parsed.searchParams.has(CAPTURE_QUEUE_SIGNAL)) {
        parsed.searchParams.delete(CAPTURE_QUEUE_SIGNAL);
      }
    } catch (e) {
      /* searchParams unavailable — ignore */
    }
    return parsed.toString();
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

  function portalConfigByName(portal) {
    for (var i = 0; i < PORTALS.length; i++) {
      if (PORTALS[i].portal === portal) return PORTALS[i];
    }
    return null;
  }

  /**
   * The readiness selectors for `portal` in a given page ROLE ("detail" or
   * "listing").
   *
   * Historically there was ONE list per portal, shared by both roles. That is
   * fine where a portal server-renders both page types the same way, and wrong
   * on Hipoges, where the detail page has grounded component elements and the
   * listing page's readiness is not a selector question at all (issue #701).
   * A portal may therefore declare `detailReadySelectors` /
   * `listingReadySelectors`; `readySelectors` remains the shared fallback for
   * every portal that has no reason to split, so nothing else changes shape.
   */
  function readySelectorsFor(portal, role) {
    var cfg = portalConfigByName(portal);
    if (!cfg) return DEFAULT_READY_SELECTORS;
    if (role === "listing" && cfg.listingReadySelectors) return cfg.listingReadySelectors;
    if (role === "detail" && cfg.detailReadySelectors) return cfg.detailReadySelectors;
    return cfg.readySelectors || DEFAULT_READY_SELECTORS;
  }

  /**
   * The render budget for `portal`, in ms — how long a caller should keep
   * polling before giving up (issue #701).
   *
   * One global ceiling was the wrong shape. Idealista satisfies readiness in
   * roughly a second; Hipoges server-renders its chrome immediately and then
   * streams its adverts in well afterwards. A single number either truncates
   * the slow portal or makes every fast portal's give-up needlessly late.
   * Portals opt in with `maxWaitMs`; everything else keeps DEFAULT_MAX_WAIT_MS.
   */
  function maxWaitMsFor(portal) {
    var cfg = portalConfigByName(portal);
    return (cfg && cfg.maxWaitMs) || DEFAULT_MAX_WAIT_MS;
  }

  /** Consecutive equal harvests required before a listing page counts settled. */
  function harvestSettlePollsFor(portal) {
    var cfg = portalConfigByName(portal);
    return (cfg && cfg.harvestSettlePolls) || 1;
  }

  /**
   * Detail URLs recovered from MEDIA sources (image `src`, CSS
   * `background-image`) rather than from anchors — issue #701.
   *
   * Only Hipoges needs this today, and it needs it absolutely: its result
   * cards carry no `<a href>` whatsoever (verified on a fully painted card in
   * production capture id 3576), so the anchor harvest returns zero on a
   * perfectly rendered search page. The card's photo URL, however, embeds the
   * advert's own asset reference, which is exactly the `:id` in the
   * `:lang/detail/:id` route. See the portal config for the two independent
   * confirmations of that mapping.
   *
   * Pure. `pageUrl` supplies the origin and the language segment so the built
   * URL matches the page the operator is actually on. A portal that declares
   * no `mediaDetailRef` gets an empty array, which is what every other portal
   * wants.
   */
  function detailUrlsFromMedia(srcs, pageUrl, portal) {
    var out = [];
    var cfg = portalConfigByName(portal);
    if (!cfg || typeof cfg.mediaDetailRef !== "function") return out;
    if (!srcs || typeof srcs.length !== "number") return out;
    var base;
    try {
      base = new URL(String(pageUrl));
    } catch (e) {
      return out;
    }
    // `:lang` of the page we're on, so a Portuguese or Greek operator doesn't
    // get Spanish detail URLs built for them.
    var langMatch = /^\/([a-z]{2})(?:\/|$)/i.exec(base.pathname);
    var lang = langMatch ? langMatch[1].toLowerCase() : "es";
    var seen = Object.create(null);
    for (var i = 0; i < srcs.length; i++) {
      var raw = srcs[i];
      if (typeof raw !== "string" || !raw) continue;
      var parsed;
      try {
        parsed = new URL(raw, base.href);
      } catch (e) {
        continue;
      }
      var mediaHost = parsed.hostname.toLowerCase().replace(/^www\./, "");
      var wantHost = String(cfg.mediaDetailHostSuffix || "").toLowerCase();
      if (!wantHost) continue;
      if (mediaHost !== wantHost && !endsWithSuffix(mediaHost, "." + wantHost)) continue;
      var ref = null;
      try {
        ref = cfg.mediaDetailRef(parsed.pathname);
      } catch (e) {
        ref = null;
      }
      if (!ref || seen[ref]) continue;
      seen[ref] = true;
      out.push(base.origin + cfg.mediaDetailPath(ref, lang));
    }
    return out;
  }

  /**
   * Every media URL a document exposes: `<img src>`, `<img data-src>`,
   * `<source srcset>` and inline `background-image:url(...)`. Kept here (pure,
   * `doc` injected) rather than in content-script.js so it is unit-testable
   * against a fixture, same discipline as isRenderReadyDetail.
   */
  function mediaSourcesFromDoc(doc) {
    var out = [];
    if (!doc || typeof doc.querySelectorAll !== "function") return out;
    var nodes;
    try {
      nodes = doc.querySelectorAll("img[src], img[data-src], source[srcset], [style*='background-image']");
    } catch (e) {
      return out;
    }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var src = el.getAttribute && (el.getAttribute("src") || el.getAttribute("data-src"));
      if (src) out.push(src);
      var srcset = el.getAttribute && el.getAttribute("srcset");
      if (srcset) {
        var parts = srcset.split(",");
        for (var j = 0; j < parts.length; j++) {
          var u = parts[j].trim().split(/\s+/)[0];
          if (u) out.push(u);
        }
      }
      var style = el.getAttribute && el.getAttribute("style");
      if (style && style.indexOf("background-image") !== -1) {
        var re = /url\((['"]?)([^'")]+)\1\)/g;
        var m;
        while ((m = re.exec(style)) !== null) out.push(m[2]);
      }
    }
    return out;
  }

  /**
   * The full detail-URL harvest for a rendered results page: anchors first
   * (every portal), then media-derived URLs for the portals whose cards are
   * not links (Hipoges — issue #701). Deduplicated on the same matchKey the
   * anchor path uses, so a portal that exposes BOTH never double-counts.
   */
  function harvestDetailUrls(doc, portal, pageUrl) {
    var hrefs = [];
    if (doc && typeof doc.querySelectorAll === "function") {
      try {
        var anchors = doc.querySelectorAll("a[href]");
        for (var i = 0; i < anchors.length; i++) hrefs.push(anchors[i].href);
      } catch (e) {
        /* fall through to media */
      }
    }
    var out = extractDetailUrls(hrefs, portal);
    var seen = Object.create(null);
    for (var k = 0; k < out.length; k++) seen[matchKey(out[k])] = true;
    var media = detailUrlsFromMedia(mediaSourcesFromDoc(doc), pageUrl, portal);
    for (var m = 0; m < media.length; m++) {
      var key = matchKey(media[m]);
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push(media[m]);
    }
    return out;
  }

  /**
   * Does `doc` still show LOADING placeholders for this portal (issue #701)?
   *
   * Grounded on Hipoges' PrimeNG `<p-skeleton>`: production capture id 3576
   * carried 13 of them, one per result that had not painted yet, alongside 4
   * real cards — the owner's 17. A soft signal only: callers use it to keep
   * waiting, never as a hard veto, because the DETAIL page carries 5 skeletons
   * of its own and below-the-fold results may be lazily rendered.
   */
  function pendingPlaceholderCount(doc, portal) {
    var cfg = portalConfigByName(portal);
    if (!cfg || !cfg.loadingSelectors || !doc || typeof doc.querySelectorAll !== "function") {
      return 0;
    }
    var n = 0;
    for (var i = 0; i < cfg.loadingSelectors.length; i++) {
      try {
        n += doc.querySelectorAll(cfg.loadingSelectors[i]).length;
      } catch (e) {
        /* a selector this browser can't parse simply contributes nothing */
      }
    }
    return n;
  }

  /**
   * Heuristic: has the JS-rendered detail page actually painted its content
   * (vs. an empty SPA shell captured too early)? Requires BOTH:
   *   1. a "key" content node present with non-trivial text, AND
   *   2. total body text above MIN_BODY_TEXT.
   * `doc` is injected (not the global `document`) so it's testable against
   * fabricated DOM fixtures. Never throws.
   *
   * Returns the FULL verdict — `{ ready, selector, reason, bodyTextLength }` —
   * where `selector` is the FIRST readySelectors entry (in declaration order)
   * that satisfied the "key node" check, or null when none did / body-text
   * floor failed / doc wasn't ready. `reason` is one of 'no_doc',
   * 'not_interactive', 'no_key_node', 'body_text_too_short', or null when
   * ready — a short breadcrumb for the force-capture diagnostic (issue #671),
   * which is exactly the field that would have explained the Hipoges empty-
   * shell capture (`init-front-list` alone satisfying `main`) instantly.
   *
   * isRenderReady() below is a THIN WRAPPER over this — the diagnostic
   * feature and every auto-capture caller share this ONE computation, never
   * two independently-drifting implementations.
   */
  function isRenderReadyDetail(doc, portal) {
    if (!doc || typeof doc.querySelector !== "function") {
      return { ready: false, selector: null, reason: "no_doc", bodyTextLength: 0 };
    }
    var rs = doc.readyState;
    if (rs && rs !== "interactive" && rs !== "complete") {
      return { ready: false, selector: null, reason: "not_interactive", bodyTextLength: 0 };
    }

    var selectors = readySelectorsFor(portal, "detail");
    var matchedSelector = null;
    for (var i = 0; i < selectors.length; i++) {
      var el = null;
      try {
        el = doc.querySelector(selectors[i]);
      } catch (e) {
        el = null;
      }
      if (el && (el.textContent || "").trim().length >= MIN_HEADING_TEXT) {
        matchedSelector = selectors[i];
        break;
      }
    }
    var bodyText = ((doc.body && doc.body.textContent) || "").trim();
    if (!matchedSelector) {
      return {
        ready: false,
        selector: null,
        reason: "no_key_node",
        bodyTextLength: bodyText.length,
      };
    }

    if (bodyText.length < MIN_BODY_TEXT) {
      return {
        ready: false,
        selector: matchedSelector,
        reason: "body_text_too_short",
        bodyTextLength: bodyText.length,
      };
    }

    return { ready: true, selector: matchedSelector, reason: null, bodyTextLength: bodyText.length };
  }

  /** Boolean-only view of isRenderReadyDetail() — every existing caller's shape. */
  function isRenderReady(doc, portal) {
    return isRenderReadyDetail(doc, portal).ready;
  }

  /**
   * Is a SEARCH/RESULTS page ready to be harvested (issue #701)?
   *
   * Deliberately a different question from isRenderReadyDetail's. On a detail
   * page "rendered" means "the advert's own content is on screen", and a
   * selector can say so. On a results page the only thing that actually
   * matters is whether there is anything to harvest — and Hipoges proved that
   * a selector cannot answer that: `main` and `h1` were both satisfied, by the
   * header, while every result was still a skeleton and the anchor harvest
   * returned zero (production capture id 3576).
   *
   * So readiness here is the operation's OWN success condition, measured
   * rather than inferred:
   *
   *   1. the document is at least interactive, and
   *   2. the portal's listing selectors match (we are on the right page), and
   *   3. the harvest has produced at least one detail URL, and
   *   4. that count has held STEADY for `harvestSettlePolls` consecutive
   *      polls, and no loading placeholders remain.
   *
   * (4) is what stops the extension firing on a partially painted list. Hipoges
   * paints progressively — 4 of 17 at the moment of id 3576 — so the first
   * non-zero harvest is not the final one, and capturing it would silently
   * drop the rest of the search.
   *
   * `state` is the caller's running settle state ({count, stable}); it is
   * threaded through rather than held here so this stays pure and testable.
   * Returns the FULL verdict plus the state to pass to the next poll.
   *
   * IMPORTANT — this can never deadlock on placeholders. Once the harvest count
   * has settled, a lingering skeleton (a lazy below-the-fold card, or the 5 the
   * DETAIL template always carries) no longer holds readiness back: the
   * `stable` counter is what gates, and a stuck skeleton with a steady count
   * still reaches `ready`. The budget in maxWaitMsFor() is the outer bound.
   */
  function isRenderReadyListing(doc, portal, pageUrl, state) {
    var prev = state && typeof state.count === "number" ? state : { count: -1, stable: 0 };
    var fail = function (reason, urls, next) {
      return {
        ready: false,
        reason: reason,
        detailUrls: urls || [],
        placeholders: 0,
        state: next || { count: prev.count, stable: 0 },
      };
    };
    if (!doc || typeof doc.querySelector !== "function") return fail("no_doc");
    var rs = doc.readyState;
    if (rs && rs !== "interactive" && rs !== "complete") return fail("not_interactive");

    var selectors = readySelectorsFor(portal, "listing");
    var matched = null;
    for (var i = 0; i < selectors.length; i++) {
      var el = null;
      try {
        el = doc.querySelector(selectors[i]);
      } catch (e) {
        el = null;
      }
      if (el) {
        matched = selectors[i];
        break;
      }
    }
    if (!matched) return fail("no_key_node");

    var urls = harvestDetailUrls(doc, portal, pageUrl);
    var placeholders = pendingPlaceholderCount(doc, portal);
    // Count steady since the last poll? (A first observation is never steady.)
    var stable = urls.length === prev.count ? prev.stable + 1 : 1;
    var next = { count: urls.length, stable: stable };

    if (urls.length === 0) {
      return {
        ready: false,
        reason: placeholders > 0 ? "still_loading" : "no_detail_urls",
        detailUrls: [],
        placeholders: placeholders,
        state: next,
      };
    }
    var needed = harvestSettlePollsFor(portal);
    if (stable < needed) {
      return {
        ready: false,
        reason: placeholders > 0 ? "still_loading" : "not_settled",
        detailUrls: urls,
        placeholders: placeholders,
        state: next,
      };
    }
    return {
      ready: true,
      reason: null,
      detailUrls: urls,
      placeholders: placeholders,
      state: next,
    };
  }

  /**
   * Block/challenge detection (issue #634, hardened per fresh-context review
   * B1). A SMALL, portal-agnostic set of ROBUST signatures — a challenge-page
   * marker library rots slower than a long brittle selector list, and this
   * repo has already hit two of these for real: idealista's DataDome CAPTCHA
   * wall (`captcha-delivery.com`, see docs/skills/connectors.md) and the
   * GeeTest "Pardon Our Interruption" wall (#captcha-box, static.geetest.com
   * — hit twice live during #628, see milanuncios_sample_soft_block_page.html).
   * Cloudflare/Incapsula/Akamai are the documented WAFs behind
   * D-026/D-027/D-081's "routes to browser-extension capture" batch — this
   * extension is exactly where a human would now meet them. Every check is
   * READ-ONLY DOM inspection: no solving, no retrying, no header/identity
   * changes (issue #1 §15 / D-033 / D-075).
   *
   * A MARKER ALONE IS NOT ENOUGH (review B1). Several of these hosts/ids are
   * NOT exclusive to a full-page interstitial: `challenges.cloudflare.com`
   * also serves the Turnstile WIDGET a portal can embed in an ordinary
   * contact form; `_Incapsula_Resource` is injected by Imperva into
   * perfectly ordinary 200 responses as a defensive anti-bot tag; GeeTest's
   * `#captcha-box` id or the "Pardon Our Interruption" phrase can appear on
   * an ordinary rendered page (a contact widget, or listing copy that merely
   * quotes it). `detectBlockSignals` therefore requires CORROBORATION: a
   * candidate marker only counts once `!isRenderReady(doc, portal)` — the
   * SAME render-readiness heuristic auto-capture already trusts to know a
   * page painted its real content. A genuine full-page interstitial (or a
   * WAF/login wall) never renders the portal's real listing/search content,
   * so this costs no true positives while killing the false-positive class
   * above at the source.
   *
   * Deliberately conservative: an unrecognised page (including a genuinely
   * empty search or a 404/removed-listing page — neither carries any of these
   * markers, corroborated or not) returns { blocked: false, signature: null }
   * — see the false-positive tests in extension-block-detect.test.ts,
   * including the "healthy page that happens to contain a plausible marker"
   * cases review B1 called out. A bad/throwing selector on one signature must
   * never crash detection or block the others.
   */
  // ── The rate-limit / "prove you're human" challenge phrase table ──────────
  //
  // THE ONE PLACE TO EDIT when a portal rewords its challenge page. Every
  // entry is an accent-FOLDED, lowercased fragment of the operator's own
  // voice on a soft-block interstitial — the portal talking to the visitor
  // about the visitor's own request behaviour. Matched against visible text
  // via foldAccents(), so "verificación"/"verificacion" and any case
  // variation all hit the same entry.
  //
  // Grounded in the page idealista actually served during the #683 re-capture
  // drain (owner screenshots, 2026-08-22), which is served AT THE LISTING URL
  // ITSELF — so a batch capture of `/inmueble/<id>/` captures the challenge
  // instead of the advert, and every downstream consumer sees a page with no
  // advert fields on it.
  //
  // DELIBERATELY EXCLUDED: the visitor's own IP address and the per-visit
  // `ID:` UUID the page also renders. Both are per-visit values (and personal
  // data — public repo), so neither may ever become a signature or reach a
  // log, a fixture or an issue.
  var CHALLENGE_PHRASES = [
    // "Vaya! parece que estamos recibiendo muchas peticiones tuyas en poco
    // tiempo" — split into two independent fragments so a reworded connector
    // ("hemos recibido demasiadas peticiones…") still lands one of them.
    "muchas peticiones",
    "en poco tiempo",
    // The slider widget's own instruction.
    "desliza hacia la derecha",
    // The explainer heading and its opening line.
    "por que esta verificacion",
    "comportamiento del navegador",
    // The three bulleted "varias posibilidades".
    "velocidad sobrehumana",
    "bloquea el funcionamiento de javascript",
    "un robot se encuentra en la misma red",
  ];

  // Folding table for the five Spanish accented vowels plus ñ — the same
  // five-vowel fold etl/soft_block.py applies, kept deliberately narrow so a
  // 400 KB page costs one regex pass rather than full Unicode normalization.
  var ACCENT_FOLD_FROM = "áàäâéèëêíìïîóòöôúùüûñÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑ";
  var ACCENT_FOLD_TO = "aaaaeeeeiiiioooouuuunAAAAEEEEIIIIOOOOUUUUN";

  /** Lowercase + fold the five Spanish accented vowels and ñ. Never throws. */
  function foldAccents(text) {
    var s = ((text || "") + "").toLowerCase();
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var idx = ACCENT_FOLD_FROM.indexOf(s.charAt(i));
      out += idx === -1 ? s.charAt(i) : ACCENT_FOLD_TO.charAt(idx);
    }
    return out;
  }

  /**
   * How many DISTINCT CHALLENGE_PHRASES appear in the document's visible
   * text. Exported for tests and for the threshold's own justification.
   *
   * "Visible text" means `body.textContent` with <script>/<style>/<noscript>
   * subtrees excluded — the same rule etl/soft_block.py and #691's
   * `_strip_to_visible_text` apply, for the same reason: a JS string literal
   * is not the portal telling the human anything. Read-only; never mutates
   * the live DOM (unlike the Python side, which owns a private soup).
   */
  function challengePhraseHits(doc) {
    if (!doc || !doc.body) return 0;
    var text;
    try {
      var walker = doc.createTreeWalker
        ? doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */, null)
        : null;
      if (walker) {
        var parts = [];
        for (var n = walker.nextNode(); n; n = walker.nextNode()) {
          var tag =
            n.parentNode && n.parentNode.nodeName
              ? ("" + n.parentNode.nodeName).toLowerCase()
              : "";
          if (tag === "script" || tag === "style" || tag === "noscript") continue;
          parts.push(n.nodeValue || "");
        }
        text = parts.join(" ");
      } else {
        text = doc.body.textContent || "";
      }
    } catch (e) {
      try {
        text = doc.body.textContent || "";
      } catch (e2) {
        return 0;
      }
    }
    var folded = foldAccents(text).replace(/\s+/g, " ");
    var hits = 0;
    for (var i = 0; i < CHALLENGE_PHRASES.length; i++) {
      if (folded.indexOf(CHALLENGE_PHRASES[i]) !== -1) hits++;
    }
    return hits;
  }

  // Two distinct phrases must co-occur. ONE alone is not enough: a
  // seller-written description could conceivably contain "en poco tiempo"
  // ("se vende en poco tiempo"), and a portal help page could mention a
  // CAPTCHA. Two fragments of the operator's own anti-bot voice, in the same
  // document, is not something a property advert produces — which is what
  // lets this signature stand WITHOUT the isRenderReady corroboration every
  // other signature needs (see selfCorroborated below).
  var CHALLENGE_MIN_PHRASE_HITS = 2;

  var BLOCK_SIGNATURES = [
    {
      id: "rate_limit_challenge",
      // ── Why this one is `selfCorroborated` ────────────────────────────────
      //
      // MEASURED, not assumed (2026-08-22). The idealista challenge page
      // renders ~490 characters of prose inside a <main> — its heading, the
      // slider instruction, the "¿por qué esta verificación?" explainer and
      // three bullets. That clears BOTH of isRenderReady's tests: the generic
      // `main`/`h1` fallback readySelectors find a key node with text, and
      // the 488-char body beats MIN_BODY_TEXT (400).
      //
      // So `isRenderReady(challengePage, "idealista") === true`, and the
      // standard corroboration in detectBlockSignals THREW THE MATCH AWAY —
      // including the `captcha_wall` DataDome marker, which matched the page
      // correctly and was then vetoed. That is exactly why the #683 drain
      // sailed straight through the wall instead of halting: the detector saw
      // the block and then talked itself out of it.
      //
      // The corroboration exists to stop a marker on a HEALTHY page counting
      // as a block (a Turnstile widget on a contact form, an advert quoting a
      // phrase). It assumes "rendered real content" and "interstitial" are
      // mutually exclusive. A text-rich challenge page breaks that assumption
      // outright, so this signature carries its own corroboration instead:
      // the two-distinct-phrase requirement above. It is strictly narrower
      // than a render-readiness heuristic, not looser.
      selfCorroborated: true,
      matches: function (doc) {
        return challengePhraseHits(doc) >= CHALLENGE_MIN_PHRASE_HITS;
      },
    },
    {
      id: "cloudflare_challenge",
      matches: function (doc) {
        // The actual JS-challenge ORCHESTRATION script — language-independent,
        // and (review B1) a DIFFERENT PATH than the Turnstile WIDGET script
        // (`/turnstile/v0/api.js`) a portal can embed in an ordinary contact
        // form on the SAME `challenges.cloudflare.com` host. Matching the
        // path, not just the host, is what tells the two apart.
        if (safeQuery(doc, "script[src*='/cdn-cgi/challenge-platform/']")) return true;
        if (
          safeQuery(
            doc,
            "#cf-chl-widget, #challenge-running, #challenge-form, .cf-browser-verification, [data-translate='checking_browser']",
          )
        ) {
          return true;
        }
        // Weak fallback only: Cloudflare's system page title is commonly
        // English even on Spanish sites, but a localised deployment won't
        // match this — the two checks above are the primary,
        // language-independent signal (review B1's Spanish-title gap).
        var title = ((doc.title || "") + "").toLowerCase();
        return title.indexOf("just a moment") !== -1;
      },
    },
    {
      id: "captcha_wall",
      // DataDome's interstitial (confirmed live on idealista — every request
      // gets a 403 CAPTCHA from captcha-delivery.com regardless of UA).
      matches: function (doc) {
        return !!safeQuery(
          doc,
          "script[src*='captcha-delivery.com'], iframe[src*='captcha-delivery.com'], #ddv1-captcha-container",
        );
      },
    },
    {
      id: "geetest_challenge",
      // Confirmed live on milanuncios (#179/#628): "Pardon Our Interruption",
      // noindex/nofollow, #captcha-box. GeeTest is a third-party widget any of
      // this extension's portals could equally sit behind.
      matches: function (doc) {
        if (safeQuery(doc, "#captcha-box, .geetest_holder, script[src*='static.geetest.com']")) {
          return true;
        }
        var body = ((doc.body && doc.body.textContent) || "");
        return body.indexOf("Pardon Our Interruption") !== -1;
      },
    },
    {
      id: "incapsula_challenge",
      // Sareb's edge WAF (D-026) — a generic Incapsula/Imperva JS challenge.
      matches: function (doc) {
        return !!safeQuery(
          doc,
          "script[src*='_Incapsula_Resource'], iframe[src*='_Incapsula_Resource']",
        );
      },
    },
    {
      id: "akamai_deny",
      // Altamira's edge WAF (D-027) — Akamai's own static deny template:
      // title "Access Denied" + a "Reference #..." id, no challenge to solve.
      matches: function (doc) {
        var title = ((doc.title || "") + "").trim();
        if (title !== "Access Denied") return false;
        var body = (doc.body && doc.body.textContent) || "";
        return /Reference #[\w.]+/.test(body);
      },
    },
    {
      id: "waf_denied",
      // A generic "the edge/app rejected this request" page (review B1 — the
      // issue's own "WAF 403" example, which akamai_deny's narrow
      // Reference-# requirement doesn't cover). Deliberately broad text
      // matching is SAFE here only because it is always corroborated by
      // !isRenderReady below — a real listing page that happens to mention
      // "acceso denegado" in passing still renders real content elsewhere
      // and is excluded.
      matches: function (doc) {
        var title = ((doc.title || "") + "").trim();
        var h1 = safeQuery(doc, "h1");
        var heading = ((h1 && h1.textContent) || "").trim();
        var text = (title + " " + heading).toLowerCase();
        if (text.indexOf("acceso denegado") !== -1) return true;
        if (text.indexOf("access denied") !== -1) return true;
        return /\b403\b/.test(text) && text.indexOf("forbidden") !== -1;
      },
    },
    {
      id: "session_wall",
      // A redirect to a login/session-verification wall — the issue's own
      // third "blocked" example. A password field with no real listing
      // content nearby; corroborated the same as every other signature.
      matches: function (doc) {
        if (!safeQuery(doc, "input[type='password']")) return false;
        var body = ((doc.body && doc.body.textContent) || "").toLowerCase();
        return (
          body.indexOf("iniciar sesión") !== -1 ||
          body.indexOf("inicia sesión") !== -1 ||
          body.indexOf("verifica tu cuenta") !== -1 ||
          body.indexOf("sesión ha caducado") !== -1 ||
          body.indexOf("sesión caducada") !== -1 ||
          body.indexOf("session expired") !== -1 ||
          body.indexOf("sign in") !== -1 ||
          body.indexOf("log in") !== -1
        );
      },
    },
  ];

  function safeQuery(doc, selector) {
    if (!doc || typeof doc.querySelector !== "function") return null;
    try {
      return doc.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  /**
   * Run every signature against `doc`, requiring CORROBORATION (see the
   * module comment above): a marker only counts once the page has NOT
   * actually rendered its real content (`!isRenderReady(doc, portal)`).
   * `portal` is passed straight through to isRenderReady's per-portal
   * readySelectors — pass null/omit for a page with no known portal (falls
   * back to the generic h1/main heuristic). Returns the FIRST corroborated
   * match as `{ blocked: true, signature: <id> }`, or
   * `{ blocked: false, signature: null }` when nothing matched (or every
   * candidate match was on a page that genuinely rendered) — the safe
   * default for any page this list doesn't recognise. Never throws.
   */
  /**
   * Has this page rendered its REAL content — as opposed to being a block
   * interstitial, an error page, or an empty shell? The veto below turns on
   * this question, and issue #701 made it necessary to ask it per page ROLE.
   *
   * Detail readiness alone used to be a serviceable proxy because every
   * portal's ready selectors ended in the generic `main`/`h1` pair, which a
   * rendered SEARCH page satisfies too. Hipoges no longer has that fallback
   * (it is what let an empty shell pass as an advert), so on a Hipoges results
   * page detail readiness is now permanently false — and without this branch
   * the veto would never apply there, letting any stray challenge phrase on a
   * perfectly healthy search page pause the whole batch run.
   *
   * A results page that has real adverts on it IS rendered content. Note this
   * deliberately does NOT require the settle window `isRenderReadyListing`
   * imposes: "are there adverts here" is the question, not "has the list
   * finished growing". Scoped to portals that declare listing selectors, so
   * every other portal's behaviour is byte-for-byte unchanged.
   */
  function pageRenderedRealContent(doc, portal, pageUrl) {
    if (isRenderReadyDetail(doc, portal).ready) return true;
    var cfg = portalConfigByName(portal);
    if (!cfg || !cfg.listingReadySelectors) return false;
    try {
      var url = pageUrl || (doc && (doc.baseURI || (doc.location && doc.location.href))) || "";
      return harvestDetailUrls(doc, portal, url).length > 0;
    } catch (e) {
      return false;
    }
  }

  function detectBlockSignals(doc, portal, pageUrl) {
    if (!doc || typeof doc.querySelector !== "function") {
      return { blocked: false, signature: null };
    }
    for (var i = 0; i < BLOCK_SIGNATURES.length; i++) {
      var matched = false;
      try {
        matched = !!BLOCK_SIGNATURES[i].matches(doc);
      } catch (e) {
        matched = false;
      }
      if (!matched) continue;
      // A SELF-CORROBORATED signature skips the render-readiness veto: its
      // own `matches` is already narrower than the veto would be, and the
      // veto actively MISFIRES on the case it covers (a text-rich challenge
      // interstitial reads as "rendered" — see rate_limit_challenge above).
      if (BLOCK_SIGNATURES[i].selfCorroborated) {
        return { blocked: true, signature: BLOCK_SIGNATURES[i].id };
      }
      try {
        // A page that actually rendered its real content is NOT a block,
        // regardless of which marker matched (review B1) — a Turnstile
        // widget, an Incapsula anti-bot tag, or a mere mention of a phrase
        // can all coexist with a genuine listing/search page.
        if (pageRenderedRealContent(doc, portal, pageUrl)) continue;
      } catch (e) {
        /* corroboration itself failed — treat as "can't confirm healthy",
           fall through to the conservative "blocked" verdict below */
      }
      return { blocked: true, signature: BLOCK_SIGNATURES[i].id };
    }
    return { blocked: false, signature: null };
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
    CHALLENGE_PHRASES: CHALLENGE_PHRASES,
    CHALLENGE_MIN_PHRASE_HITS: CHALLENGE_MIN_PHRASE_HITS,
    foldAccents: foldAccents,
    challengePhraseHits: challengePhraseHits,
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
    isRenderReadyDetail: isRenderReadyDetail,
    isRenderReadyListing: isRenderReadyListing,
    harvestDetailUrls: harvestDetailUrls,
    detailUrlsFromMedia: detailUrlsFromMedia,
    mediaSourcesFromDoc: mediaSourcesFromDoc,
    pendingPlaceholderCount: pendingPlaceholderCount,
    readySelectorsFor: readySelectorsFor,
    maxWaitMsFor: maxWaitMsFor,
    harvestSettlePollsFor: harvestSettlePollsFor,
    DEFAULT_MAX_WAIT_MS: DEFAULT_MAX_WAIT_MS,
    detectBlockSignals: detectBlockSignals,
    pageRenderedRealContent: pageRenderedRealContent,
    createCaptureGuard: createCaptureGuard,
    CAPTURE_SIGNAL: CAPTURE_SIGNAL,
    DISCOVER_SIGNAL: DISCOVER_SIGNAL,
    VALIDATE_SIGNAL: VALIDATE_SIGNAL,
    CAPTURE_QUEUE_SIGNAL: CAPTURE_QUEUE_SIGNAL,
    captureSignalPresent: captureSignalPresent,
    discoverSignalPresent: discoverSignalPresent,
    withCaptureSignal: withCaptureSignal,
    stripCaptureSignal: stripCaptureSignal,
    parseCaptureQueue: parseCaptureQueue,
    stripCaptureQueue: stripCaptureQueue,
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
