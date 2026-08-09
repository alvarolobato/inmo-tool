// @vitest-environment node
/**
 * Unit tests for the browser-extension's pure "Capturar URL de búsqueda"
 * helpers (issue #475, part of #471; generalized to all capture portals in
 * #510). Imports the REAL extension module (browser-extension/capture-search-url.js)
 * — not a copy — so the shipped host-validation + payload-shaping logic is what's
 * under test.
 *
 * The chrome.* messaging + fetch wiring (popup.js / background.js) is not
 * unit-testable in-process; this file covers the pure pieces #475/#510 call out:
 * which-capture-portal-is-this-URL (host-only, path-agnostic) and the URL/host
 * extraction into the capture payload.
 */

import { describe, it, expect } from "vitest";
import * as mod from "../../browser-extension/capture-search-url.js";

// capture-search-url.js publishes via `module.exports = api`; vite's CJS interop
// may expose it as the default export or spread the named keys — accept either.
const S = (mod as unknown as { default?: Record<string, unknown> }).default ?? mod;
const { capturePortalForUrl, isCaptureSearchUrl, buildSearchUrlCapture, hostForUrl } =
  S as {
    capturePortalForUrl: (u: string) => string | null;
    isCaptureSearchUrl: (u: string) => boolean;
    hostForUrl: (u: string) => string | null;
    buildSearchUrlCapture: (
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

// A drawn-zone results URL: "Dibuja tu zona" encodes the polygon into `shape=`.
const SHAPE_URL =
  "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28abc123%29%29";

describe("capturePortalForUrl / isCaptureSearchUrl", () => {
  it("accepts all three capture portals + subdomains (www stripped)", () => {
    expect(capturePortalForUrl("https://www.idealista.com/venta-viviendas/")).toBe("idealista");
    expect(capturePortalForUrl("http://m.idealista.com/x")).toBe("idealista");
    expect(capturePortalForUrl(SHAPE_URL)).toBe("idealista");
    expect(capturePortalForUrl("https://www.alisedainmobiliaria.com/comprar-viviendas/")).toBe("aliseda");
    expect(capturePortalForUrl("https://alisedainmobiliaria.com/inmueble/ANT1")).toBe("aliseda");
    expect(capturePortalForUrl("https://www.altamirainmuebles.com/venta-viviendas/")).toBe("altamira");
    expect(capturePortalForUrl("https://www.altamirainmuebles.com/")).toBe("altamira");
    // Capture is path-agnostic: even a detail/home page on a supported portal is
    // capturable (the owner decides what's worth keeping).
    expect(isCaptureSearchUrl("https://www.idealista.com/inmueble/106387165/")).toBe(true);
  });

  it("rejects unrelated hosts", () => {
    expect(capturePortalForUrl("https://example.com/x")).toBeNull();
    expect(isCaptureSearchUrl("https://example.com/x")).toBe(false);
  });

  it("rejects a look-alike host that only contains a portal domain", () => {
    expect(capturePortalForUrl("https://idealista.com.evil.example/x")).toBeNull();
    expect(capturePortalForUrl("https://notidealista.com/x")).toBeNull();
  });

  it("rejects non-http(s) schemes even with a portal-looking host", () => {
    expect(capturePortalForUrl("javascript://idealista.com/x")).toBeNull();
    expect(capturePortalForUrl("data:text/html,idealista.com")).toBeNull();
  });

  it("rejects malformed / empty input", () => {
    expect(capturePortalForUrl("")).toBeNull();
    expect(capturePortalForUrl("not a url")).toBeNull();
    expect(capturePortalForUrl(undefined as unknown as string)).toBeNull();
  });
});

describe("hostForUrl", () => {
  it("normalises the host (lowercase, www stripped) for http(s)", () => {
    expect(hostForUrl("https://WWW.Idealista.com/x")).toBe("idealista.com");
    expect(hostForUrl("https://m.idealista.com/x")).toBe("m.idealista.com");
  });

  it("returns null for a non-http(s) or malformed URL", () => {
    expect(hostForUrl("javascript://idealista.com/x")).toBeNull();
    expect(hostForUrl("nope")).toBeNull();
  });
});

describe("buildSearchUrlCapture", () => {
  it("shapes the payload for a valid portal URL, keeping the URL verbatim", () => {
    const now = new Date("2026-08-08T10:00:00.000Z");
    const out = buildSearchUrlCapture({ url: SHAPE_URL, title: "  Zona  " }, now);
    expect(out).toEqual({
      url: SHAPE_URL, // verbatim — shape= preserved
      title: "Zona", // trimmed
      host: "idealista.com", // www stripped
      portal: "idealista", // derived from host
      capturedAt: "2026-08-08T10:00:00.000Z",
    });
  });

  it("derives the portal for aliseda + altamira captures", () => {
    expect(buildSearchUrlCapture({ url: "https://www.alisedainmobiliaria.com/comprar" })?.portal).toBe("aliseda");
    expect(buildSearchUrlCapture({ url: "https://www.altamirainmuebles.com/x" })?.portal).toBe("altamira");
  });

  it("trims surrounding whitespace on the URL before validating", () => {
    const out = buildSearchUrlCapture({ url: `  ${SHAPE_URL}  ` });
    expect(out).not.toBeNull();
    expect(out!.url).toBe(SHAPE_URL);
  });

  it("defaults title to an empty string when absent", () => {
    const out = buildSearchUrlCapture({ url: SHAPE_URL });
    expect(out!.title).toBe("");
  });

  it("returns null for a non-portal or invalid URL", () => {
    expect(buildSearchUrlCapture({ url: "https://example.com/x" })).toBeNull();
    expect(buildSearchUrlCapture({ url: "javascript://idealista.com/x" })).toBeNull();
    expect(buildSearchUrlCapture({})).toBeNull();
  });
});
