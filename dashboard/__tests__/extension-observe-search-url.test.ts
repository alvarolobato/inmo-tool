// @vitest-environment node
/**
 * Unit tests for the browser-extension's pure PASSIVE observer helpers
 * (issue #488, part of #471; generalized to all capture portals in #510).
 * Imports the REAL extension module (browser-extension/observe-search-url.js) —
 * not a copy — so the shipped host-validation, observable-page detection,
 * normalization and payload-shaping logic is what's under test.
 *
 * The chrome.* messaging + fetch wiring (content-script.js / background.js) is
 * not unit-testable in-process; this file covers the pure pieces #488/#510 call
 * out: is-this-an-observable-search-URL (per portal), the de-dup normalization,
 * and the observe payload shape. The observable verdicts are driven by the
 * fixture shared with the server mirror so the two can never drift.
 */

import { describe, it, expect } from "vitest";
import * as mod from "../../browser-extension/observe-search-url.js";
import { OBSERVABLE_CASES } from "./fixtures/search-url-observable";

// observe-search-url.js publishes via `module.exports = api`; vite's CJS interop
// may expose it as the default export or spread the named keys — accept either.
const O = (mod as unknown as { default?: Record<string, unknown> }).default ?? mod;
const {
  isObservableSearchUrl,
  observablePortalForUrl,
  normalizeObservedUrl,
  buildObservedCapture,
} = O as {
  isObservableSearchUrl: (u: string) => boolean;
  observablePortalForUrl: (u: string) => string | null;
  normalizeObservedUrl: (u: string) => string | null;
  buildObservedCapture: (
    input: { url?: string; title?: string },
    now?: Date,
  ) => {
    url: string;
    title: string;
    host: string;
    portal: string;
    capturedAt: string;
  } | null;
};

const LISTADO = "https://www.idealista.com/venta-viviendas/estepona-malaga/";
const AREAS_SHAPE =
  "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28abc123%29%29";
const ALISEDA = "https://www.alisedainmobiliaria.com/comprar-viviendas/malaga";
const ALTAMIRA = "https://www.altamirainmuebles.com/venta-viviendas/pontevedra/";

describe("observablePortalForUrl / isObservableSearchUrl (shared fixture)", () => {
  for (const c of OBSERVABLE_CASES) {
    it(`${c.desc} → ${c.portal ?? "null"}`, () => {
      expect(observablePortalForUrl(c.url)).toBe(c.portal);
      expect(isObservableSearchUrl(c.url)).toBe(c.portal !== null);
    });
  }

  it("rejects malformed / undefined input", () => {
    expect(isObservableSearchUrl(undefined as unknown as string)).toBe(false);
  });
});

describe("normalizeObservedUrl", () => {
  it("collapses www, trailing slash and query-param order to one key", () => {
    const a = normalizeObservedUrl("https://www.idealista.com/venta-viviendas/malaga/?b=2&a=1");
    const b = normalizeObservedUrl("https://idealista.com/venta-viviendas/malaga?a=1&b=2#frag");
    expect(a).toBe("idealista.com/venta-viviendas/malaga?a=1&b=2");
    expect(a).toBe(b);
  });

  it("keeps shape= in the key so distinct drawn zones stay distinct", () => {
    const one = normalizeObservedUrl("https://www.idealista.com/areas/venta-viviendas/?shape=AAA");
    const two = normalizeObservedUrl("https://www.idealista.com/areas/venta-viviendas/?shape=BBB");
    expect(one).not.toBe(two);
    expect(one).toContain("shape=AAA");
  });

  it("normalizes aliseda + altamira hosts too (host gate, not the search-page gate)", () => {
    expect(normalizeObservedUrl(ALISEDA)).toBe(
      "alisedainmobiliaria.com/comprar-viviendas/malaga",
    );
    expect(normalizeObservedUrl(ALTAMIRA)).toBe(
      "altamirainmuebles.com/venta-viviendas/pontevedra",
    );
  });

  it("returns a key for a parseable portal host even if not observable, null otherwise", () => {
    expect(normalizeObservedUrl("https://www.idealista.com/")).toBe("idealista.com");
    expect(normalizeObservedUrl("https://example.com/x")).toBeNull();
    expect(normalizeObservedUrl("not a url")).toBeNull();
  });
});

describe("buildObservedCapture", () => {
  it("shapes the payload for an observable idealista URL, keeping it verbatim", () => {
    const now = new Date("2026-08-08T10:00:00.000Z");
    const out = buildObservedCapture({ url: AREAS_SHAPE, title: "  Zona  " }, now);
    expect(out).toEqual({
      url: AREAS_SHAPE, // verbatim — shape= preserved
      title: "Zona", // trimmed
      host: "idealista.com", // www stripped
      portal: "idealista", // derived from host
      capturedAt: "2026-08-08T10:00:00.000Z",
    });
  });

  it("shapes the payload for aliseda + altamira observable URLs", () => {
    expect(buildObservedCapture({ url: ALISEDA })?.portal).toBe("aliseda");
    expect(buildObservedCapture({ url: ALTAMIRA })?.portal).toBe("altamira");
  });

  it("trims whitespace around the URL before validating", () => {
    const out = buildObservedCapture({ url: `  ${LISTADO}  ` });
    expect(out).not.toBeNull();
    expect(out!.url).toBe(LISTADO);
  });

  it("returns null for a non-observable / invalid URL", () => {
    expect(buildObservedCapture({ url: "https://www.idealista.com/" })).toBeNull();
    expect(buildObservedCapture({ url: "https://example.com/x" })).toBeNull();
    expect(buildObservedCapture({})).toBeNull();
  });
});
