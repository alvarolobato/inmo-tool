import { describe, it, expect } from "vitest";
import {
  CAPTURE_SIGNAL,
  CAPTURE_QUEUE_SIGNAL,
  withCaptureSignal,
  withCaptureQueue,
  encodeCaptureQueue,
  decodeCaptureQueue,
  type QueuedSearch,
} from "@/lib/extension-capture";

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

/**
 * "Capturar todo" batch-queue signal (issue #556) — the dashboard's ONLY way
 * to hand additional searches to the extension is piggybacking them on the
 * one tab it's allowed to open. These tests lock the encode/decode contract
 * `browser-extension/detect.js` `parseCaptureQueue` relies on byte-for-byte.
 */
describe("encodeCaptureQueue / decodeCaptureQueue — round trip", () => {
  it("round-trips a list of queued searches", () => {
    const queue: QueuedSearch[] = [
      { portal: "aliseda", captureUrl: "https://www.alisedainmobiliaria.com/venta?x=1" },
      { portal: "altamira", captureUrl: "https://www.altamirainmuebles.com/venta" },
    ];
    const encoded = encodeCaptureQueue(queue);
    expect(decodeCaptureQueue(encoded)).toEqual(queue);
  });

  it("round-trips an empty list", () => {
    expect(decodeCaptureQueue(encodeCaptureQueue([]))).toEqual([]);
  });

  it("encodes as a compact tuple array, not a full object list", () => {
    const encoded = encodeCaptureQueue([{ portal: "aliseda", captureUrl: "https://x/y" }]);
    expect(JSON.parse(encoded)).toEqual([["aliseda", "https://x/y"]]);
  });

  it("decodeCaptureQueue returns null (never throws) on malformed input", () => {
    expect(decodeCaptureQueue("not json")).toBeNull();
    expect(decodeCaptureQueue("{}")).toBeNull();
    expect(decodeCaptureQueue("[1,2,3]")).toEqual([]); // drops non-tuple entries, never throws
    expect(decodeCaptureQueue('[["only-portal"]]')).toEqual([]); // drops incomplete tuples
  });
});

describe("withCaptureQueue — piggyback additional searches on the opened URL", () => {
  it("is a no-op when the queue is empty (single-task flow unaffected)", () => {
    const url = "https://www.idealista.com/venta-viviendas/madrid/#inmo-capture";
    expect(withCaptureQueue(url, [])).toBe(url);
  });

  it("appends the queue as a query param, leaving an existing fragment untouched", () => {
    const url = "https://www.idealista.com/venta-viviendas/madrid/#inmo-capture";
    const out = withCaptureQueue(url, [
      { portal: "aliseda", captureUrl: "https://www.alisedainmobiliaria.com/venta" },
    ]);
    const u = new URL(out);
    expect(u.hash).toBe("#inmo-capture"); // CAPTURE_SIGNAL contract untouched
    expect(u.searchParams.has(CAPTURE_QUEUE_SIGNAL)).toBe(true);
    expect(JSON.parse(u.searchParams.get(CAPTURE_QUEUE_SIGNAL)!)).toEqual([
      ["aliseda", "https://www.alisedainmobiliaria.com/venta"],
    ]);
  });

  it("composes with withCaptureSignal exactly as the batch button calls them", () => {
    const out = withCaptureQueue(
      withCaptureSignal("https://www.idealista.com/venta-viviendas/madrid/"),
      [{ portal: "aliseda", captureUrl: "https://www.alisedainmobiliaria.com/venta" }],
    );
    const u = new URL(out);
    expect(u.hash).toBe("#inmo-capture");
    expect(u.searchParams.has(CAPTURE_QUEUE_SIGNAL)).toBe(true);
  });

  it("returns the input unchanged for an unparseable URL (never breaks it)", () => {
    expect(withCaptureQueue("not a url", [{ portal: "x", captureUrl: "y" }])).toBe("not a url");
  });
});
