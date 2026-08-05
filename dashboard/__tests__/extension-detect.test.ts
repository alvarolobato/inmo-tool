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
  extractDetailUrls,
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
  extractDetailUrls: (hrefs: unknown, portal?: string) => string[];
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
    // Aliseda detail / home → not a listing.
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
