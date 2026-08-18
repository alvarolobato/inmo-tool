// @vitest-environment jsdom
/**
 * Unit tests for the browser-extension's pure auto-capture detection helpers
 * (issue #254). These import the REAL extension module
 * (browser-extension/detect.js) — not a copy — so the shipped detection logic
 * is what's under test. The DOM-touching timing/wiring in content-script.js is
 * NOT unit-testable in-process (it depends on the chrome.* extension APIs and
 * real MutationObserver timing across a live page load); this file covers the
 * three pieces the issue calls out as pure functions: is-this-a-detail-page,
 * render-readiness, and the fire-once guard.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as mod from "../../browser-extension/detect.js";

// detect.js publishes via `module.exports = api`; vite's CJS interop may expose
// it as the default export or spread the named keys — accept either.
const D = (mod as unknown as { default?: Record<string, unknown> }).default ?? mod;
const {
  detailPortalForUrl,
  isDetailUrl,
  matchKey,
  isRenderReady,
  createCaptureGuard,
  listingPortalForUrl,
  isListingUrl,
  supportedPortalForUrl,
  pageRoleForUrl,
  extractDetailUrls,
  captureSignalPresent,
  withCaptureSignal,
  stripCaptureSignal,
  validateSignalPayload,
  validateSignalPresent,
  stripValidateSignal,
  inValidationMode,
  buildValidationSavePayload,
  listingCaptureAction,
  buildCaptureBanner,
  RESULTS_PAGE_CAP,
  currentResultsPage,
  resultsPageUrl,
  nextResultsUrl,
  nextResultsUrlFromHrefs,
  toListingUrl,
} = D as {
  detailPortalForUrl: (u: string) => string | null;
  isDetailUrl: (u: string) => boolean;
  matchKey: (u: string) => string;
  isRenderReady: (doc: Document, portal: string) => boolean;
  createCaptureGuard: () => {
    claim: (k: string) => boolean;
    settle: (k: string) => void;
    release: (k: string) => void;
    isDone: (k: string) => boolean;
    isInflight: (k: string) => boolean;
  };
  listingPortalForUrl: (u: string) => string | null;
  isListingUrl: (u: string) => boolean;
  supportedPortalForUrl: (u: string) => string | null;
  pageRoleForUrl: (u: string) => "detail" | "listing" | "other" | null;
  extractDetailUrls: (hrefs: unknown, portal?: string) => string[];
  captureSignalPresent: (u: string) => boolean;
  withCaptureSignal: (u: string) => string;
  stripCaptureSignal: (u: string) => string;
  validateSignalPayload: (u: string) => { profileId: number; connector: string } | null;
  validateSignalPresent: (u: string) => boolean;
  stripValidateSignal: (u: string) => string;
  inValidationMode: (u: string, active: boolean) => boolean;
  buildValidationSavePayload: (
    state: { profileId?: number; connector?: string } | null,
    url: string,
  ) => { profileId: number; connector: string; url: string; source: string } | null;
  listingCaptureAction: (
    u: string,
    detailUrls: unknown,
  ) => {
    action: "none" | "autostart" | "banner" | "convert";
    portal?: string;
    count?: number;
    listingUrl?: string;
  };
  buildCaptureBanner: (
    doc: Document,
    opts: {
      count?: number;
      label?: string;
      buttonText?: string;
      onCapture?: () => void;
      onDismiss?: () => void;
    },
  ) => HTMLElement | null;
  RESULTS_PAGE_CAP: number;
  currentResultsPage: (u: string) => number;
  resultsPageUrl: (u: string, n: number) => string | null;
  nextResultsUrl: (u: string) => string | null;
  nextResultsUrlFromHrefs: (
    hrefs: unknown,
    currentUrl: string,
    portal: string,
  ) => string | null;
  toListingUrl: (u: string) => string;
};

describe("detailPortalForUrl — only real listing-detail pages", () => {
  const CASES: [string, string | null][] = [
    // Idealista: /inmueble/<numeric-id>[/] only.
    ["https://www.idealista.com/inmueble/106387165/", "idealista"],
    ["https://www.idealista.com/inmueble/106387165", "idealista"],
    ["https://idealista.com/inmueble/1/", "idealista"],
    // Idealista non-detail pages → null.
    ["https://www.idealista.com/", null],
    ["https://www.idealista.com/venta-viviendas/madrid-madrid/", null],
    ["https://www.idealista.com/areas/venta-viviendas/", null],
    ["https://www.idealista.com/inmueble/", null],
    ["https://www.idealista.com/inmueble/not-numeric/", null], // conservative: id must be numeric
    // Aliseda: /inmueble/<id> where id may be an alphanumeric slug.
    ["https://www.alisedainmobiliaria.com/inmueble/ANT1", "aliseda"],
    ["https://www.alisedainmobiliaria.com/inmueble/ANT1/", "aliseda"],
    ["https://www.alisedainmobiliaria.com/inmueble/ANT1?utm_source=x#gallery", "aliseda"],
    ["https://alisedainmobiliaria.com/inmueble/piso-antequera-123", "aliseda"],
    // Aliseda non-detail pages → null.
    ["https://www.alisedainmobiliaria.com/", null],
    ["https://www.alisedainmobiliaria.com/comprar/vivienda/malaga", null],
    ["https://www.alisedainmobiliaria.com/inmueble", null],
    // Altamira (issue #271): VERIFIED against real captures —
    // /venta-de-<tipo>/<provincia>/<municipio>/segunda-mano/<REF>/<id>/1.
    [
      "https://www.altamirainmuebles.com/venta-de-atico/pontevedra/sanxenxo/segunda-mano/9186_1001_PE0001/375859/1",
      "altamira",
    ],
    [
      "https://www.altamirainmuebles.com/venta-de-casa/murcia/alhama-de-murcia/segunda-mano/9186-1004-pe0001/375864/1",
      "altamira",
    ],
    // Trailing photo-index segment optional; query/fragment ignored.
    [
      "https://www.altamirainmuebles.com/alquiler-de-piso/madrid/madrid/segunda-mano/9186_2002_PE0001/400111?utm=x#foto",
      "altamira",
    ],
    // Altamira non-detail pages → null (the old /inmueble|/ficha guess is gone).
    ["https://www.altamirainmuebles.com/", null],
    ["https://www.altamirainmuebles.com/venta-viviendas/cualquier-provincia", null],
    ["https://www.altamirainmuebles.com/venta-viviendas/pontevedra", null],
    ["https://www.altamirainmuebles.com/inmueble/ABC123", null],
    // Hipoges (issue #207/D-111): grounded in the site's own public Angular
    // route table — /<lang>/detail/<id> or /<lang>/<investment>/detail/<id>,
    // optionally suffixed /contact-received or /unavailable. DOM extraction
    // is an unvalidated draft; only this URL shape is grounded.
    ["https://realestate.hipoges.com/es/detail/12345", "hipoges"],
    ["https://realestate.hipoges.com/es/detail/12345/contact-received", "hipoges"],
    ["https://realestate.hipoges.com/es/detail/12345/unavailable", "hipoges"],
    ["https://realestate.hipoges.com/es/npl/detail/ABC-123", "hipoges"],
    ["https://realestate.hipoges.com/pt/detail/12345?utm=x#foto", "hipoges"],
    // Hipoges non-detail pages → null.
    ["https://realestate.hipoges.com/", null],
    ["https://realestate.hipoges.com/es", null],
    ["https://realestate.hipoges.com/es/sale/flat/spain/madrid", null],
    ["https://realestate.hipoges.com/es/detail", null],
    // Unsupported host → null even on a detail-shaped path.
    ["https://www.fotocasa.es/inmueble/123/", null],
    ["https://example.com/inmueble/123/", null],
    ["https://hipoges.com/es/detail/12345", null], // corporate domain, not the real-estate host
    // Non-http(s) / garbage → null.
    ["javascript://idealista.com/inmueble/1/%0aalert(1)", null],
    ["not a url", null],
    ["", null],
  ];

  it.each(CASES)("%s → %s", (url, expected) => {
    expect(detailPortalForUrl(url)).toBe(expected);
    expect(isDetailUrl(url)).toBe(expected !== null);
  });
});

describe("matchKey — fire-once dedup key (mirrors worklistMatchKey)", () => {
  it("drops scheme/www/query/fragment/trailing-slash, keeps path case", () => {
    expect(matchKey("https://www.alisedainmobiliaria.com/inmueble/ANT1/?utm=x#g")).toBe(
      "alisedainmobiliaria.com/inmueble/ANT1",
    );
    expect(matchKey("http://Idealista.com/inmueble/106387165/")).toBe(
      "idealista.com/inmueble/106387165",
    );
    expect(matchKey("not a url")).toBe("");
  });
});

describe("isRenderReady — not an empty SPA shell", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  const LONG_TEXT = "Piso en venta en el centro. ".repeat(40); // > 400 chars

  it("false for an un-rendered shell (no content, tiny body)", () => {
    document.body.innerHTML = `<div id="app"></div>`;
    expect(isRenderReady(document, "aliseda")).toBe(false);
    expect(isRenderReady(document, "idealista")).toBe(false);
  });

  it("false when a heading exists but the body is still nearly empty (anti-shell floor)", () => {
    document.body.innerHTML = `<main><h1>Piso</h1></main>`;
    expect(isRenderReady(document, "idealista")).toBe(false);
  });

  it("true once a key node has text AND the body has real rendered content", () => {
    document.body.innerHTML = `<main><h1>Piso en venta en Antequera</h1><p>${LONG_TEXT}</p></main>`;
    expect(isRenderReady(document, "idealista")).toBe(true);
    expect(isRenderReady(document, "aliseda")).toBe(true);
    expect(isRenderReady(document, "altamira")).toBe(true);
    // Hipoges' readySelectors are the generic h1/main fallback — no real
    // capture exists yet to ground a portal-specific selector (D-111).
    expect(isRenderReady(document, "hipoges")).toBe(true);
  });

  it("uses generic h1/main fallback for an unknown portal", () => {
    document.body.innerHTML = `<main><h1>Un título largo aquí</h1><p>${LONG_TEXT}</p></main>`;
    expect(isRenderReady(document, "unknown-portal")).toBe(true);
  });

  it("never throws on a missing/invalid doc", () => {
    expect(isRenderReady(undefined as unknown as Document, "aliseda")).toBe(false);
    expect(isRenderReady({} as unknown as Document, "aliseda")).toBe(false);
  });
});

describe("createCaptureGuard — fire exactly once per URL", () => {
  const KEY = "alisedainmobiliaria.com/inmueble/ANT1";

  it("claims a key exactly once", () => {
    const g = createCaptureGuard();
    expect(g.claim(KEY)).toBe(true);
    expect(g.claim(KEY)).toBe(false); // already in-flight
    expect(g.isInflight(KEY)).toBe(true);
  });

  it("stays claimed after settle (never re-fires a captured listing)", () => {
    const g = createCaptureGuard();
    g.claim(KEY);
    g.settle(KEY);
    expect(g.isDone(KEY)).toBe(true);
    expect(g.claim(KEY)).toBe(false);
  });

  it("release (failed capture) allows a later retry", () => {
    const g = createCaptureGuard();
    g.claim(KEY);
    g.release(KEY);
    expect(g.isDone(KEY)).toBe(false);
    expect(g.claim(KEY)).toBe(true); // retryable
  });

  it("treats different URLs as independent keys", () => {
    const g = createCaptureGuard();
    const a = "alisedainmobiliaria.com/inmueble/ANT1";
    const b = "idealista.com/inmueble/106387165";
    expect(g.claim(a)).toBe(true);
    expect(g.claim(b)).toBe(true);
  });

  it("never claims an empty key", () => {
    const g = createCaptureGuard();
    expect(g.claim("")).toBe(false);
  });
});

// ── Batch capture: listing-page detection (issue #262) ──────────────────────

describe("listingPortalForUrl — only search/results pages", () => {
  const CASES: [string, string | null][] = [
    // Idealista search/results pages → listing.
    ["https://www.idealista.com/venta-viviendas/madrid-madrid/", "idealista"],
    ["https://www.idealista.com/alquiler-viviendas/barcelona-barcelona/", "idealista"],
    ["https://www.idealista.com/venta-locales/valencia/", "idealista"],
    ["https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_200000/", "idealista"],
    // Idealista detail / home / bare → not a listing.
    ["https://www.idealista.com/inmueble/106387165/", null],
    ["https://www.idealista.com/", null],
    // Aliseda results route → listing.
    ["https://www.alisedainmobiliaria.com/comprar/vivienda/malaga", "aliseda"],
    ["https://www.alisedainmobiliaria.com/alquilar/vivienda/madrid", "aliseda"],
    // The REAL Aliseda search URL (owner-confirmed #296/#318): path root is
    // `/comprar-viviendas/`, NOT `/comprar/…`. The old `/^\/(comprar|alquilar)\//`
    // regex required a slash right after "comprar" and never matched these, so
    // Aliseda listing pages were invisible. These MUST classify as listing now.
    [
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?hab=2",
      "aliseda",
    ],
    ["https://www.alisedainmobiliaria.com/alquiler-viviendas/pisos/madrid", "aliseda"],
    ["https://www.alisedainmobiliaria.com/comprar", "aliseda"],
    // Aliseda detail / home → not a listing (detail root is `/inmueble/…`, a
    // different path root, so it never collides with the listing gate).
    ["https://www.alisedainmobiliaria.com/inmueble/ANT1", null],
    ["https://www.alisedainmobiliaria.com/", null],
    // Altamira search/results route (issue #271) → listing.
    ["https://www.altamirainmuebles.com/venta-viviendas/cualquier-provincia", "altamira"],
    ["https://www.altamirainmuebles.com/venta-viviendas/pontevedra", "altamira"],
    ["https://www.altamirainmuebles.com/alquiler-viviendas/madrid", "altamira"],
    // Altamira detail / home → not a listing (a `-de-` detail URL never matches).
    [
      "https://www.altamirainmuebles.com/venta-de-atico/pontevedra/sanxenxo/segunda-mano/9186_1001_PE0001/375859/1",
      null,
    ],
    ["https://www.altamirainmuebles.com/", null],
    // Hipoges search/results routes (D-111) → listing. Grounded in the site's
    // own public Angular route table: /<lang>/(sale|rent)/<typology>/<country>
    // /<town> or the area/countries/map/point variants.
    ["https://realestate.hipoges.com/es/sale/flat/spain/madrid", "hipoges"],
    ["https://realestate.hipoges.com/es/rent/house/spain/malaga/features", "hipoges"],
    ["https://realestate.hipoges.com/es/area/sale/flat/spain", "hipoges"],
    ["https://realestate.hipoges.com/es/countries/sale/flat/spain", "hipoges"],
    ["https://realestate.hipoges.com/es/map/sale/flat/spain/madrid", "hipoges"],
    ["https://realestate.hipoges.com/es/point/sale/flat/spain/10", "hipoges"],
    // Hipoges detail / home → not a listing.
    ["https://realestate.hipoges.com/es/detail/12345", null],
    ["https://realestate.hipoges.com/", null],
    // Unsupported host / non-http / junk → null.
    ["https://www.fotocasa.es/es/comprar/viviendas/madrid/", null],
    ["ftp://www.idealista.com/venta-viviendas/x/", null],
    ["not a url", null],
  ];

  it.each(CASES)("%s → %s", (url, expected) => {
    expect(listingPortalForUrl(url)).toBe(expected);
  });

  it("isListingUrl agrees with listingPortalForUrl", () => {
    expect(isListingUrl("https://www.idealista.com/venta-viviendas/madrid-madrid/")).toBe(true);
    expect(isListingUrl("https://www.idealista.com/inmueble/1/")).toBe(false);
  });

  it("a URL is never simultaneously a detail and a listing page", () => {
    for (const [url] of CASES) {
      if (isDetailUrl(url) || isListingUrl(url)) {
        expect(isDetailUrl(url) && isListingUrl(url)).toBe(false);
      }
    }
  });
});

describe("supportedPortalForUrl — capture portal by host, any page role (#237)", () => {
  const CASES: [string, string | null][] = [
    // Any page on a supported portal host resolves (home, detail, search, deep).
    ["https://www.idealista.com/", "idealista"],
    ["https://www.idealista.com/inmueble/106387165/", "idealista"],
    ["https://www.idealista.com/venta-viviendas/madrid-madrid/", "idealista"],
    ["https://idealista.com/mi-cuenta/favoritos", "idealista"],
    ["https://www.alisedainmobiliaria.com/", "aliseda"],
    ["https://www.altamirainmuebles.com/cualquier-pagina", "altamira"],
    ["https://realestate.hipoges.com/", "hipoges"],
    ["https://realestate.hipoges.com/es/detail/12345", "hipoges"],
    // Unsupported hosts and non-http(s) → null (popup keeps its manual escape hatch).
    ["https://www.fotocasa.es/", null],
    ["https://inmuebles.cimenta2.com/inmuebles/s/", null],
    ["ftp://www.idealista.com/", null],
    ["not a url", null],
    ["", null],
  ];

  it.each(CASES)("%s → %s", (url, expected) => {
    expect(supportedPortalForUrl(url)).toBe(expected);
  });
});

describe("pageRoleForUrl — detail / listing / other / null routing (#237)", () => {
  const CASES: [string, "detail" | "listing" | "other" | null][] = [
    // Detail pages.
    ["https://www.idealista.com/inmueble/106387165/", "detail"],
    ["https://www.alisedainmobiliaria.com/inmueble/ANT1", "detail"],
    [
      "https://www.altamirainmuebles.com/venta-de-atico/pontevedra/sanxenxo/segunda-mano/9186_1001_PE0001/375859/1",
      "detail",
    ],
    ["https://realestate.hipoges.com/es/detail/12345", "detail"],
    ["https://realestate.hipoges.com/es/npl/detail/12345/unavailable", "detail"],
    // Listing/search pages.
    ["https://www.idealista.com/venta-viviendas/madrid-madrid/", "listing"],
    ["https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga", "listing"],
    ["https://www.altamirainmuebles.com/venta-viviendas/pontevedra", "listing"],
    ["https://realestate.hipoges.com/es/sale/flat/spain/madrid", "listing"],
    // Supported portal, but a page we can't capture → "other" (guidance shown).
    ["https://www.idealista.com/", "other"],
    ["https://idealista.com/mi-cuenta/favoritos", "other"],
    ["https://www.alisedainmobiliaria.com/", "other"],
    ["https://www.altamirainmuebles.com/", "other"],
    ["https://realestate.hipoges.com/", "other"],
    ["https://realestate.hipoges.com/es", "other"],
    // Unsupported host / non-http → null (no portal at all).
    ["https://www.fotocasa.es/", null],
    ["https://inmuebles.cimenta2.com/", null],
    ["ftp://www.idealista.com/venta-viviendas/x/", null],
    ["not a url", null],
  ];

  it.each(CASES)("%s → %s", (url, expected) => {
    expect(pageRoleForUrl(url)).toBe(expected);
  });

  it("role agrees with the detail/listing/supported predicates", () => {
    for (const [url, expected] of CASES) {
      const role = pageRoleForUrl(url);
      expect(role).toBe(expected);
      if (role === "detail") expect(isDetailUrl(url)).toBe(true);
      if (role === "listing") expect(isListingUrl(url)).toBe(true);
      if (role === "other") {
        expect(isDetailUrl(url)).toBe(false);
        expect(isListingUrl(url)).toBe(false);
        expect(supportedPortalForUrl(url)).not.toBeNull();
      }
      if (role === null) expect(supportedPortalForUrl(url)).toBeNull();
    }
  });
});

describe("extractDetailUrls — harvest detail links off a listing DOM", () => {
  it("keeps only detail URLs, de-duplicated by canonical match key", () => {
    const hrefs = [
      "https://www.idealista.com/inmueble/106387165/", // detail
      "https://www.idealista.com/inmueble/106387165/?utm=x", // dup of the above (query dropped)
      "https://www.idealista.com/inmueble/222/#photos", // detail, distinct
      "https://www.idealista.com/venta-viviendas/madrid-madrid/", // listing page → excluded
      "https://www.idealista.com/", // home → excluded
      "https://www.idealista.com/agente/123/", // non-detail → excluded
    ];
    expect(extractDetailUrls(hrefs)).toEqual([
      "https://www.idealista.com/inmueble/106387165/",
      "https://www.idealista.com/inmueble/222/#photos",
    ]);
  });

  it("harvests /inmueble/<id> detail links off a REAL Aliseda search page (#318)", () => {
    // The page at /comprar-viviendas/pisos/andalucia/malaga links each result
    // card to an /inmueble/<slug> detail page. Now that the search page is
    // recognised as a listing, these links must be extractable and scoped to
    // Aliseda (the search page's own URL is excluded — it isn't a detail URL).
    const searchUrl =
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga";
    const hrefs = [
      searchUrl, // the listing page itself → excluded
      "https://www.alisedainmobiliaria.com/inmueble/ANT1",
      "https://www.alisedainmobiliaria.com/inmueble/ANT1?utm=x", // dup by match key
      "https://www.alisedainmobiliaria.com/inmueble/piso-malaga-2222",
      "https://www.alisedainmobiliaria.com/favoritos", // non-detail → excluded
    ];
    expect(extractDetailUrls(hrefs, "aliseda")).toEqual([
      "https://www.alisedainmobiliaria.com/inmueble/ANT1",
      "https://www.alisedainmobiliaria.com/inmueble/piso-malaga-2222",
    ]);
    // And the search page classifies as listing (not detail) — mutually exclusive.
    expect(isListingUrl(searchUrl)).toBe(true);
    expect(isDetailUrl(searchUrl)).toBe(false);
  });

  it("scopes to a single portal when one is given", () => {
    const hrefs = [
      "https://www.idealista.com/inmueble/1/",
      "https://www.alisedainmobiliaria.com/inmueble/ANT1",
    ];
    expect(extractDetailUrls(hrefs, "aliseda")).toEqual([
      "https://www.alisedainmobiliaria.com/inmueble/ANT1",
    ]);
  });

  it("tolerates junk entries and a non-array input", () => {
    expect(
      extractDetailUrls(["https://www.idealista.com/inmueble/1/", "", null, 5, "not a url"]),
    ).toEqual(["https://www.idealista.com/inmueble/1/"]);
    expect(extractDetailUrls(undefined)).toEqual([]);
    expect(extractDetailUrls(null)).toEqual([]);
  });
});

// ── Results-page pagination (issue #362) ────────────────────────────────────

describe("currentResultsPage — read the page number off a results URL", () => {
  const CASES: [string, number][] = [
    // Idealista path-htm scheme.
    ["https://www.idealista.com/venta-viviendas/madrid-madrid/", 1],
    ["https://www.idealista.com/venta-viviendas/madrid-madrid/pagina-2.htm", 2],
    ["https://www.idealista.com/venta-viviendas/madrid-madrid/pagina-13.htm", 13],
    // Query-param scheme (aliseda/altamira best-effort + generic DOM read).
    ["https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga", 1],
    ["https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga?pagina=3", 3],
    ["https://www.altamirainmuebles.com/venta-viviendas/madrid?page=4", 4],
    ["https://www.altamirainmuebles.com/venta-viviendas/madrid?pag=5", 5],
    // Unparseable → page 1.
    ["not a url", 1],
    ["", 1],
  ];
  it.each(CASES)("%s → page %d", (url, expected) => {
    expect(currentResultsPage(url)).toBe(expected);
  });
});

describe("resultsPageUrl / nextResultsUrl — derive page-N and next-page URLs", () => {
  it("idealista: appends /pagina-N.htm for N≥2, canonical for page 1 (1→2→3)", () => {
    const base = "https://www.idealista.com/venta-viviendas/madrid-madrid/";
    const p2 = resultsPageUrl(base, 2);
    expect(p2).toBe(
      "https://www.idealista.com/venta-viviendas/madrid-madrid/pagina-2.htm",
    );
    // 2 → 3 derives from the page-2 URL.
    expect(nextResultsUrl(p2!)).toBe(
      "https://www.idealista.com/venta-viviendas/madrid-madrid/pagina-3.htm",
    );
    // 1 → 2 via nextResultsUrl on the canonical page-1 URL.
    expect(nextResultsUrl(base)).toBe(p2);
    // Page 1 strips any existing pagina segment back to the canonical URL.
    expect(resultsPageUrl(p2!, 1)).toBe(base);
  });

  it("idealista /areas/: paginates WITHOUT .htm (issue: page-2 404 on polygon searches)", () => {
    // A drawn-polygon search. Writing `/pagina-2.htm` here returns idealista's
    // "no corresponde a ninguna pagina" error even when page 2 exists; the form
    // the site itself links to is extensionless. Verified by hand against a live
    // search that HAS a page 2, so this is not a "there is no page 2" artefact.
    const base =
      "https://www.idealista.com/areas/venta-viviendas/con-precio-desde_80000,precio-hasta_250000/?shape=%28%28abc%29%29";
    const p2 = resultsPageUrl(base, 2);
    expect(p2).toBe(
      "https://www.idealista.com/areas/venta-viviendas/con-precio-desde_80000,precio-hasta_250000/pagina-2?shape=%28%28abc%29%29",
    );
    // The shape query is what makes it a polygon search — it must ride along
    // byte-for-byte, or the page-2 URL silently becomes a different search.
    expect(p2).toContain("?shape=%28%28abc%29%29");
    // 2 -> 3 keeps the extensionless form.
    expect(nextResultsUrl(p2!)).toContain("/pagina-3?shape=");
    expect(nextResultsUrl(p2!)).not.toContain(".htm");
    // Page 1 strips the extensionless segment back to the canonical URL.
    expect(resultsPageUrl(p2!, 1)).toBe(base);
    // And the page number is readable back off the extensionless form, so the
    // enumeration walk's didn't-advance guard doesn't stall on page 1.
    expect(currentResultsPage(p2!)).toBe(2);
  });

  it("idealista: the .htm form still applies outside /areas/ (no regression)", () => {
    expect(
      resultsPageUrl("https://www.idealista.com/venta-viviendas/sevilla-sevilla/", 2),
    ).toBe("https://www.idealista.com/venta-viviendas/sevilla-sevilla/pagina-2.htm");
  });

  it("idealista: normalises a missing trailing slash before the pagina segment", () => {
    expect(
      resultsPageUrl("https://www.idealista.com/venta-viviendas/madrid-madrid", 2),
    ).toBe("https://www.idealista.com/venta-viviendas/madrid-madrid/pagina-2.htm");
  });

  it("idealista: preserves the query string and hash", () => {
    expect(
      resultsPageUrl(
        "https://www.idealista.com/venta-viviendas/madrid-madrid/?ordenado-por=precio-asc#map",
        2,
      ),
    ).toBe(
      "https://www.idealista.com/venta-viviendas/madrid-madrid/pagina-2.htm?ordenado-por=precio-asc#map",
    );
  });

  it("aliseda/altamira: query-param scheme sets ?pagina=N (dropped on page 1)", () => {
    const base = "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga";
    expect(resultsPageUrl(base, 2)).toBe(base + "?pagina=2");
    expect(nextResultsUrl(base + "?pagina=2")).toBe(base + "?pagina=3");
    // Page 1 removes the param.
    expect(resultsPageUrl(base + "?pagina=2", 1)).toBe(base);
    expect(
      resultsPageUrl("https://www.altamirainmuebles.com/venta-viviendas/madrid", 2),
    ).toBe("https://www.altamirainmuebles.com/venta-viviendas/madrid?pagina=2");
  });

  it("returns null for an unsupported portal, a bad URL, or n<1", () => {
    expect(resultsPageUrl("https://www.fotocasa.es/lista/", 2)).toBeNull();
    expect(resultsPageUrl("not a url", 2)).toBeNull();
    expect(resultsPageUrl("https://www.idealista.com/venta-viviendas/x/", 0)).toBeNull();
    expect(nextResultsUrl("https://www.fotocasa.es/lista/")).toBeNull();
  });

  it("RESULTS_PAGE_CAP is a sane bounded cap", () => {
    expect(typeof RESULTS_PAGE_CAP).toBe("number");
    expect(RESULTS_PAGE_CAP).toBeGreaterThan(1);
    expect(RESULTS_PAGE_CAP).toBeLessThanOrEqual(100);
  });
});

describe("toListingUrl — map-view → listing-view normalisation (#506)", () => {
  // Owner-confirmed empirical pair: the ONLY change is removing the
  // `/mapa-google` segment; the trailing slash before `?` stays and the
  // URL-encoded `shape` value is preserved character-for-character.
  const MAP =
    "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_210000/mapa-google?shape=%28%28ep%7DbFxcjc%40ajAojCaPsoBriByJf%60Buf%40nj%40qUb%7E%40xg%40%7Cs%40xh%40%7CJps%40kH%7CpCsu%40vXwqA%3FuiBnFy%5CxJ%29%29";
  const LISTING =
    "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_210000/?shape=%28%28ep%7DbFxcjc%40ajAojCaPsoBriByJf%60Buf%40nj%40qUb%7E%40xg%40%7Cs%40xh%40%7CJps%40kH%7CpCsu%40vXwqA%3FuiBnFy%5CxJ%29%29";

  it("converts the owner-confirmed map URL to the listing URL byte-for-byte", () => {
    expect(toListingUrl(MAP)).toBe(LISTING);
  });

  it("preserves the encoded shape value character-for-character (no decode/re-encode)", () => {
    const shape = new URL(toListingUrl(MAP)).search;
    expect(shape).toBe(
      "?shape=%28%28ep%7DbFxcjc%40ajAojCaPsoBriByJf%60Buf%40nj%40qUb%7E%40xg%40%7Cs%40xh%40%7CJps%40kH%7CpCsu%40vXwqA%3FuiBnFy%5CxJ%29%29",
    );
  });

  it("is idempotent (a second pass is a no-op)", () => {
    expect(toListingUrl(toListingUrl(MAP))).toBe(LISTING);
  });

  it("is a no-op for a URL that is already a listing path", () => {
    expect(toListingUrl(LISTING)).toBe(LISTING);
    const plain = "https://www.idealista.com/venta-viviendas/madrid-madrid/";
    expect(toListingUrl(plain)).toBe(plain);
  });

  it("preserves a raw (un-encoded) shape query and appended params", () => {
    expect(
      toListingUrl(
        "https://www.idealista.com/areas/venta-viviendas/x/mapa-google?shape=((ku_bF|xg@}@|@))&ordenado-por=precios-asc",
      ),
    ).toBe(
      "https://www.idealista.com/areas/venta-viviendas/x/?shape=((ku_bF|xg@}@|@))&ordenado-por=precios-asc",
    );
  });

  it("preserves the hash", () => {
    expect(
      toListingUrl(
        "https://www.idealista.com/areas/venta-viviendas/x/mapa-google?shape=((a))#foo",
      ),
    ).toBe("https://www.idealista.com/areas/venta-viviendas/x/?shape=((a))#foo");
  });

  it("is a no-op for other portals (aliseda/altamira) even if the path contains mapa-google", () => {
    const aliseda =
      "https://www.alisedainmobiliaria.com/comprar-viviendas/mapa-google?x=1";
    expect(toListingUrl(aliseda)).toBe(aliseda);
    const altamira =
      "https://www.altamirainmuebles.com/venta-viviendas/mapa-google";
    expect(toListingUrl(altamira)).toBe(altamira);
  });

  it("is a no-op for an unsupported portal or unparseable input", () => {
    const fotocasa = "https://www.fotocasa.es/mapa-google?x=1";
    expect(toListingUrl(fotocasa)).toBe(fotocasa);
    expect(toListingUrl("not a url")).toBe("not a url");
  });

  it("only strips a WHOLE segment, never a mapa-google substring", () => {
    const inner =
      "https://www.idealista.com/areas/venta-viviendas/mapa-google-x/mapa-google?shape=((a))";
    expect(toListingUrl(inner)).toBe(
      "https://www.idealista.com/areas/venta-viviendas/mapa-google-x/?shape=((a))",
    );
  });

  it("after normalisation, page 2 is a valid listing URL (pagination fix)", () => {
    const listing = toListingUrl(MAP);
    expect(resultsPageUrl(listing, 2)).toBe(
      "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_210000/pagina-2?shape=%28%28ep%7DbFxcjc%40ajAojCaPsoBriByJf%60Buf%40nj%40qUb%7E%40xg%40%7Cs%40xh%40%7CJps%40kH%7CpCsu%40vXwqA%3FuiBnFy%5CxJ%29%29",
    );
  });

  it("resultsPageUrl is itself defensive: a map URL never yields /mapa-google/pagina-2", () => {
    const p2 = resultsPageUrl(MAP, 2)!;
    expect(p2).not.toContain("/mapa-google/pagina-2");
    expect(p2).toContain(
      "/areas/venta-viviendas/con-precio-hasta_210000/pagina-2",
    );
    // Under /areas/ the segment carries no .htm — that form 404s on the live site.
    expect(p2).not.toContain(".htm");
  });
});

describe("nextResultsUrlFromHrefs — the rendered-DOM 'siguiente' fallback", () => {
  it("picks the anchor pointing at current page + 1, scoped to the portal", () => {
    const current = "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga";
    const hrefs = [
      "https://www.alisedainmobiliaria.com/inmueble/ANT1", // detail, not a page link
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga?pagina=2", // next
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga?pagina=3", // page 3
      "https://www.idealista.com/venta-viviendas/x/pagina-2.htm", // other portal
    ];
    expect(nextResultsUrlFromHrefs(hrefs, current, "aliseda")).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga?pagina=2",
    );
  });

  it("advances from page 2 to the page-3 anchor", () => {
    const current =
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga?pagina=2";
    const hrefs = [
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga?pagina=3",
    ];
    expect(nextResultsUrlFromHrefs(hrefs, current, "aliseda")).toBe(hrefs[0]);
  });

  it("returns null when no next-page anchor is present (last page / infinite scroll)", () => {
    const current = "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga";
    expect(
      nextResultsUrlFromHrefs(
        ["https://www.alisedainmobiliaria.com/inmueble/ANT1"],
        current,
        "aliseda",
      ),
    ).toBeNull();
    expect(nextResultsUrlFromHrefs(null, current, "aliseda")).toBeNull();
    expect(nextResultsUrlFromHrefs(undefined, current, "aliseda")).toBeNull();
  });
});

// ── Batch auto-start signal + in-page banner (issue #297) ───────────────────

describe("captureSignalPresent — the app's #inmo-capture auto-start signal", () => {
  it("true for the fragment form", () => {
    expect(
      captureSignalPresent("https://www.idealista.com/venta-viviendas/estepona/#inmo-capture"),
    ).toBe(true);
  });

  it("true for the query-key fallback form", () => {
    expect(
      captureSignalPresent("https://www.idealista.com/venta-viviendas/estepona/?inmo-capture=1"),
    ).toBe(true);
    expect(
      captureSignalPresent("https://www.idealista.com/venta-viviendas/estepona/?x=1&inmo-capture"),
    ).toBe(true);
  });

  it("false without the signal, and for junk URLs", () => {
    expect(captureSignalPresent("https://www.idealista.com/venta-viviendas/estepona/")).toBe(false);
    expect(captureSignalPresent("https://www.idealista.com/venta-viviendas/estepona/#gallery")).toBe(
      false,
    );
    expect(captureSignalPresent("not a url")).toBe(false);
    expect(captureSignalPresent("")).toBe(false);
  });
});

describe("stripCaptureSignal — clean the URL before capture-to-infer learning (#303)", () => {
  it("removes the fragment form", () => {
    expect(
      stripCaptureSignal("https://www.idealista.com/venta-viviendas/estepona/#inmo-capture"),
    ).toBe("https://www.idealista.com/venta-viviendas/estepona/");
  });

  it("removes the query-key form, preserving other params", () => {
    expect(
      stripCaptureSignal("https://www.idealista.com/venta-viviendas/estepona/?a=1&inmo-capture=1"),
    ).toBe("https://www.idealista.com/venta-viviendas/estepona/?a=1");
  });

  it("leaves a URL without the signal (and junk) untouched", () => {
    const clean = "https://www.idealista.com/venta-viviendas/estepona/";
    expect(stripCaptureSignal(clean)).toBe(clean);
    expect(stripCaptureSignal("not a url")).toBe("not a url");
  });
});

// ── Validation-mode signal (issue #478 P3) ──────────────────────────────────

describe("validateSignalPayload — parse #inmo-validate=<pid>:<connector>", () => {
  const BASE = "https://www.idealista.com/venta-viviendas/sevilla-sevilla/";

  it("parses the fragment form into { profileId, connector }", () => {
    expect(validateSignalPayload(`${BASE}#inmo-validate=42:idealista`)).toEqual({
      profileId: 42,
      connector: "idealista",
    });
  });

  it("parses the query-key form (percent-decoded colon)", () => {
    expect(validateSignalPayload(`${BASE}?inmo-validate=7%3Aaliseda`)).toEqual({
      profileId: 7,
      connector: "aliseda",
    });
  });

  it("keeps a connector name that itself contains a colon (splits on the first)", () => {
    expect(validateSignalPayload(`${BASE}#inmo-validate=1:a:b`)).toEqual({
      profileId: 1,
      connector: "a:b",
    });
  });

  it("returns null for a missing / malformed payload", () => {
    expect(validateSignalPayload(BASE)).toBeNull(); // no signal
    expect(validateSignalPayload(`${BASE}#inmo-validate=`)).toBeNull(); // empty
    expect(validateSignalPayload(`${BASE}#inmo-validate=idealista`)).toBeNull(); // no id
    expect(validateSignalPayload(`${BASE}#inmo-validate=0:idealista`)).toBeNull(); // id not > 0
    expect(validateSignalPayload(`${BASE}#inmo-validate=1:`)).toBeNull(); // empty connector
    expect(validateSignalPayload(`${BASE}#inmo-validate=x:idealista`)).toBeNull(); // non-numeric id
    expect(validateSignalPayload("not a url")).toBeNull();
  });

  it("validateSignalPresent mirrors payload presence", () => {
    expect(validateSignalPresent(`${BASE}#inmo-validate=1:idealista`)).toBe(true);
    expect(validateSignalPresent(BASE)).toBe(false);
    expect(validateSignalPresent("")).toBe(false);
  });
});

describe("stripValidateSignal — never persist the validation signal", () => {
  const BASE = "https://www.idealista.com/venta-viviendas/sevilla-sevilla/";

  it("removes the fragment form", () => {
    expect(stripValidateSignal(`${BASE}#inmo-validate=42:idealista`)).toBe(BASE);
  });

  it("removes the query-key form, preserving other params", () => {
    expect(stripValidateSignal(`${BASE}?a=1&inmo-validate=7%3Aaliseda`)).toBe(`${BASE}?a=1`);
  });

  it("leaves a URL without the signal (and junk) untouched", () => {
    expect(stripValidateSignal(BASE)).toBe(BASE);
    expect(stripValidateSignal("not a url")).toBe("not a url");
  });
});

describe("inValidationMode — the pure 'stay suppressed?' verdict", () => {
  const BASE = "https://www.idealista.com/venta-viviendas/sevilla-sevilla/";

  it("true when the URL still carries the signal (first load)", () => {
    expect(inValidationMode(`${BASE}#inmo-validate=1:idealista`, false)).toBe(true);
  });

  it("true when the background flagged the tab (fragment already stripped)", () => {
    expect(inValidationMode(BASE, true)).toBe(true);
  });

  it("false when neither the URL nor the background says so", () => {
    expect(inValidationMode(BASE, false)).toBe(false);
  });

  it("false for a bad payload with no active flag", () => {
    expect(inValidationMode(`${BASE}#inmo-validate=0:idealista`, false)).toBe(false);
  });
});

describe("buildValidationSavePayload — shape the 'Usar esta URL como filtro' body", () => {
  const BASE = "https://www.idealista.com/venta-viviendas/sevilla-sevilla/";

  it("combines state with the signal-stripped tab URL and source='extension'", () => {
    const out = buildValidationSavePayload(
      { profileId: 42, connector: "idealista" },
      `${BASE}#inmo-validate=42:idealista`,
    );
    expect(out).toEqual({
      profileId: 42,
      connector: "idealista",
      url: BASE, // stripped — the signal is never persisted
      source: "extension",
    });
  });

  it("keeps a tuned URL (e.g. shape=) verbatim, minus only the signal", () => {
    const tuned = "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28abc%29%29";
    const out = buildValidationSavePayload({ profileId: 5, connector: "idealista" }, tuned);
    expect(out!.url).toBe(tuned);
  });

  it("returns null for a bad state or a non-http(s) URL", () => {
    expect(buildValidationSavePayload(null, BASE)).toBeNull();
    expect(buildValidationSavePayload({ connector: "idealista" }, BASE)).toBeNull(); // no id
    expect(buildValidationSavePayload({ profileId: 0, connector: "idealista" }, BASE)).toBeNull();
    expect(buildValidationSavePayload({ profileId: 1, connector: "" }, BASE)).toBeNull();
    expect(
      buildValidationSavePayload({ profileId: 1, connector: "idealista" }, "javascript:alert(1)"),
    ).toBeNull();
    expect(buildValidationSavePayload({ profileId: 1, connector: "idealista" }, "nope")).toBeNull();
  });
});

describe("listingCaptureAction — what the content script should do", () => {
  const LISTING = "https://www.idealista.com/venta-viviendas/estepona-malaga/";
  const URLS = ["https://www.idealista.com/inmueble/1/", "https://www.idealista.com/inmueble/2/"];

  it("auto-starts on a listing page carrying the signal (≥1 detail URL)", () => {
    const v = listingCaptureAction(`${LISTING}#inmo-capture`, URLS);
    expect(v).toEqual({ action: "autostart", portal: "idealista", count: 2 });
  });

  it("shows the banner on a listing page WITHOUT the signal (no auto-start)", () => {
    const v = listingCaptureAction(LISTING, URLS);
    expect(v).toEqual({ action: "banner", portal: "idealista", count: 2 });
  });

  it("does nothing on a non-listing page even with the signal", () => {
    expect(listingCaptureAction(`https://www.idealista.com/inmueble/1/#inmo-capture`, URLS)).toEqual({
      action: "none",
    });
  });

  it("does nothing on a NON-map listing page with zero harvested detail URLs", () => {
    // Card-view listing with no map segment: toListingUrl is a no-op → none.
    expect(listingCaptureAction(`${LISTING}#inmo-capture`, [])).toEqual({ action: "none" });
    expect(listingCaptureAction(LISTING, undefined)).toEqual({ action: "none" });
  });

  it("#529: converts a map-view search (zero anchors) to the listing form", () => {
    const MAP =
      "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_700000/mapa-google?shape=%28%28abc%29%29";
    const v = listingCaptureAction(MAP, []);
    expect(v.action).toBe("convert");
    expect(v.portal).toBe("idealista");
    expect(v.listingUrl).not.toContain("/mapa-google");
    // shape= query preserved byte-for-byte between the map and listing forms.
    expect(new URL(v.listingUrl!).search).toBe(new URL(MAP).search);
  });

  it("#529: convert survives the capture signal on the map URL (hash rides along)", () => {
    const MAP =
      "https://www.idealista.com/areas/venta-viviendas/mapa-google?shape=%28%28abc%29%29#inmo-capture";
    const v = listingCaptureAction(MAP, []);
    expect(v.action).toBe("convert");
    expect(v.listingUrl).toContain("#inmo-capture");
  });
});

describe("withCaptureSignal — tag a URL for extension auto-start (#529)", () => {
  it("adds the #inmo-capture fragment when the URL has none", () => {
    expect(withCaptureSignal("https://www.idealista.com/areas/venta-viviendas/?shape=x")).toBe(
      "https://www.idealista.com/areas/venta-viviendas/?shape=x#inmo-capture",
    );
  });

  it("is idempotent (already-tagged URL unchanged)", () => {
    const tagged = "https://www.idealista.com/areas/venta-viviendas/?shape=x#inmo-capture";
    expect(withCaptureSignal(tagged)).toBe(tagged);
  });

  it("falls back to the ?inmo-capture query when a foreign fragment is present", () => {
    const out = withCaptureSignal("https://www.idealista.com/areas/venta-viviendas/?shape=x#foo");
    expect(out).toContain("inmo-capture=1");
    expect(out).toContain("#foo");
  });

  it("returns an unparseable URL untouched", () => {
    expect(withCaptureSignal("not a url")).toBe("not a url");
  });
});

describe("buildCaptureBanner — the in-page manual fallback", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a branded, dismissible banner naming the property count", () => {
    const el = buildCaptureBanner(document, { count: 7 });
    expect(el).not.toBeNull();
    document.body.appendChild(el as HTMLElement);
    const banner = document.getElementById("inmo-capture-banner");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("data-inmo-banner")).toBe("1");
    expect(banner?.textContent).toContain("Inmo-Tool");
    expect(banner?.textContent).toContain("7 propiedades");
    // Fixed + max z-index so it can't be confused with / hidden behind site UI.
    expect(banner?.style.position).toBe("fixed");
    expect(banner?.style.zIndex).toBe("2147483647");
    expect(document.querySelector("[data-inmo-banner-start]")).not.toBeNull();
    expect(document.querySelector("[data-inmo-banner-dismiss]")).not.toBeNull();
  });

  it("wires the capture button to onCapture and the × to onDismiss", () => {
    let captured = 0;
    let dismissed = 0;
    const el = buildCaptureBanner(document, {
      count: 3,
      onCapture: () => (captured += 1),
      onDismiss: () => (dismissed += 1),
    });
    document.body.appendChild(el as HTMLElement);
    (document.querySelector("[data-inmo-banner-start]") as HTMLButtonElement).click();
    (document.querySelector("[data-inmo-banner-dismiss]") as HTMLButtonElement).click();
    expect(captured).toBe(1);
    expect(dismissed).toBe(1);
  });

  it("returns null for a missing document rather than throwing", () => {
    expect(buildCaptureBanner(undefined as unknown as Document, { count: 1 })).toBeNull();
  });
});
