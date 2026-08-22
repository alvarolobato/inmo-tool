/**
 * Integration tests for browser-extension/background.js's diagnostics/
 * network-capture WIRING (issue #671 — "forzar captura + diagnóstico").
 *
 * Same approach as extension-background-batch-queue.test.ts: background.js
 * loaded via Node's CommonJS `require` against a from-scratch chrome/self/
 * fetch stub, `importScripts` shimmed to `require()` the sibling files —
 * each test gets a byte-for-byte fresh module instance.
 *
 * Covers the state machine around the OPT-IN network-capture reload:
 *   armNetworkRecording  — requires the host permission to ALREADY be
 *                           granted (never requests it itself — a service
 *                           worker has no user-activation signal), then
 *                           registers the MAIN/ISOLATED dynamic content
 *                           scripts scoped to exactly one origin.
 *   recordNetworkEntry   — buffers only for a tab that's actually armed.
 *   disarmNetworkRecording — unregisters + returns the capped entries, and
 *                           is safe to call even when nothing was armed
 *                           (SEND_DIAGNOSTIC's unconditional call).
 *   sendDiagnostic       — POSTs to the dedicated diagnostic endpoint, never
 *                           /api/extension/capture.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = fileURLToPath(new URL("../../browser-extension/", import.meta.url));
const req = createRequire(import.meta.url);

const SIBLING_FILES = [
  "detect.js",
  "batch.js",
  "capture-search-url.js",
  "observe-search-url.js",
  "network-recorder.js",
  "background.js",
];

function resetRequireCache() {
  for (const file of SIBLING_FILES) {
    const resolved = req.resolve(path.join(EXT_DIR, file));
    delete req.cache[resolved];
  }
}

interface StorageArea {
  get: (keys?: string | string[] | null) => Promise<Record<string, unknown>>;
  set: (obj: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
}

function makeStorageArea(store: Record<string, unknown>): StorageArea {
  return {
    get: async (keys) => {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    set: vi.fn(async (obj: Record<string, unknown>) => {
      Object.assign(store, obj);
    }),
    remove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete store[k];
    },
  };
}

function makeChromeMock(opts: { hasPermission?: boolean } = {}) {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const sync: Record<string, unknown> = {};
  return {
    storage: {
      local: makeStorageArea(local),
      session: makeStorageArea(session),
      sync: makeStorageArea(sync),
    },
    tabs: {
      create: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
      get: vi.fn(async () => ({})),
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => null),
      onUpdated: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: { addListener: vi.fn() } },
    runtime: {
      onMessage: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "0.16.0-test" }),
      lastError: undefined,
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setTitle: vi.fn() },
    scripting: {
      executeScript: vi.fn(async () => {}),
      registerContentScripts: vi.fn(async () => {}),
      unregisterContentScripts: vi.fn(async () => {}),
    },
    permissions: {
      contains: vi.fn(async () => opts.hasPermission !== false),
      request: vi.fn(async () => true),
    },
  };
}

interface BackgroundModule {
  armNetworkRecording: (
    tabId: number,
    origin: string,
  ) => Promise<{ success: boolean; error?: { message: string } }>;
  disarmNetworkRecording: (
    tabId: number,
  ) => Promise<{ entries: unknown[]; droppedCount: number } | null>;
  recordNetworkEntry: (tabId: number, entry: unknown) => void;
  getNetworkRecordingState: (tabId: number) => { armed: boolean; entryCount: number };
  sendDiagnostic: (payload: {
    url: string;
    html: string;
    title?: string | null;
    diagnostic?: unknown;
    network?: unknown;
  }) => Promise<unknown>;
}

function loadBackground(
  chromeMock: ReturnType<typeof makeChromeMock>,
  fetchMock: ReturnType<typeof vi.fn>,
): BackgroundModule {
  resetRequireCache();
  (globalThis as unknown as { self: unknown }).self = globalThis;
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  (globalThis as unknown as { importScripts: (...files: string[]) => void }).importScripts = (
    ...files: string[]
  ) => {
    for (const file of files) req(path.join(EXT_DIR, file));
  };
  return req(path.join(EXT_DIR, "background.js")) as BackgroundModule;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetRequireCache();
  const g = globalThis as Record<string, unknown>;
  delete g.self;
  delete g.chrome;
  delete g.fetch;
  delete g.importScripts;
  delete g.InmoDetect;
  delete g.InmoBatch;
  delete g.InmoSearchUrl;
  delete g.InmoObserve;
  delete g.InmoNetworkRecorder;
});

function makeFetchMock() {
  return vi.fn(async () => ({ ok: true, json: async () => ({ success: true, id: 99 }) }));
}

describe("armNetworkRecording", () => {
  it("fails without the host permission — and NEVER requests it itself (no user-activation signal in a service worker)", async () => {
    const chrome = makeChromeMock({ hasPermission: false });
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    const res = await bg.armNetworkRecording(1, "https://realestate.hipoges.com");

    expect(res.success).toBe(false);
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it("registers a MAIN-world + ISOLATED-world content script pair scoped to exactly one origin", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    const res = await bg.armNetworkRecording(7, "https://realestate.hipoges.com");

    expect(res.success).toBe(true);
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
    const registered = chrome.scripting.registerContentScripts.mock.calls[0][0] as Array<{
      matches: string[];
      world: string;
      js: string[];
    }>;
    expect(registered).toHaveLength(2);
    const mainEntry = registered.find((r) => r.world === "MAIN");
    const isolatedEntry = registered.find((r) => r.world === "ISOLATED");
    expect(mainEntry?.matches).toEqual(["https://realestate.hipoges.com/*"]);
    expect(mainEntry?.js).toEqual(["network-recorder.js", "network-recorder-main.js"]);
    expect(isolatedEntry?.matches).toEqual(["https://realestate.hipoges.com/*"]);
    expect(isolatedEntry?.js).toEqual(["network-recorder-relay.js"]);
    // Never <all_urls> — a recording session sees traffic for ONE origin only.
    for (const entry of registered) {
      expect(entry.matches).not.toContain("<all_urls>");
    }

    expect(bg.getNetworkRecordingState(7)).toEqual({ armed: true, entryCount: 0 });
  });
});

describe("recordNetworkEntry", () => {
  it("buffers an entry for an armed tab, and does nothing for an unarmed one", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());

    await bg.armNetworkRecording(3, "https://realestate.hipoges.com");
    bg.recordNetworkEntry(3, { url: "https://realestate.hipoges.com/api/assets" });
    bg.recordNetworkEntry(999, { url: "https://example.com/should-be-dropped" });

    expect(bg.getNetworkRecordingState(3)).toEqual({ armed: true, entryCount: 1 });
    expect(bg.getNetworkRecordingState(999)).toEqual({ armed: false, entryCount: 0 });
  });
});

describe("disarmNetworkRecording", () => {
  // ┌─────────────────────────────────────────────────────────────────────┐
  // │ THIS ASSERTION IS BACKWARDS AND MUST BE INVERTED — see issue #684.  │
  // └─────────────────────────────────────────────────────────────────────┘
  // It documents the CURRENT behaviour of parked, unreachable code, not a
  // property worth having. `networkBuffers` is an in-memory Map in an MV3
  // service worker that Chrome evicts after ~30s idle, so on the documented
  // happy path (arm, reload, page settles, worker dies) disarm returns null
  // here BEFORE unregistering — leaving the MAIN-world fetch/XHR wrapper
  // registered on every tab of that origin, indefinitely and across browser
  // restarts. The buffer's presence and the registration's presence are
  // independent facts; conflating them is the B1 defect that stopped the
  // network-capture half shipping in PR #675.
  //
  // When #684 rebuilds the lifecycle, disarm must ALWAYS attempt
  // `unregisterContentScripts`, and this test becomes its opposite:
  // "unregisters even when nothing was buffered for the tab".
  it("returns null when nothing was armed for the tab — safe to call unconditionally", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());

    const result = await bg.disarmNetworkRecording(42);

    expect(result).toBeNull();
    expect(chrome.scripting.unregisterContentScripts).not.toHaveBeenCalled();
  });

  it("unregisters the content scripts and returns the buffered entries, then clears the buffer", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());

    await bg.armNetworkRecording(5, "https://realestate.hipoges.com");
    bg.recordNetworkEntry(5, { url: "https://realestate.hipoges.com/api/assets", method: "GET" });

    const result = await bg.disarmNetworkRecording(5);

    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
    expect(result!.droppedCount).toBe(0);
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: ["inmo-diag-5-main", "inmo-diag-5-relay"],
    });
    // The buffer is gone — a second disarm is a clean no-op, not a re-send.
    expect(bg.getNetworkRecordingState(5)).toEqual({ armed: false, entryCount: 0 });
    const second = await bg.disarmNetworkRecording(5);
    expect(second).toBeNull();
  });
});

describe("sendDiagnostic", () => {
  it("POSTs to /api/extension/diagnostic — NEVER /api/extension/capture", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    await bg.sendDiagnostic({
      url: "https://realestate.hipoges.com/es/venta/pisos/espana/sevilla",
      html: "<html></html>",
      title: "t",
      diagnostic: { renderReady: { ready: true } },
      network: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toMatch(/\/api\/extension\/diagnostic$/);
    expect(calledUrl).not.toContain("/api/extension/capture");
    const body = JSON.parse(init.body as string);
    expect(body.url).toBe("https://realestate.hipoges.com/es/venta/pisos/espana/sevilla");
    expect(body.diagnostic).toEqual({ renderReady: { ready: true } });
  });
});
