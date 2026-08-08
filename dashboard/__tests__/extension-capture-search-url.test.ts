// @vitest-environment node
/**
 * Unit tests for the browser-extension's pure "Capturar URL de búsqueda"
 * helpers (issue #475, part of #471). Imports the REAL extension module
 * (browser-extension/capture-search-url.js) — not a copy — so the shipped
 * host-validation + payload-shaping logic is what's under test.
 *
 * The chrome.* messaging + fetch wiring (popup.js / background.js) is not
 * unit-testable in-process; this file covers the two pure pieces #475 calls out:
 * is-this-an-idealista-URL and the URL/host extraction into the capture payload.
 */

import { describe, it, expect } from "vitest";
import * as mod from "../../browser-extension/capture-search-url.js";

// capture-search-url.js publishes via `module.exports = api`; vite's CJS interop
// may expose it as the default export or spread the named keys — accept either.
const S = (mod as unknown as { default?: Record<string, unknown> }).default ?? mod;
const { isIdealistaUrl, buildSearchUrlCapture, hostForUrl } = S as {
  isIdealistaUrl: (u: string) => boolean;
  hostForUrl: (u: string) => string | null;
  buildSearchUrlCapture: (
    input: { url?: string; title?: string },
    now?: Date,
  ) => { url: string; title: string; host: string; capturedAt: string } | null;
};

// A drawn-zone results URL: "Dibuja tu zona" encodes the polygon into `shape=`.
const SHAPE_URL =
  "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28abc123%29%29";

describe("isIdealistaUrl", () => {
  it("accepts idealista.com and its subdomains (www stripped)", () => {
    expect(isIdealistaUrl("https://www.idealista.com/venta-viviendas/")).toBe(true);
    expect(isIdealistaUrl("https://idealista.com/x")).toBe(true);
    expect(isIdealistaUrl("http://m.idealista.com/x")).toBe(true);
    expect(isIdealistaUrl(SHAPE_URL)).toBe(true);
  });

  it("rejects other portals and unrelated hosts", () => {
    expect(isIdealistaUrl("https://www.alisedainmobiliaria.com/x")).toBe(false);
    expect(isIdealistaUrl("https://example.com/x")).toBe(false);
  });

  it("rejects a look-alike host that only contains idealista.com", () => {
    expect(isIdealistaUrl("https://idealista.com.evil.example/x")).toBe(false);
    expect(isIdealistaUrl("https://notidealista.com/x")).toBe(false);
  });

  it("rejects non-http(s) schemes even with an idealista-looking host", () => {
    expect(isIdealistaUrl("javascript://idealista.com/x")).toBe(false);
    expect(isIdealistaUrl("data:text/html,idealista.com")).toBe(false);
  });

  it("rejects malformed / empty input", () => {
    expect(isIdealistaUrl("")).toBe(false);
    expect(isIdealistaUrl("not a url")).toBe(false);
    expect(isIdealistaUrl(undefined as unknown as string)).toBe(false);
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
  it("shapes the payload for a valid idealista URL, keeping the URL verbatim", () => {
    const now = new Date("2026-08-08T10:00:00.000Z");
    const out = buildSearchUrlCapture({ url: SHAPE_URL, title: "  Zona  " }, now);
    expect(out).toEqual({
      url: SHAPE_URL, // verbatim — shape= preserved
      title: "Zona", // trimmed
      host: "idealista.com", // www stripped
      capturedAt: "2026-08-08T10:00:00.000Z",
    });
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

  it("returns null for a non-idealista or invalid URL", () => {
    expect(buildSearchUrlCapture({ url: "https://example.com/x" })).toBeNull();
    expect(buildSearchUrlCapture({ url: "javascript://idealista.com/x" })).toBeNull();
    expect(buildSearchUrlCapture({})).toBeNull();
  });
});
