/**
 * @vitest-environment jsdom
 *
 * Tests for the two halves of network capture that live INSIDE the page
 * (issue #684): `network-recorder-relay.js` (ISOLATED world) and
 * `network-recorder-main.js` (MAIN world).
 *
 * ── What this file can and cannot prove ──────────────────────────────────
 * jsdom gives a real `window`, a real `postMessage` task queue, a real
 * `XMLHttpRequest` prototype and a stubbable `fetch`, which is enough to
 * drive the handshake, the nonce check and the uninstall path as actual code
 * rather than as a description of it. It is NOT a browser: there is no MV3
 * service worker to evict, no `chrome.scripting` registry, no document_start
 * ordering against a real page's own scripts, and no second tab. The
 * origin-wide-interception window this file measures in jsdom milliseconds is
 * a real browser's network round-trip to a possibly-cold worker.
 *
 * The smoke test that covers the rest is written out in
 * docs/decisions/D-164-network-capture-armed-lifecycle.md.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const NONCE = "3f6b0c2e-0000-4000-8000-000000000001"; // synthetic, never a real one
const GUARD = Symbol.for("net-capture-guard");

interface ChromeStub {
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    lastError: undefined;
  };
}

/** Load the pure redaction module the way the MAIN-world registration does:
 * same `self`, network-recorder.js first. */
async function loadPureModule() {
  await import("../../browser-extension/network-recorder.js");
}

async function loadRelay() {
  await import("../../browser-extension/network-recorder-relay.js");
}

async function loadMain() {
  await import("../../browser-extension/network-recorder-main.js");
}

/** Deliver every queued `postMessage` task. */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Deliver an inbound page message the way a browser would.
 *
 * jsdom's own `window.postMessage` leaves `event.source` null, and both the
 * relay and the MAIN recorder REQUIRE `event.source === window` (that check is
 * part of what is under test), so a jsdom postMessage would be rejected for
 * the wrong reason and every guard below would pass vacuously. Dispatching an
 * explicitly-shaped MessageEvent exercises the real guards instead.
 */
function deliver(data: unknown, over?: { source?: unknown; origin?: string }): Promise<void> {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: over && "origin" in over ? over.origin : window.location.origin,
      source: (over && "source" in over ? over.source : window) as MessageEventSource | null,
    }),
  );
  return drain();
}

let chromeStub: ChromeStub;

beforeEach(async () => {
  vi.resetModules();
  chromeStub = {
    runtime: { sendMessage: vi.fn(), lastError: undefined },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
  delete (globalThis as Record<string, unknown>).InmoNetworkRecorder;
  try {
    delete (window as unknown as Record<symbol, unknown>)[GUARD];
  } catch {
    /* ignore */
  }
  await loadPureModule();
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.chrome;
  delete g.InmoNetworkRecorder;
  try {
    delete (window as unknown as Record<symbol, unknown>)[GUARD];
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

// ═══ Relay ════════════════════════════════════════════════════════════════

describe("network-recorder-relay — S5: a page script can no longer fabricate entries", () => {
  async function loadRelayArmed(nonce: string | null) {
    chromeStub.runtime.sendMessage.mockImplementation(
      (msg: { type: string }, cb?: (r: unknown) => void) => {
        if (msg.type === "NETWORK_RECORDER_HELLO" && cb) {
          cb(nonce ? { armed: true, nonce } : { armed: false });
        }
      },
    );
    await loadRelay();
  }

  it("forwards an entry that carries the session nonce", async () => {
    await loadRelayArmed(NONCE);
    await drain();
    chromeStub.runtime.sendMessage.mockClear();

    await deliver({
      source: "inmo-diag-recorder",
      type: "NETWORK_ENTRY",
      nonce: NONCE,
      entry: { url: "https://example.invalid/api/listings" },
    });

    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const [msg] = chromeStub.runtime.sendMessage.mock.calls[0] as [Record<string, unknown>];
    expect(msg.type).toBe("NETWORK_ENTRY");
    expect(msg.nonce).toBe(NONCE);
  });

  // PR #675's relay accepted any message where event.source === window,
  // event.origin === location.origin and data.source === "inmo-diag-recorder"
  // — all three trivially forgeable by ANY script on the page, so a portal (or
  // an injected third-party script) could inject arbitrary entries into a
  // diagnostic. This is that exact forgery.
  it("REJECTS a same-origin forgery with no nonce, or the wrong one", async () => {
    await loadRelayArmed(NONCE);
    await drain();
    chromeStub.runtime.sendMessage.mockClear();

    await deliver({
      source: "inmo-diag-recorder",
      type: "NETWORK_ENTRY",
      entry: { url: "https://example.invalid/fabricated" },
    });
    await deliver({
      source: "inmo-diag-recorder",
      type: "NETWORK_ENTRY",
      nonce: "guessed",
      entry: { url: "https://example.invalid/fabricated-2" },
    });

    expect(chromeStub.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("REJECTS a nonce-carrying entry from a cross-origin frame or a foreign window", async () => {
    await loadRelayArmed(NONCE);
    await drain();
    chromeStub.runtime.sendMessage.mockClear();

    const entry = {
      source: "inmo-diag-recorder",
      type: "NETWORK_ENTRY",
      nonce: NONCE,
      entry: { url: "https://example.invalid/from-an-iframe" },
    };
    await deliver(entry, { origin: "https://evil.invalid" });
    await deliver(entry, { source: null });

    expect(chromeStub.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("tells the MAIN world it is ARMED only when the worker says this tab is the armed one", async () => {
    const seen: unknown[] = [];
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string; type?: string };
      if (data && data.source === "inmo-diag-relay") seen.push(data);
    });

    await loadRelayArmed(NONCE);
    await drain();

    expect(seen).toEqual([
      { source: "inmo-diag-relay", type: "INMO_DIAG_ARMED", nonce: NONCE },
    ]);
  });

  it("tells the MAIN world NOT_ARMED for every other tab on the same origin (B2)", async () => {
    const seen: string[] = [];
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string; type?: string };
      if (data && data.source === "inmo-diag-relay") seen.push(String(data.type));
    });

    await loadRelayArmed(null);
    await drain();

    expect(seen).toEqual(["INMO_DIAG_NOT_ARMED"]);
  });

  it("fails CLOSED when the worker never answers", async () => {
    const seen: string[] = [];
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string; type?: string };
      if (data && data.source === "inmo-diag-relay") seen.push(String(data.type));
    });
    chromeStub.runtime.sendMessage.mockImplementation(
      (_msg: unknown, cb?: (r: unknown) => void) => {
        if (cb) cb(undefined);
      },
    );

    await loadRelay();
    await drain();

    expect(seen).toEqual(["INMO_DIAG_NOT_ARMED"]);
  });
});

// ═══ MAIN world ═══════════════════════════════════════════════════════════

describe("network-recorder-main — S6: the page cannot fingerprint the recorder", () => {
  it("leaves no __inmoDiag* own-property on window and installs no NAMED wrapper", async () => {
    const before = Object.getOwnPropertyNames(window).filter((n) => n.startsWith("__inmoDiag"));
    expect(before).toEqual([]);

    await loadMain();

    // PR #675 set `self.__inmoDiagRecorderInstalled` and `self.__inmoDiagT0`.
    const after = Object.getOwnPropertyNames(window).filter((n) => n.startsWith("__inmoDiag"));
    expect(after).toEqual([]);
    // …and installed `function inmoDiagFetch`.
    expect(String(window.fetch)).not.toContain("inmoDiag");
    expect(window.fetch.name).not.toContain("inmoDiag");
  });

  it("keeps per-XHR state off the XHR instance (PR #675 stamped __inmoDiagUrl on every one)", async () => {
    await loadMain();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.invalid/api/listings");
    const own = Object.getOwnPropertyNames(xhr).filter((n) => n.startsWith("__inmoDiag"));
    expect(own).toEqual([]);
  });
});

describe("network-recorder-main — B2: a tab that is not the armed one uninstalls itself", () => {
  it("emits nothing before the relay's verdict, then flushes what it buffered once ARMED", async () => {
    const originalFetch = vi.fn(async () => new Response('{"listings":[]}', { status: 200 }));
    (window as unknown as { fetch: unknown }).fetch = originalFetch;
    await loadMain();

    const emitted: unknown[] = [];
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string; type?: string };
      if (data && data.source === "inmo-diag-recorder") emitted.push(data);
    });

    await window.fetch("https://example.invalid/api/listings");
    await drain();
    // Still 'waiting' — nothing may leave the page before we know this tab is
    // the armed one.
    expect(emitted).toHaveLength(0);

    await deliver({ source: "inmo-diag-relay", type: "INMO_DIAG_ARMED", nonce: NONCE });
    await drain();

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { nonce: string }).nonce).toBe(NONCE);
  });

  it("restores window.fetch and the XHR prototype on NOT_ARMED, and discards the buffer", async () => {
    const originalFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    (window as unknown as { fetch: unknown }).fetch = originalFetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    await loadMain();
    expect(window.fetch).not.toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).not.toBe(originalOpen);

    const emitted: unknown[] = [];
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string };
      if (data && data.source === "inmo-diag-recorder") emitted.push(data);
    });
    await window.fetch("https://example.invalid/api/before-verdict");
    await drain();

    await deliver({ source: "inmo-diag-relay", type: "INMO_DIAG_NOT_ARMED" });
    await drain();

    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(XMLHttpRequest.prototype.send).toBe(originalSend);
    expect(emitted).toHaveLength(0);
  });

  it("is a pure passthrough — the page's own fetch result is unchanged and issued exactly once", async () => {
    const response = new Response('{"ok":true}', { status: 200 });
    const originalFetch = vi.fn(async () => response);
    (window as unknown as { fetch: unknown }).fetch = originalFetch;
    await loadMain();

    const got = await window.fetch("https://example.invalid/api/x", { method: "GET" });

    // No retry, no replay, no spoofed header (issue #1 §15, D-026/D-027/D-033).
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(got).toBe(response);
  });

  it("does not double-wrap when injected twice", async () => {
    const originalFetch = vi.fn(async () => new Response("{}"));
    (window as unknown as { fetch: unknown }).fetch = originalFetch;
    await loadMain();
    const firstWrapper = window.fetch;
    vi.resetModules();
    await loadMain();
    expect(window.fetch).toBe(firstWrapper);
  });
});
