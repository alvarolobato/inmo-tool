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
  stripCaptureSignal,
  listingCaptureAction,
  buildCaptureBanner,
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
  stripCaptureSignal: (u: string) => string;
  listingCaptureAction: (
    u: string,
    detailUrls: unknown,
  ) => { action: "none" | "autostart" | "banner"; portal?: string; count?: number };
  buildCaptureBanner: (
    doc: Document,
    opts: { count?: number; onCapture?: () => void; onDismiss?: () => void },
  ) => HTMLElement | null;
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
    // Unsupported host → null even on a detail-shaped path.
    ["https://www.fotocasa.es/inmueble/123/", null],
    ["https://example.com/inmueble/123/", null],
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
    // Listing/search pages.
    ["https://www.idealista.com/venta-viviendas/madrid-madrid/", "listing"],
    ["https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/malaga", "listing"],
    ["https://www.altamirainmuebles.com/venta-viviendas/pontevedra", "listing"],
    // Supported portal, but a page we can't capture → "other" (guidance shown).
    ["https://www.idealista.com/", "other"],
    ["https://idealista.com/mi-cuenta/favoritos", "other"],
    ["https://www.alisedainmobiliaria.com/", "other"],
    ["https://www.altamirainmuebles.com/", "other"],
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

  it("does nothing on a listing page with zero harvested detail URLs", () => {
    expect(listingCaptureAction(`${LISTING}#inmo-capture`, [])).toEqual({ action: "none" });
    expect(listingCaptureAction(LISTING, undefined)).toEqual({ action: "none" });
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
