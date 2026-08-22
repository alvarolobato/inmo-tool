/**
 * Integration tests for browser-extension/background.js's prospective-site
 * capture driver (issue #705) — "sitios en evaluación".
 *
 * Same harness as extension-diagnostic-background.test.ts: background.js
 * loaded via Node's CommonJS `require` against a from-scratch chrome/self/
 * fetch stub, `importScripts` shimmed to `require()` the sibling files.
 *
 * The contracts pinned here are the ones a reading of the diff can't settle:
 *   • NOTHING is fetched from the candidate site. The only network call the
 *     driver makes is to the dashboard — the page comes out of a tab the
 *     operator's own browser rendered. This is what makes the path usable on
 *     the WAF-protected sites we have refused to build against.
 *   • The page goes to /api/extension/diagnostic, NEVER
 *     /api/extension/capture — no connector could normalise it, so it must
 *     never enter the ingest path.
 *   • Without a granted host permission nothing is opened at all, and the row
 *     is reported as an attempt (→ eventually `unreachable`), never captured.
 *   • The service worker never calls chrome.permissions.request itself (no
 *     user-activation signal — the popup does the asking).
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
    delete req.cache[req.resolve(path.join(EXT_DIR, file))];
  }
}

function makeStorageArea(store: Record<string, unknown>) {
  return {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    set: vi.fn(async (obj: Record<string, unknown>) => {
      Object.assign(store, obj);
    }),
    remove: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete store[k];
    },
  };
}

type UpdatedListener = (
  tabId: number,
  info: { status: string },
  tab: { url: string },
) => void;

function makeChromeMock(opts: { hasPermission?: boolean; capturedPage?: unknown } = {}) {
  const sync: Record<string, unknown> = {
    apiUrl: "http://localhost:4000",
    apiKey: "k",
    // Zero pacing so the jittered dwell doesn't slow the test; the pacing
    // itself is batch.js's, already covered by its own suite.
    batchPaceBaseMs: 500,
    batchPaceSpreadMs: 0,
  };
  const openedTabs: string[] = [];
  const updatedListeners: UpdatedListener[] = [];
  const chromeMock = {
    _openedTabs: openedTabs,
    storage: {
      local: makeStorageArea({}),
      session: makeStorageArea({}),
      sync: makeStorageArea(sync),
    },
    tabs: {
      create: vi.fn(async ({ url }: { url: string }) => {
        openedTabs.push(url);
        // Signal 'complete' on the NEXT tick, once the caller has attached its
        // waiter. Driven from here rather than from addListener so no timer
        // outlives the test that armed it (background.js registers a badge
        // listener on this same event at module load).
        setTimeout(() => {
          for (const fn of updatedListeners) fn(42, { status: "complete" }, { url });
        }, 0);
        return { id: 42 };
      }),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
      get: vi.fn(async () => ({})),
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () =>
        opts.capturedPage === undefined
          ? {
              html: "<html><body>ficha</body></html>",
              url: "https://www.ejemplo.test/inmueble/1",
              title: "Ficha",
              diagnostic: { extensionVersion: "0.19.0-test" },
            }
          : opts.capturedPage,
      ),
      // The driver waits for tabs.onUpdated{status:'complete'}; `tabs.create`
      // above fires these. The third argument matters: background.js's badge
      // listener is registered on this same event and dereferences `tab.url`.
      onUpdated: {
        addListener: vi.fn((fn: UpdatedListener) => {
          updatedListeners.push(fn);
        }),
        removeListener: vi.fn((fn: UpdatedListener) => {
          const i = updatedListeners.indexOf(fn);
          if (i >= 0) updatedListeners.splice(i, 1);
        }),
      },
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), get: vi.fn(async () => null), onAlarm: { addListener: vi.fn() } },
    runtime: {
      onMessage: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "0.19.0-test" }),
      lastError: undefined,
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setTitle: vi.fn() },
    scripting: {
      executeScript: vi.fn(async () => {}),
      registerContentScripts: vi.fn(async () => {}),
      unregisterContentScripts: vi.fn(async () => {}),
    },
    notifications: { create: vi.fn() },
    permissions: {
      contains: vi.fn(async (_p: { origins: string[] }) => opts.hasPermission !== false),
      request: vi.fn(async () => true),
    },
  };
  return chromeMock;
}

interface BackgroundModule {
  runAutoSpike: (items: { id: number; url: string }[]) => Promise<void>;
  captureSpikePage: (url: string) => Promise<boolean>;
  hasSpikePermission: (origin: string) => Promise<boolean>;
  spikeOriginsNeedingPermission: () => Promise<string[]>;
}

function loadBackground(
  chromeMock: ReturnType<typeof makeChromeMock>,
  fetchMock: (...args: never[]) => unknown,
): BackgroundModule {
  resetRequireCache();
  (globalThis as unknown as { self: unknown }).self = globalThis;
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  (globalThis as unknown as { importScripts: (...f: string[]) => void }).importScripts = (
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

type FetchMock = ReturnType<typeof okFetch>;

function okFetch() {
  // Typed with the real (url, init) signature so `mock.calls` isn't an empty
  // tuple — otherwise every `calls[i][1]` below needs an `as unknown` cast.
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    json: async () => ({ success: true, id: 5 }),
  }));
}

/**
 * The URLs the driver actually hit, minus background.js's two ambient
 * housekeeping calls: `/api/extension/heartbeat` (fired unconditionally at
 * module load and on every alarm tick) and `/api/extension/config` (the
 * badge's supported-host refresh, triggered by any tabs.onUpdated). Neither
 * belongs to this path; both would otherwise mask what it does.
 */
const AMBIENT = ["/api/extension/heartbeat", "/api/extension/config"];

function drivenUrls(fetchMock: FetchMock): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => !AMBIENT.some((a) => u.includes(a)));
}

const ITEM = { id: 3, url: "https://www.ejemplo.test/inmueble/1" };

describe("captureSpikePage — the candidate site is never fetched", () => {
  it("sends the rendered page to the DIAGNOSTIC endpoint and to nothing else", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const fetchMock = okFetch();
    const bg = loadBackground(chrome, fetchMock);

    expect(await bg.captureSpikePage(ITEM.url)).toBe(true);

    // Exactly one HTTP call, and it goes to our own dashboard.
    const urls = drivenUrls(fetchMock);
    expect(urls).toEqual(["http://localhost:4000/api/extension/diagnostic"]);
    // Never the ingest endpoint — a page with no connector must not become a
    // listing, nor an ingestion failure.
    expect(urls.some((u) => u.includes("/api/extension/capture"))).toBe(false);
    // The candidate site's own origin is never fetched: it is only ever
    // OPENED as a tab, which is the operator's own browsing.
    expect(urls.some((u) => u.includes("ejemplo.test"))).toBe(false);
    expect(chrome._openedTabs).toEqual([ITEM.url]);
  });

  it("closes the tab it opened, even when the page yields nothing", async () => {
    const chrome = makeChromeMock({ hasPermission: true, capturedPage: null });
    const bg = loadBackground(chrome, okFetch());

    expect(await bg.captureSpikePage(ITEM.url)).toBe(false);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(42);
  });

  it("opens NOTHING without the host permission", async () => {
    const chrome = makeChromeMock({ hasPermission: false });
    const fetchMock = okFetch();
    const bg = loadBackground(chrome, fetchMock);

    expect(await bg.captureSpikePage(ITEM.url)).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(drivenUrls(fetchMock)).toEqual([]);
    // The worker must never ask for the grant itself — Chrome requires a real
    // user gesture on an extension page, so the request would fail silently.
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it("injects detect/diagnostic/content-script on demand — a candidate host matches no static content_script", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    // First sendMessage throws (no content script yet), then succeeds.
    let firstCall = true;
    chrome.tabs.sendMessage = vi.fn(async () => {
      if (firstCall) {
        firstCall = false;
        throw new Error("Could not establish connection");
      }
      return { html: "<html>x</html>", url: ITEM.url, title: "t", diagnostic: null };
    });
    const bg = loadBackground(chrome, okFetch());

    expect(await bg.captureSpikePage(ITEM.url)).toBe(true);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ["detect.js", "diagnostic.js", "content-script.js"],
    });
  });
});

describe("runAutoSpike — per-item reporting", () => {
  it("reports an attempt only for items that produced no page", async () => {
    const chrome = makeChromeMock({ hasPermission: false });
    const fetchMock = okFetch();
    const bg = loadBackground(chrome, fetchMock);

    await bg.runAutoSpike([ITEM, { id: 4, url: "https://www.otro.test/x" }]);

    const patched = fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH");
    expect(patched).toHaveLength(2);
    expect(String(patched[0][0])).toBe("http://localhost:4000/api/etl/spike-queue/3");
    expect(JSON.parse(String(patched[0][1]?.body))).toEqual({ attempt: true });
  });

  it("does NOT report an attempt for a page that landed — the diagnostic route correlates it by match key", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const fetchMock = okFetch();
    const bg = loadBackground(chrome, fetchMock);

    await bg.runAutoSpike([ITEM]);

    const patched = fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH");
    expect(patched).toHaveLength(0);
  });

  it("skips a malformed item instead of throwing the whole unit away", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, okFetch());
    await expect(
      bg.runAutoSpike([{ id: 1 } as unknown as { id: number; url: string }, ITEM]),
    ).resolves.toBeUndefined();
    expect(chrome._openedTabs).toEqual([ITEM.url]);
  });
});

describe("spikeOriginsNeedingPermission", () => {
  it("returns only the pending origins that are not already granted", async () => {
    const chrome = makeChromeMock();
    chrome.permissions.contains = vi.fn(async ({ origins }: { origins: string[] }) =>
      origins[0].startsWith("https://granted."),
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        pendingOrigins: ["https://granted.test", "https://missing.test"],
      }),
    }));
    const bg = loadBackground(chrome, fetchMock);

    expect(await bg.spikeOriginsNeedingPermission()).toEqual(["https://missing.test"]);
  });

  it("returns an empty list when the dashboard is unreachable — never throws into the popup", async () => {
    const chrome = makeChromeMock();
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    const bg = loadBackground(chrome, fetchMock);
    expect(await bg.spikeOriginsNeedingPermission()).toEqual([]);
  });
});
