// @vitest-environment jsdom
/**
 * Unit tests for browser-extension/diagnostic.js's pure
 * buildDiagnosticBlock (issue #671, "forzar captura + diagnóstico"). Imports
 * the REAL extension modules (detect.js + diagnostic.js) — not copies — same
 * pattern as extension-detect.test.ts / extension-block-detect.test.ts.
 *
 * Covers the exit-criterion page classes: a supported DETAIL page, a
 * supported RESULTS/listing page, an UNSUPPORTED host, and a
 * BLOCKED/challenge page — every one must return a full diagnostic block
 * without throwing (the "an unclassifiable page must still be sendable"
 * requirement). Also proves the single-shared-computation requirement: the
 * `renderReady` field is whatever D.isRenderReadyDetail says, byte for byte —
 * never re-derived.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as detectMod from "../../browser-extension/detect.js";
import * as diagMod from "../../browser-extension/diagnostic.js";

const D = (detectMod as unknown as { default?: Record<string, unknown> }).default ?? detectMod;
const Diag = (diagMod as unknown as { default?: Record<string, unknown> }).default ?? diagMod;

interface RenderReadyDetail {
  ready: boolean;
  selector: string | null;
  reason: string | null;
  bodyTextLength: number;
}

interface DiagnosticBlock {
  url: string;
  timestamp: string;
  extensionVersion: string | null;
  detection: {
    detailPortal: string | null;
    listingPortal: string | null;
    supportedPortal: string | null;
    pageRole: string | null;
  };
  renderReady: RenderReadyDetail;
  harvest: { anchorCount: number; extractDetailUrlsCount: number; pendingPlaceholders: number };
  block: { blocked: boolean; signature: string | null };
  mode: { discoverSignalPresent: boolean; validationActive: boolean; autoCaptureEnabled: boolean };
  autoCaptureWouldFire: boolean;
}

const buildDiagnosticBlock = (Diag as unknown as {
  buildDiagnosticBlock: (
    detect: unknown,
    doc: Document,
    url: string,
    opts?: Record<string, unknown>,
  ) => DiagnosticBlock;
}).buildDiagnosticBlock;

const isRenderReadyDetail = (D as unknown as {
  isRenderReadyDetail: (doc: Document, portal: string | null) => RenderReadyDetail;
}).isRenderReadyDetail;

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
});

// Long enough to clear MIN_BODY_TEXT (400 chars) under a real heading.
const REAL_LISTING_HTML = `
  <main>
    <h1 class="main-info__title-main">Piso en venta en Antequera</h1>
    <div class="info-data-price">120.000 EUR</div>
    <p>
      Bonito piso de 3 habitaciones y 2 baños, 90 m2 construidos, segunda
      mano en buen estado general. Cocina independiente equipada, salón
      luminoso con terraza orientada al sur, calefacción central y
      carpintería exterior de aluminio con doble acristalamiento. Cerca del
      centro histórico, a 5 minutos andando del colegio y con parada de
      autobús justo enfrente del portal. Ascensor, trastero y plaza de
      garaje opcional incluidos en el precio. Comunidad de vecinos con
      cuota reducida. Ideal para primera vivienda o inversión en alquiler
      dada la alta demanda de la zona. Referencia del anuncio: AB-1234.
    </p>
  </main>
`;

describe("buildDiagnosticBlock — supported DETAIL page (idealista)", () => {
  it("reports detailPortal, a real isRenderReady selector, and autoCaptureWouldFire true", () => {
    document.title = "Piso en venta en Antequera | idealista";
    document.body.innerHTML = REAL_LISTING_HTML;
    const url = "https://www.idealista.com/inmueble/106387165/";

    const block = buildDiagnosticBlock(D, document, url, {
      hrefs: [],
      extensionVersion: "0.16.0",
      autoCaptureEnabled: true,
      validationActive: false,
    });

    expect(block.detection.detailPortal).toBe("idealista");
    expect(block.detection.pageRole).toBe("detail");
    expect(block.renderReady.ready).toBe(true);
    expect(block.renderReady.selector).toBe("h1.main-info__title-main");
    expect(block.block.blocked).toBe(false);
    expect(block.mode.discoverSignalPresent).toBe(false);
    expect(block.mode.validationActive).toBe(false);
    expect(block.autoCaptureWouldFire).toBe(true);
  });

  it("the reported renderReady is EXACTLY D.isRenderReadyDetail's own output — not re-derived", () => {
    document.title = "Piso en venta en Antequera | idealista";
    document.body.innerHTML = REAL_LISTING_HTML;
    const url = "https://www.idealista.com/inmueble/106387165/";

    const expected = isRenderReadyDetail(document, "idealista");
    const block = buildDiagnosticBlock(D, document, url, { hrefs: [] });

    expect(block.renderReady).toEqual(expected);
  });

  it("autoCaptureWouldFire is false when validation mode is active, even though the page renders fine", () => {
    document.title = "Piso en venta en Antequera | idealista";
    document.body.innerHTML = REAL_LISTING_HTML;
    const url = "https://www.idealista.com/inmueble/106387165/";

    const block = buildDiagnosticBlock(D, document, url, {
      hrefs: [],
      autoCaptureEnabled: true,
      validationActive: true,
    });

    expect(block.renderReady.ready).toBe(true);
    expect(block.autoCaptureWouldFire).toBe(false);
  });

  it("autoCaptureWouldFire is false when the owner's autoCaptureEnabled setting is off", () => {
    document.title = "Piso en venta en Antequera | idealista";
    document.body.innerHTML = REAL_LISTING_HTML;
    const url = "https://www.idealista.com/inmueble/106387165/";

    const block = buildDiagnosticBlock(D, document, url, {
      hrefs: [],
      autoCaptureEnabled: false,
    });

    expect(block.autoCaptureWouldFire).toBe(false);
  });
});

describe("buildDiagnosticBlock — supported RESULTS/listing page", () => {
  it("reports listingPortal + pageRole 'listing', and autoCaptureWouldFire is always false (only detail pages auto-capture)", () => {
    document.title = "Pisos en venta en Málaga | idealista";
    document.body.innerHTML = REAL_LISTING_HTML;
    const url = "https://www.idealista.com/venta-viviendas/malaga-malaga/";
    const hrefs = [
      "https://www.idealista.com/inmueble/111/",
      "https://www.idealista.com/inmueble/222/",
      "https://www.idealista.com/inmueble/111/", // duplicate — extractDetailUrls dedupes
    ];

    const block = buildDiagnosticBlock(D, document, url, { hrefs });

    expect(block.detection.listingPortal).toBe("idealista");
    expect(block.detection.pageRole).toBe("listing");
    expect(block.harvest.anchorCount).toBe(3);
    expect(block.harvest.extractDetailUrlsCount).toBe(2);
    expect(block.autoCaptureWouldFire).toBe(false);
  });

  it("Hipoges class of bug (issue #671's own motivating case, repaired in #701): an Angular shell with enough boilerplate text to have satisfied the OLD generic 'main' selector, but zero real detail links — the diagnostic now reports it as un-rendered", () => {
    document.title = "Hipoges";
    // This fixture IS the bug #671 was built to expose: `main` is present with
    // enough padding text to clear MIN_BODY_TEXT (400 chars), and there isn't
    // a single advert on the page. Until #701 that combination reported
    // ready=true via the generic fallback, which is how an empty shell got
    // captured as an advert (production rows 3614-3617, 3 of 26 fields).
    // Hipoges' detail readiness is now pinned to the advert's own component
    // elements, so the shell is correctly rejected — and the diagnostic says
    // WHY (`no_key_node`) rather than claiming the page had rendered.
    document.body.innerHTML = `
      <nav id="init-front-list">Hipoges navigation shell placeholder</nav>
      <main>
        <p>${"Cargando resultados… ".repeat(30)}</p>
      </main>
    `;
    const url = "https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/dos-hermanas_sevilla";
    const hrefs = ["https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/otra-ciudad"];

    const block = buildDiagnosticBlock(D, document, url, { hrefs });

    expect(block.detection.listingPortal).toBe("hipoges");
    // The field the issue exists for still carries the whole story at a
    // glance — only now it tells the truth about the shell.
    expect(block.renderReady.ready).toBe(false);
    expect(block.renderReady.selector).toBeNull();
    expect(block.renderReady.reason).toBe("no_key_node");
    expect(block.renderReady.bodyTextLength).toBeGreaterThan(400);
    // …and the harvest found NOTHING, which on this page is the correct
    // answer: there is no advert on it at all.
    expect(block.harvest.extractDetailUrlsCount).toBe(0);
    // Nothing is loading either — this shell is not a page mid-render.
    expect(block.harvest.pendingPlaceholders).toBe(0);
  });
});

describe("buildDiagnosticBlock — unsupported host", () => {
  it("degrades every detection field to null/false and still returns a full block (never throws)", () => {
    document.title = "Some other real-estate site";
    document.body.innerHTML = "<main><h1>Listado</h1><p>contenido</p></main>";
    const url = "https://www.some-unsupported-portal.example/anuncio/1";

    const block = buildDiagnosticBlock(D, document, url, { hrefs: [] });

    expect(block.detection.detailPortal).toBeNull();
    expect(block.detection.listingPortal).toBeNull();
    expect(block.detection.supportedPortal).toBeNull();
    expect(block.detection.pageRole).toBeNull();
    expect(block.autoCaptureWouldFire).toBe(false);
    // isRenderReady still runs, via the generic DEFAULT_READY_SELECTORS.
    expect(typeof block.renderReady.ready).toBe("boolean");
  });

  it("a malformed URL never throws — degrades to a block with null detection", () => {
    const block = buildDiagnosticBlock(D, document, "not a url at all", { hrefs: [] });
    expect(block.detection.detailPortal).toBeNull();
    expect(block.autoCaptureWouldFire).toBe(false);
  });
});

describe("buildDiagnosticBlock — a challenge/blocked page", () => {
  it("reports block.blocked=true + the signature, still without throwing", () => {
    document.title = "Just a moment...";
    document.body.innerHTML = "<div>Enable JavaScript and cookies to continue</div>";
    const url = "https://www.idealista.com/inmueble/106387165/";

    const block = buildDiagnosticBlock(D, document, url, { hrefs: [] });

    expect(block.block.blocked).toBe(true);
    expect(block.block.signature).toBe("cloudflare_challenge");
    // Not rendered — auto-capture would never fire on a challenge page.
    expect(block.renderReady.ready).toBe(false);
    expect(block.autoCaptureWouldFire).toBe(false);
  });
});
