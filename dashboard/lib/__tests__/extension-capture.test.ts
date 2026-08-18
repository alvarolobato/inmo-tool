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

describe("withCaptureQueue — piggyback additional searches on the opened URL (D-113 review B2: FRAGMENT, not query)", () => {
  it("is a no-op when the queue is empty (single-task flow unaffected)", () => {
    const url = "https://www.idealista.com/venta-viviendas/madrid/#inmo-capture";
    expect(withCaptureQueue(url, [])).toBe(url);
  });

  it("appends the queue as a URL FRAGMENT (never the query string, so it's never sent to the portal server)", () => {
    const url = "https://www.idealista.com/venta-viviendas/madrid/";
    const out = withCaptureQueue(url, [
      { portal: "aliseda", captureUrl: "https://www.alisedainmobiliaria.com/venta" },
    ]);
    const u = new URL(out);
    expect(u.search).toBe(""); // nothing added to the query string
    expect(u.hash.startsWith(`#${CAPTURE_QUEUE_SIGNAL}=`)).toBe(true);
    const decoded = decodeURIComponent(u.hash.slice(`#${CAPTURE_QUEUE_SIGNAL}=`.length));
    expect(JSON.parse(decoded)).toEqual([["aliseda", "https://www.alisedainmobiliaria.com/venta"]]);
  });

  it("is idempotent — tagging an already-tagged URL doesn't double up", () => {
    const once = withCaptureQueue("https://x.example/y", [{ portal: "a", captureUrl: "https://b/c" }]);
    expect(withCaptureQueue(once, [{ portal: "a", captureUrl: "https://b/c" }])).toBe(once);
  });

  it("falls back to the query string when the URL already carries an unrelated fragment (documented, accepted degrade)", () => {
    const url = "https://www.idealista.com/venta-viviendas/madrid/#existing";
    const out = withCaptureQueue(url, [
      { portal: "aliseda", captureUrl: "https://www.alisedainmobiliaria.com/venta" },
    ]);
    const u = new URL(out);
    expect(u.hash).toBe("#existing"); // never clobbers an unrelated fragment
    expect(u.searchParams.has(CAPTURE_QUEUE_SIGNAL)).toBe(true);
  });

  it("composes with withCaptureSignal in the order the batch button uses: queue FIRST (claims the fragment), signal SECOND (falls back to the query)", () => {
    const out = withCaptureSignal(
      withCaptureQueue("https://www.idealista.com/venta-viviendas/madrid/", [
        { portal: "aliseda", captureUrl: "https://www.alisedainmobiliaria.com/venta" },
      ]),
    );
    const u = new URL(out);
    // The queue owns the fragment slot...
    expect(u.hash.startsWith(`#${CAPTURE_QUEUE_SIGNAL}=`)).toBe(true);
    // ...so withCaptureSignal — completely unmodified by this feature — falls
    // back to its OWN existing query-key form. Zero changes needed to
    // withCaptureSignal/captureSignalPresent for this to work (D-113).
    expect(u.searchParams.get(CAPTURE_SIGNAL)).toBe("1");
  });

  it("when the queue is empty, composing with withCaptureSignal is byte-identical to the single-task flow", () => {
    const out = withCaptureSignal(withCaptureQueue("https://www.idealista.com/venta-viviendas/madrid/", []));
    expect(out).toBe(withCaptureSignal("https://www.idealista.com/venta-viviendas/madrid/"));
    const u = new URL(out);
    expect(u.hash).toBe("#inmo-capture");
    expect(u.search).toBe("");
  });

  it("does not re-serialise/mangle an existing polygon shape= query param (idealista drawn-zone searches)", () => {
    const url =
      "https://www.idealista.com/areas/venta-viviendas/pisos/?shape=((40.41%2C-3.70)(40.42%2C-3.69)(40.40%2C-3.71))";
    const out = withCaptureQueue(url, [{ portal: "aliseda", captureUrl: "https://x/y" }]);
    const u = new URL(out);
    expect(u.searchParams.get("shape")).toBe(new URL(url).searchParams.get("shape"));
  });

  it("returns the input unchanged for an unparseable URL (never breaks it)", () => {
    expect(withCaptureQueue("not a url", [{ portal: "x", captureUrl: "y" }])).toBe("not a url");
  });
});
