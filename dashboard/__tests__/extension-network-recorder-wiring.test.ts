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

type RuntimeMessageListener = (
  msg: Record<string, unknown>,
  sender: unknown,
  respond: (r?: unknown) => void,
) => unknown;

interface ChromeStub {
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn> };
    lastError: undefined;
  };
  /** Every listener the relay registered, so a test can play the background's
   * `chrome.tabs.sendMessage(tabId, …)` into it. */
  __runtimeMessageListeners: RuntimeMessageListener[];
}

/** Deliver a background→content-script message the way `chrome.tabs.sendMessage`
 * would, then let the resulting postMessage tasks run. */
async function sendFromBackground(stub: ChromeStub, msg: Record<string, unknown>): Promise<void> {
  for (const listener of stub.__runtimeMessageListeners) listener(msg, {}, () => {});
  await drain(); // the relay's postMessage
  await drain(); // …bridged on to the MAIN world
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

/**
 * Let the REAL relay and the REAL MAIN recorder talk to each other.
 *
 * Both halves send with `window.postMessage` and both require
 * `event.source === window` on receipt — but jsdom's `postMessage` delivers
 * with `source: null`, so left alone the two production modules cannot hear
 * each other at all and every cross-half test would pass vacuously. This
 * re-dispatches each half's real output through `deliver()`, which shapes it
 * the way a browser would. Only messages that arrived with the WRONG source
 * are re-dispatched, so the re-delivery cannot feed itself.
 *
 * Everything either module actually does — the guards, the nonce check, the
 * handshake state machine, the uninstall — still runs as real code; only the
 * jsdom transport is patched around.
 */
function bridgePostMessage(): () => void {
  const handler = (event: MessageEvent) => {
    if (event.source === window) return; // already correctly shaped — stop here
    const data = event.data as { source?: string } | null;
    if (!data) return;
    if (data.source !== "inmo-diag-relay" && data.source !== "inmo-diag-recorder") return;
    void deliver(data);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/**
 * EVERY relay listener this file has ever loaded, across all tests — not reset
 * per test.
 *
 * Same shared-jsdom-window problem as the MAIN recorder: a relay instance from
 * an earlier test keeps its `message` listener on the window and goes on
 * forwarding into whatever `chrome` stub is current, because it resolves
 * `chrome` off `globalThis` at call time. `afterEach` latches every one of them
 * off with a real NETWORK_RECORDER_DISARM — which is the very code path under
 * test here, so this cleanup is not a workaround so much as a second exercise
 * of it.
 */
const allRelayListeners: RuntimeMessageListener[] = [];

/** jsdom's window is shared by every test in this file, so capture the pristine
 * XHR prototype methods ONCE, before any test wraps them. */
const PRISTINE_XHR = {
  open: XMLHttpRequest.prototype.open,
  setRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
  send: XMLHttpRequest.prototype.send,
};

let chromeStub: ChromeStub;

beforeEach(async () => {
  vi.resetModules();
  const runtimeMessageListeners: RuntimeMessageListener[] = [];
  chromeStub = {
    runtime: {
      sendMessage: vi.fn(),
      onMessage: {
        addListener: vi.fn((fn: RuntimeMessageListener) => {
          runtimeMessageListeners.push(fn);
          allRelayListeners.push(fn);
        }),
      },
      lastError: undefined,
    },
    __runtimeMessageListeners: runtimeMessageListeners,
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

afterEach(async () => {
  // `vi.resetModules()` gives the NEXT test a fresh module instance, but it
  // cannot retract what a previous instance did to this file's single shared
  // jsdom `window`: its `message` listener stays attached and, if it settled
  // ARMED, it keeps emitting into every later test. Settle every live instance
  // off through the real production path, which is also what restores
  // `fetch`/XHR.
  for (const listener of allRelayListeners) {
    try {
      listener({ type: "NETWORK_RECORDER_DISARM" }, {}, () => {});
    } catch {
      /* ignore */
    }
  }
  await deliver({ source: "inmo-diag-relay", type: "INMO_DIAG_NOT_ARMED" });
  XMLHttpRequest.prototype.open = PRISTINE_XHR.open;
  XMLHttpRequest.prototype.setRequestHeader = PRISTINE_XHR.setRequestHeader;
  XMLHttpRequest.prototype.send = PRISTINE_XHR.send;

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

// ═══ Teardown of the already-injected wrapper (#684 H1) ═══════════════════

// The review of the first cut of this PR: unregistering the content scripts
// governs FUTURE injections only. Nothing spoke to the armed tab, and the relay
// registered no `chrome.runtime.onMessage` listener at all, so after STOP /
// send / expiry / a sweep the MAIN-world wrapper stayed on `window.fetch` and
// the XHR prototype for the life of the document, still postMessage-ing
// summarised entries — URLs, headers, up-to-20 KB bodies — onto the page's own
// message bus where any page script could read them. The confirm() tells the
// owner the recording "se detiene sola a los 5 minutos, al cerrar la pestaña, o
// cuando pulses Detener grabación"; before this it didn't.
describe("network-recorder-relay — H1: a disarm from the background reaches the page", () => {
  async function loadRelayArmed(nonce: string) {
    chromeStub.runtime.sendMessage.mockImplementation(
      (msg: { type: string }, cb?: (r: unknown) => void) => {
        if (msg.type === "NETWORK_RECORDER_HELLO" && cb) cb({ armed: true, nonce });
      },
    );
    await loadRelay();
    await drain();
  }

  it("registers a runtime.onMessage listener at all — there was none", async () => {
    await loadRelayArmed(NONCE);
    expect(chromeStub.runtime.onMessage.addListener).toHaveBeenCalled();
  });

  it("turns NETWORK_RECORDER_DISARM into the MAIN world's NOT_ARMED verdict", async () => {
    const seen: string[] = [];
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string; type?: string };
      if (data && data.source === "inmo-diag-relay") seen.push(String(data.type));
    });

    await loadRelayArmed(NONCE);
    expect(seen).toEqual(["INMO_DIAG_ARMED"]);

    await sendFromBackground(chromeStub, { type: "NETWORK_RECORDER_DISARM" });

    expect(seen).toEqual(["INMO_DIAG_ARMED", "INMO_DIAG_NOT_ARMED"]);
  });

  it("stops forwarding entries once disarmed, even ones carrying the real nonce", async () => {
    await loadRelayArmed(NONCE);
    chromeStub.runtime.sendMessage.mockClear();

    const entry = {
      source: "inmo-diag-recorder",
      type: "NETWORK_ENTRY",
      nonce: NONCE,
      entry: { url: "https://example.invalid/api/listings" },
    };
    await deliver(entry);
    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledTimes(1); // still armed

    await sendFromBackground(chromeStub, { type: "NETWORK_RECORDER_DISARM" });
    chromeStub.runtime.sendMessage.mockClear();
    await deliver(entry);

    expect(chromeStub.runtime.sendMessage).not.toHaveBeenCalled();
  });

  // STOP, then the expiry alarm a minute later, then a sweep on the next worker
  // respawn is a NORMAL sequence, not a pathological one — teardown has to be
  // repeatable without re-announcing anything.
  it("is idempotent across repeated disarms", async () => {
    const seen: string[] = [];
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string; type?: string };
      if (data && data.source === "inmo-diag-relay") seen.push(String(data.type));
    });
    await loadRelayArmed(NONCE);

    await sendFromBackground(chromeStub, { type: "NETWORK_RECORDER_DISARM" });
    await sendFromBackground(chromeStub, { type: "NETWORK_RECORDER_DISARM" });
    await sendFromBackground(chromeStub, { type: "NETWORK_RECORDER_DISARM" });

    expect(seen).toEqual(["INMO_DIAG_ARMED", "INMO_DIAG_NOT_ARMED"]);
  });

  // The disarm can land while the HELLO round-trip is still outstanding (a cold
  // worker plus a fast STOP). Arming after that would reinstall a recorder the
  // background has already torn down and forgotten.
  it("never arms after a disarm that beat the handshake", async () => {
    const seen: string[] = [];
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string; type?: string };
      if (data && data.source === "inmo-diag-relay") seen.push(String(data.type));
    });
    let helloCallback: ((r: unknown) => void) | null = null;
    chromeStub.runtime.sendMessage.mockImplementation(
      (msg: { type: string }, cb?: (r: unknown) => void) => {
        if (msg.type === "NETWORK_RECORDER_HELLO" && cb) helloCallback = cb;
      },
    );
    await loadRelay();
    await drain();

    await sendFromBackground(chromeStub, { type: "NETWORK_RECORDER_DISARM" });
    // …and only NOW does the worker get round to answering "yes, armed".
    helloCallback!({ armed: true, nonce: NONCE });
    await drain();

    expect(seen).toEqual(["INMO_DIAG_NOT_ARMED"]);
  });
});

describe("network-recorder-main — H1: the injected wrapper actually uninstalls", () => {
  let unbridge: (() => void) | null = null;
  afterEach(() => {
    if (unbridge) unbridge();
    unbridge = null;
  });

  /**
   * Arm the real relay + the real MAIN recorder against each other, the way a
   * document_start injection does, and hand back the pre-wrap originals.
   *
   * Both real modules, bridged over jsdom's source-less postMessage — so the
   * teardown below is the production path end to end: background message →
   * relay listener → relay's NOT_ARMED → MAIN's settleOff → uninstall.
   */
  async function armBothHalves() {
    const originalFetch = vi.fn(async () => new Response('{"listings":[]}', { status: 200 }));
    (window as unknown as { fetch: unknown }).fetch = originalFetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = XMLHttpRequest.prototype.send;

    unbridge = bridgePostMessage();
    await loadMain();
    chromeStub.runtime.sendMessage.mockImplementation(
      (msg: { type: string }, cb?: (r: unknown) => void) => {
        if (msg.type === "NETWORK_RECORDER_HELLO" && cb) cb({ armed: true, nonce: NONCE });
      },
    );
    await loadRelay();
    await drain();
    await drain(); // relay's ARMED → bridge → MAIN's settleArmed

    // Genuinely armed: the wrapper is installed and entries really are
    // reaching the background, so the teardown assertions below are not
    // measuring a recorder that was inert to begin with.
    expect(window.fetch).not.toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).not.toBe(originalOpen);
    chromeStub.runtime.sendMessage.mockClear();
    await window.fetch("https://example.invalid/api/listings");
    await drain();
    await drain();
    const forwarded = chromeStub.runtime.sendMessage.mock.calls.filter(
      ([m]) => (m as { type?: string }).type === "NETWORK_ENTRY",
    );
    expect(forwarded).toHaveLength(1);

    return { originalFetch, originalOpen, originalSetRequestHeader, originalSend };
  }

  function expectRestored(o: Awaited<ReturnType<typeof armBothHalves>>) {
    expect(window.fetch).toBe(o.originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(o.originalOpen);
    expect(XMLHttpRequest.prototype.setRequestHeader).toBe(o.originalSetRequestHeader);
    expect(XMLHttpRequest.prototype.send).toBe(o.originalSend);
  }

  // ── The four teardown paths. Each one reaches the page by exactly the same
  // NETWORK_RECORDER_DISARM the background sends from disarmNetworkRecording()
  // (SEND_DIAGNOSTIC / STOP / expiry / tab close) and from the sweep; the
  // background half — that each path really sends it — is pinned in
  // extension-diagnostic-background.test.ts. This half pins what the page then
  // does with it, which is the part that was missing entirely.
  for (const path of [
    "SEND_DIAGNOSTIC — the owner sent the diagnostic",
    "STOP — the owner pressed Detener grabación",
    "expiry — the 5-minute TTL, for an owner who never sends",
    "sweep / tab close — a stranded registration on a still-live document",
  ]) {
    it(`restores window.fetch and the whole XHR prototype on ${path}`, async () => {
      const originals = await armBothHalves();

      await sendFromBackground(chromeStub, { type: "NETWORK_RECORDER_DISARM" });

      expectRestored(originals);
    });
  }

  it("emits NOTHING onto the page's message bus after a disarm", async () => {
    await armBothHalves();

    const leaked: unknown[] = [];
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string };
      if (data && data.source === "inmo-diag-recorder") leaked.push(data);
    });

    await sendFromBackground(chromeStub, { type: "NETWORK_RECORDER_DISARM" });
    // The page keeps making requests — it has no idea a diagnostic ever ran.
    await window.fetch("https://example.invalid/api/after-disarm");
    await drain();
    await drain();

    // Nothing summarised — no URL, no headers, no response body — is posted
    // where a page script could read it.
    expect(leaked).toEqual([]);
  });

  it("leaves the page's own fetch working normally afterwards", async () => {
    const { originalFetch } = await armBothHalves();
    await sendFromBackground(chromeStub, { type: "NETWORK_RECORDER_DISARM" });

    originalFetch.mockClear();
    const got = await window.fetch("https://example.invalid/api/still-works");

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(got.status).toBe(200);
  });

  // A wrapper that stops emitting but stays on `window.fetch` would pass the
  // "nothing leaks" test above while still being the thing #684 exists to
  // remove. Assert the guard is released too, so a later re-arm can reinstall.
  it("releases the install guard, so a later re-arm is not a silent no-op", async () => {
    await armBothHalves();
    expect((window as unknown as Record<symbol, unknown>)[GUARD]).toBe(true);

    await sendFromBackground(chromeStub, { type: "NETWORK_RECORDER_DISARM" });

    expect((window as unknown as Record<symbol, unknown>)[GUARD]).toBeUndefined();
  });
});

// ═══ MAIN world ═══════════════════════════════════════════════════════════

describe("network-recorder-main — S6: the page cannot fingerprint the recorder", () => {
  it("leaves no __inmoDiag* own-property on window and no wrapper name that identifies it", async () => {
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

  // Recorded precisely rather than described loosely: `name`/`length` ARE
  // overridden. Left alone the inferred name would be "wrappedFetch" — a marker
  // that names the technique — so blanking it is hygiene. `toString()` is NOT
  // faked, which is the line: normalising a name removes an identifying string,
  // faking toString() would ASSERT nativeness (issue #1 §15, D-026/D-027/D-033).
  it("normalises name/length to the native values but never fakes toString()", async () => {
    const originalFetch = vi.fn(async () => new Response("{}"));
    Object.defineProperty(originalFetch, "length", { value: 2, configurable: true });
    (window as unknown as { fetch: unknown }).fetch = originalFetch;

    await loadMain();

    expect(window.fetch.name).toBe("fetch");
    expect(window.fetch.length).toBe(2);
    expect(XMLHttpRequest.prototype.open.name).toBe("open");
    expect(XMLHttpRequest.prototype.send.name).toBe("send");
    expect(XMLHttpRequest.prototype.setRequestHeader.name).toBe("setRequestHeader");

    // The honest half: a page that stringifies the wrapper still sees a
    // wrapper. We do not claim `[native code]`.
    expect(String(window.fetch)).not.toContain("[native code]");
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
