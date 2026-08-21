// @vitest-environment jsdom
/**
 * Unit tests for browser-extension/detect.js's block/challenge detection
 * (issue #634, self.InmoDetect.detectBlockSignals). Imports the REAL
 * extension module — not a copy — same pattern as extension-detect.test.ts.
 *
 * Hardened per a fresh-context review (B1) that ran its OWN adversarial
 * fixtures against the real function and found FOUR healthy pages reading as
 * blocked (a Turnstile widget on a contact form, an Incapsula anti-bot tag on
 * an ordinary 200, listing copy merely mentioning a challenge phrase, a
 * contact widget using id="captcha-box") plus TWO genuine blocks reading as
 * healthy (a login/session wall, a Spanish "Acceso denegado" WAF page). The
 * fix (detect.js) is CORROBORATION: a marker only counts once
 * `!isRenderReady(doc, portal)` — a genuine interstitial never renders real
 * content, so a healthy page that happens to embed/mention a marker is
 * excluded. This file's false-positive section below specifically covers the
 * "healthy page that contains a plausible marker" case the original version
 * of this file didn't (its fixtures carried no markers at all, so they
 * couldn't have caught B1 — see git history for the pre-fix version and the
 * review that found it).
 *
 * Every fixture is synthesized/reduced — skeleton markup only, never a saved
 * real portal page (public repo, no scraped listing content) — except the
 * GeeTest true positive, which reuses the REAL trimmed capture already
 * committed at etl/tests/fixtures/milanuncios_sample_soft_block_page.html
 * (issue #179/#628) rather than a synthetic stand-in.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as mod from "../../browser-extension/detect.js";

const D = (mod as unknown as { default?: Record<string, unknown> }).default ?? mod;
const { detectBlockSignals } = D as {
  detectBlockSignals: (
    doc: Document,
    portal?: string | null,
  ) => { blocked: boolean; signature: string | null };
};

const FIXTURES_DIR = path.resolve(process.cwd(), "../etl/tests/fixtures/");

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
});

// A real listing page's worth of content — long enough to satisfy
// isRenderReady's MIN_BODY_TEXT (400 chars) under an <h1>, so a marker
// planted alongside it must NOT be corroborated as a block.
const REAL_LISTING_HTML = `
  <main>
    <h1>Piso en venta en Antequera</h1>
    <p>
      Bonito piso de 3 habitaciones y 2 baños, 90 m2 construidos, segunda
      mano en buen estado general. Cocina independiente equipada, salón
      luminoso con terraza orientada al sur, calefacción central y
      carpintería exterior de aluminio con doble acristalamiento. Cerca del
      centro histórico, a 5 minutos andando del colegio y con parada de
      autobús justo enfrente del portal. Ascensor, trastero y plaza de
      garaje opcional incluidos en el precio. Comunidad de vecinos con
      cuota reducida. Ideal para primera vivienda o inversión en alquiler
      dada la alta demanda de la zona. Se aceptan visitas concertadas de
      lunes a sábado. Referencia del anuncio: AB-1234. Precio 120.000 EUR,
      negociable según condiciones de financiación del comprador.
    </p>
  </main>
`;

function loadRealListingWithMarker(markerHtml: string): void {
  document.title = "Piso en venta en Antequera | idealista";
  document.body.innerHTML = REAL_LISTING_HTML + markerHtml;
}

describe("detectBlockSignals — real challenge markers (issue #634)", () => {
  it("Cloudflare 'Just a moment...' interstitial (weak title fallback, no real content)", () => {
    document.title = "Just a moment...";
    document.body.innerHTML = "<div>Enable JavaScript and cookies to continue</div>";
    expect(detectBlockSignals(document, "idealista")).toEqual({
      blocked: true,
      signature: "cloudflare_challenge",
    });
  });

  it("Cloudflare interstitial via the language-independent challenge-platform script path (review B1's Spanish-title gap)", () => {
    // A LOCALISED Cloudflare interstitial: no English title at all, but the
    // real JS-challenge orchestration script is always present regardless of
    // language — this is the language-independent signal review B1 asked
    // for, distinct from the Turnstile WIDGET path tested as a false
    // positive below.
    document.title = "Espere un momento...";
    document.body.innerHTML =
      "<script src=\"https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=abc\"></script>";
    expect(detectBlockSignals(document, "idealista")).toEqual({
      blocked: true,
      signature: "cloudflare_challenge",
    });
  });

  it("Cloudflare interstitial (widget-id marker, no matching title)", () => {
    document.title = "idealista.com";
    document.body.innerHTML = '<div id="cf-chl-widget"></div>';
    expect(detectBlockSignals(document, "idealista")).toEqual({
      blocked: true,
      signature: "cloudflare_challenge",
    });
  });

  it("DataDome/captcha-delivery wall — idealista's documented CAPTCHA (docs/skills/connectors.md)", () => {
    document.body.innerHTML =
      '<script src="https://geo.captcha-delivery.com/captcha/?initialCid=abc"></script>';
    expect(detectBlockSignals(document, "idealista")).toEqual({
      blocked: true,
      signature: "captcha_wall",
    });
  });

  it("GeeTest 'Pardon Our Interruption' wall — the REAL captured milanuncios sample (issue #179/#628)", () => {
    const html = readFileSync(
      path.join(FIXTURES_DIR, "milanuncios_sample_soft_block_page.html"),
      "utf-8",
    );
    const headMatch = html.match(/<head>([\s\S]*)<\/head>/);
    const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
    expect(headMatch).not.toBeNull();
    expect(bodyMatch).not.toBeNull();
    document.head.innerHTML = headMatch![1];
    document.body.innerHTML = bodyMatch![1];
    // Not a page any of this extension's own portals serve, but detection is
    // portal-agnostic — pass a real portal to exercise the corroboration
    // path against its readySelectors like any live call would.
    expect(detectBlockSignals(document, "aliseda")).toEqual({
      blocked: true,
      signature: "geetest_challenge",
    });
  });

  it("Incapsula edge-WAF challenge (D-026's Sareb signature — generic, could reappear on any portal)", () => {
    document.body.innerHTML =
      '<script src="/_Incapsula_Resource?SWJIYLWA=abc"></script>';
    expect(detectBlockSignals(document, "idealista")).toEqual({
      blocked: true,
      signature: "incapsula_challenge",
    });
  });

  it("Akamai static deny (D-027's Altamira signature — title + Reference #)", () => {
    document.title = "Access Denied";
    document.body.innerHTML =
      "<h1>Access Denied</h1><p>You don't have permission to access this resource.</p>" +
      "<p>Reference #18.abc123.1234567890.abcdef1</p>";
    expect(detectBlockSignals(document, "altamira")).toEqual({
      blocked: true,
      signature: "akamai_deny",
    });
  });

  it("a title-only 'Access Denied' page (no Reference #) misses the narrow akamai_deny check but still matches the broader corroborated waf_denied signal", () => {
    // akamai_deny itself stays narrow (title + a Reference # id — Altamira's
    // exact static-deny template); the generic waf_denied signal (review B1)
    // is what catches a bare "Access Denied" title on a page with no real
    // rendered content — corroboration (not the Reference # requirement) is
    // what keeps this safe: a genuinely healthy page titled "Access Denied"
    // by coincidence would still render real content and be excluded (see
    // the "healthy page with a plausible marker" section below).
    document.title = "Access Denied";
    document.body.innerHTML = "<h1>Some unrelated page</h1>";
    expect(detectBlockSignals(document, "altamira")).toEqual({
      blocked: true,
      signature: "waf_denied",
    });
  });

  it("a generic Spanish WAF 403 page ('Acceso denegado') — the issue's own WAF-403 example (review B1)", () => {
    document.title = "403 — Acceso denegado";
    document.body.innerHTML = "<h1>Acceso denegado</h1><p>No tienes permiso para acceder.</p>";
    expect(detectBlockSignals(document, "aliseda")).toEqual({
      blocked: true,
      signature: "waf_denied",
    });
  });

  it("an English 'Access Denied ... Forbidden' WAF page also matches waf_denied", () => {
    document.title = "403 Forbidden";
    document.body.innerHTML = "<h1>Access Denied</h1><p>You are not authorized.</p>";
    expect(detectBlockSignals(document, "hipoges")).toEqual({
      blocked: true,
      signature: "waf_denied",
    });
  });

  it("a login/session-verification wall — the issue's own third 'blocked' example (review B1)", () => {
    document.title = "Inicia sesión";
    document.body.innerHTML =
      "<h1>Tu sesión ha caducado</h1>" +
      "<form><input type='email'/><input type='password'/><button>Iniciar sesión</button></form>";
    expect(detectBlockSignals(document, "idealista")).toEqual({
      blocked: true,
      signature: "session_wall",
    });
  });

  it("a password field ALONE (no session-wall copy nearby) does not match session_wall — avoids a real login/contact page with a password field", () => {
    document.body.innerHTML = "<form><input type='password'/><button>Enviar</button></form>";
    expect(detectBlockSignals(document, "idealista")).toEqual({ blocked: false, signature: null });
  });
});

describe("detectBlockSignals — a HEALTHY page that contains a plausible marker must NOT block (review B1)", () => {
  it("a Turnstile WIDGET (not the challenge-platform script) embedded in a contact form on a real listing page", () => {
    loadRealListingWithMarker(
      '<form id="contact"><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></form>',
    );
    expect(detectBlockSignals(document, "idealista")).toEqual({ blocked: false, signature: null });
  });

  it("an Incapsula anti-bot tag injected into an ordinary 200 response alongside real listing content", () => {
    loadRealListingWithMarker(
      '<script src="/_Incapsula_Resource?SWJIYLWA=defensive-tag"></script>',
    );
    expect(detectBlockSignals(document, "aliseda")).toEqual({ blocked: false, signature: null });
  });

  it("a GeeTest widget (#captcha-box) used by a real contact form on a real listing page", () => {
    loadRealListingWithMarker('<div id="captcha-box" class="contact-widget"></div>');
    expect(detectBlockSignals(document, "idealista")).toEqual({ blocked: false, signature: null });
  });

  it("listing copy that merely MENTIONS the GeeTest phrase does not block a genuinely rendered page", () => {
    document.title = "Piso en venta en Antequera | idealista";
    document.body.innerHTML =
      '<main><h1>Piso en venta en Antequera</h1><p>' +
      REAL_LISTING_HTML.replace(/<\/?main>|<h1>.*<\/h1>/g, "") +
      " El vendedor comenta que tras una reforma reciente su web mostraba " +
      '"Pardon Our Interruption" antes de arreglarlo, pero el piso está ' +
      "listo para entrar a vivir.</p></main>";
    expect(detectBlockSignals(document, "idealista")).toEqual({ blocked: false, signature: null });
  });

  it("a DataDome script defensively loaded on an ordinary rendered listing page", () => {
    loadRealListingWithMarker(
      '<script src="https://geo.captcha-delivery.com/tags.js"></script>',
    );
    expect(detectBlockSignals(document, "idealista")).toEqual({ blocked: false, signature: null });
  });

  it("a real listing page whose OWN <h1> happens to say 'acceso denegado' (a coincidental heading, not a WAF page) does not match waf_denied", () => {
    // waf_denied scans only the title + <h1> text (not the whole body) —
    // planting the phrase there specifically, on a page that otherwise
    // renders full real content below, is what actually exercises the
    // corroboration path (a body-text-only mention, as in the sibling test
    // above, never reaches this signature's matcher at all).
    document.title = "Piso en venta en Antequera | idealista";
    document.body.innerHTML =
      "<main><h1>Aviso: acceso denegado a la zona de piscina sin adulto</h1>" +
      REAL_LISTING_HTML.replace(/<\/?main>|<h1>.*<\/h1>/g, "") +
      "</main>";
    expect(detectBlockSignals(document, "idealista")).toEqual({ blocked: false, signature: null });
  });
});

describe("detectBlockSignals — false positives (the cases that matter most)", () => {
  it("a genuinely empty search-results page never blocks", () => {
    document.title = "Pisos en venta en Antequera | idealista";
    document.body.innerHTML =
      '<main><h1>0 anuncios encontrados</h1><p>No hay resultados para tu búsqueda. ' +
      "Prueba a ampliar los filtros.</p></main>";
    expect(detectBlockSignals(document, "idealista")).toEqual({ blocked: false, signature: null });
  });

  it("a 404 / removed-listing page never blocks", () => {
    document.title = "Página no encontrada | idealista";
    document.body.innerHTML =
      "<main><h1>Este anuncio ya no está disponible</h1>" +
      "<p>El anuncio que buscas ha sido eliminado o ha caducado.</p></main>";
    expect(detectBlockSignals(document, "idealista")).toEqual({ blocked: false, signature: null });
  });

  it("a normal, fully-rendered detail page never blocks", () => {
    loadRealListingWithMarker("");
    expect(detectBlockSignals(document, "idealista")).toEqual({ blocked: false, signature: null });
  });

  it("an empty SPA shell (not yet rendered) is unrecognised, not a block", () => {
    document.body.innerHTML = '<div id="app"></div>';
    expect(detectBlockSignals(document, "aliseda")).toEqual({ blocked: false, signature: null });
  });

  it("a null/missing document never blocks", () => {
    expect(detectBlockSignals(null as unknown as Document, "idealista")).toEqual({
      blocked: false,
      signature: null,
    });
  });

  it("a document with no querySelector (malformed input) degrades to unblocked rather than throwing", () => {
    expect(() => detectBlockSignals({} as unknown as Document, "idealista")).not.toThrow();
    expect(detectBlockSignals({} as unknown as Document, "idealista")).toEqual({
      blocked: false,
      signature: null,
    });
  });
});
