// @vitest-environment jsdom
/**
 * Unit tests for browser-extension/detect.js's block/challenge detection
 * (issue #634, self.InmoDetect.detectBlockSignals). Imports the REAL
 * extension module — not a copy — same pattern as extension-detect.test.ts.
 *
 * The false-positive cases (a genuinely empty search page, a 404/removed
 * listing page) are the ones that matter most per the issue: without them,
 * the alert is worse than nothing. Every fixture here is synthesized —
 * skeleton markup only, never a saved real portal page (public repo, no
 * scraped listing content).
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as mod from "../../browser-extension/detect.js";

const D = (mod as unknown as { default?: Record<string, unknown> }).default ?? mod;
const { detectBlockSignals } = D as {
  detectBlockSignals: (doc: Document) => { blocked: boolean; signature: string | null };
};

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
});

describe("detectBlockSignals — real challenge markers (issue #634)", () => {
  it("Cloudflare 'Just a moment...' interstitial (title match)", () => {
    document.title = "Just a moment...";
    document.body.innerHTML = "<div>Enable JavaScript and cookies to continue</div>";
    expect(detectBlockSignals(document)).toEqual({
      blocked: true,
      signature: "cloudflare_challenge",
    });
  });

  it("Cloudflare interstitial (widget marker, no matching title)", () => {
    document.title = "idealista.com";
    document.body.innerHTML = '<div id="cf-chl-widget"></div>';
    expect(detectBlockSignals(document)).toEqual({
      blocked: true,
      signature: "cloudflare_challenge",
    });
  });

  it("DataDome/captcha-delivery wall — idealista's documented CAPTCHA (docs/skills/connectors.md)", () => {
    document.body.innerHTML =
      '<script src="https://geo.captcha-delivery.com/captcha/?initialCid=abc"></script>';
    expect(detectBlockSignals(document)).toEqual({
      blocked: true,
      signature: "captcha_wall",
    });
  });

  it("GeeTest 'Pardon Our Interruption' wall — hit live during #628 (docs/skills/connectors.md)", () => {
    document.body.innerHTML = "<h1>Pardon Our Interruption</h1><div id=\"captcha-box\"></div>";
    expect(detectBlockSignals(document)).toEqual({
      blocked: true,
      signature: "geetest_challenge",
    });
  });

  it("Incapsula edge-WAF challenge (D-026's Sareb signature — generic, could reappear on any portal)", () => {
    document.body.innerHTML =
      '<script src="/_Incapsula_Resource?SWJIYLWA=abc"></script>';
    expect(detectBlockSignals(document)).toEqual({
      blocked: true,
      signature: "incapsula_challenge",
    });
  });

  it("Akamai static deny (D-027's Altamira signature — title + Reference #)", () => {
    document.title = "Access Denied";
    document.body.innerHTML =
      "<h1>Access Denied</h1><p>You don't have permission to access this resource.</p>" +
      "<p>Reference #18.abc123.1234567890.abcdef1</p>";
    expect(detectBlockSignals(document)).toEqual({
      blocked: true,
      signature: "akamai_deny",
    });
  });

  it("Akamai deny title alone (no Reference #) does NOT match — avoids a coincidental page titled 'Access Denied'", () => {
    document.title = "Access Denied";
    document.body.innerHTML = "<h1>Some unrelated page</h1>";
    expect(detectBlockSignals(document)).toEqual({ blocked: false, signature: null });
  });

  it("a document with no querySelector (malformed input) degrades to unblocked rather than throwing", () => {
    expect(() => detectBlockSignals({} as unknown as Document)).not.toThrow();
    expect(detectBlockSignals({} as unknown as Document)).toEqual({
      blocked: false,
      signature: null,
    });
  });
});

describe("detectBlockSignals — false positives (the cases that matter most)", () => {
  it("a genuinely empty search-results page never blocks", () => {
    document.title = "Pisos en venta en Antequera | idealista";
    document.body.innerHTML =
      '<main><h1>0 anuncios encontrados</h1><p>No hay resultados para tu búsqueda. ' +
      "Prueba a ampliar los filtros.</p></main>";
    expect(detectBlockSignals(document)).toEqual({ blocked: false, signature: null });
  });

  it("a 404 / removed-listing page never blocks", () => {
    document.title = "Página no encontrada | idealista";
    document.body.innerHTML =
      "<main><h1>Este anuncio ya no está disponible</h1>" +
      "<p>El anuncio que buscas ha sido eliminado o ha caducado.</p></main>";
    expect(detectBlockSignals(document)).toEqual({ blocked: false, signature: null });
  });

  it("a normal, fully-rendered detail page never blocks", () => {
    document.title = "Piso en venta en Antequera | idealista";
    document.body.innerHTML =
      "<main><h1>Piso en venta en Antequera</h1>" +
      "<p>Bonito piso de 3 habitaciones, 90 m2, segunda mano en buen estado. " +
      "Cerca del centro, con ascensor y trastero. Precio 120.000 EUR.</p></main>";
    expect(detectBlockSignals(document)).toEqual({ blocked: false, signature: null });
  });

  it("an empty SPA shell (not yet rendered) is unrecognised, not a block", () => {
    document.body.innerHTML = '<div id="app"></div>';
    expect(detectBlockSignals(document)).toEqual({ blocked: false, signature: null });
  });

  it("a null/missing document never blocks", () => {
    expect(detectBlockSignals(null as unknown as Document)).toEqual({
      blocked: false,
      signature: null,
    });
  });
});
