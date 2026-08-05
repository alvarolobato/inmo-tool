import { describe, it, expect } from "vitest";
import { CAPTURE_SIGNAL, withCaptureSignal } from "@/lib/extension-capture";

/**
 * The dashboard's "Abrir búsqueda" opens a portal search URL tagged with the
 * batch auto-start signal (issue #297). These tests lock the tagging contract
 * the extension's detect.js `captureSignalPresent` relies on.
 */
describe("withCaptureSignal — tag an opened search URL for extension auto-start", () => {
  it("adds the #inmo-capture fragment when the URL has none", () => {
    expect(withCaptureSignal("https://www.idealista.com/venta-viviendas/estepona-malaga/")).toBe(
      "https://www.idealista.com/venta-viviendas/estepona-malaga/#inmo-capture",
    );
    // Works alongside an existing query string.
    expect(withCaptureSignal("https://www.alisedainmobiliaria.com/venta?precioMax=200000")).toBe(
      "https://www.alisedainmobiliaria.com/venta?precioMax=200000#inmo-capture",
    );
  });

  it("falls back to a query key when the URL already carries a fragment (never clobbers it)", () => {
    const out = withCaptureSignal("https://www.idealista.com/venta-viviendas/x/#existing");
    const u = new URL(out);
    expect(u.hash).toBe("#existing");
    expect(u.searchParams.has(CAPTURE_SIGNAL)).toBe(true);
  });

  it("is idempotent — tagging an already-tagged URL doesn't double up", () => {
    const once = withCaptureSignal("https://www.idealista.com/venta-viviendas/x/");
    expect(withCaptureSignal(once)).toBe(once);
  });

  it("returns the input unchanged for an unparseable URL (never breaks it)", () => {
    expect(withCaptureSignal("not a url")).toBe("not a url");
    expect(withCaptureSignal("")).toBe("");
  });
});
