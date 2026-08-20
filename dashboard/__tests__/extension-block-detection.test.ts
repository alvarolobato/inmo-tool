/**
 * Integration tests for browser-extension/background.js's block/challenge
 * response (issue #634): detect a CAPTCHA/WAF page, stop the run, alert
 * exactly once per episode, report it, and self-heal on a real capture.
 *
 * Same harness pattern as extension-background-batch-queue.test.ts: fresh
 * `require()` of background.js against a from-scratch chrome/self/fetch
 * stub, so each test gets its own in-memory state (batchLooping, etc.).
 * `importScripts` is shimmed to `require()` the sibling pure modules
 * (detect.js/batch.js/…) from the same stubbed `self`.
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

function makeChromeMock() {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const sync: Record<string, unknown> = {};
  let nextTabId = 1;
  return {
    storage: {
      local: makeStorageArea(local),
      session: makeStorageArea(session),
      sync: makeStorageArea(sync),
    },
    tabs: {
      create: vi.fn(async (opts: { url?: string }) => ({ id: nextTabId++, url: opts?.url })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
      get: vi.fn(async () => ({})),
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => null),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: vi.fn() },
    },
    runtime: {
      onMessage: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "0.0.0-test" }),
      lastError: undefined,
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
      setTitle: vi.fn(),
    },
    scripting: {
      executeScript: vi.fn(async () => {}),
    },
    notifications: {
      create: vi.fn(),
    },
  };
}

type FetchResponse = { ok: boolean; json: () => Promise<unknown> };

function makeFetchMock() {
  return vi.fn(async (): Promise<FetchResponse> => {
    return { ok: true, json: async () => ({ ok: true }) };
  });
}

interface BackgroundModule {
  startBatch: (msg: {
    portal: string;
    urls: string[];
    searchUrl: string | null;
  }) => Promise<unknown>;
  runBatchLoop: () => Promise<void>;
  handleBlockDetected: (portal: string, signature: string) => Promise<void>;
  clearBlockIfActive: (portal: string) => Promise<void>;
  getBlockState: () => Promise<Record<string, { active: boolean; signature: string; detectedAt: number }>>;
  isPortalBlocked: (portal: string) => Promise<boolean>;
  activeBlockSummary: () => Promise<{ portal: string; signature: string; detectedAt: number } | null>;
  getBatchState: () => Promise<{ status: string } | null>;
  getAutoProgress: () => Promise<{ blocked: unknown }>;
}

function loadBackground(
  chromeMock: ReturnType<typeof makeChromeMock>,
  fetchMock: ReturnType<typeof makeFetchMock>,
): BackgroundModule {
  resetRequireCache();
  (globalThis as unknown as { self: unknown }).self = globalThis;
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  (globalThis as unknown as { importScripts: (...files: string[]) => void }).importScripts = (
    ...files: string[]
  ) => {
    for (const file of files) {
      req(path.join(EXT_DIR, file));
    }
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
});

async function configureApiKey(chrome: ReturnType<typeof makeChromeMock>) {
  await chrome.storage.sync.set({ apiUrl: "http://localhost:4000", apiKey: "test-key" });
}

describe("handleBlockDetected — stop, alert once, report (issue #634)", () => {
  it("a new episode notifies exactly once and reports to the dashboard", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    await bg.handleBlockDetected("idealista", "captcha_wall");

    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    const reportCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/api/extension/block-episode"),
    );
    expect(reportCalls).toHaveLength(1);
    const body = JSON.parse((reportCalls[0][1] as { body: string }).body);
    expect(body.portal).toBe("idealista");
    expect(body.signature).toBe("captcha_wall");

    const blocked = await bg.isPortalBlocked("idealista");
    expect(blocked).toBe(true);
  });

  it("a REPEAT detection for the SAME still-active episode does NOT notify or report again — one alert per episode, not per tab", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    await bg.handleBlockDetected("idealista", "captcha_wall");
    await bg.handleBlockDetected("idealista", "captcha_wall");
    await bg.handleBlockDetected("idealista", "captcha_wall");

    // This is the exact assertion that fails red if the isNewEpisode gate in
    // batch.js's recordBlock (or the `if (!isNewEpisode) return;` short
    // circuit in handleBlockDetected) is removed — proving the test can fail.
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    const reportCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/api/extension/block-episode"),
    );
    expect(reportCalls).toHaveLength(1);
  });

  it("never drains a live run — every pending/inflight URL survives a block, so a resume picks up exactly where it left off", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    const InmoBatch = req(path.join(EXT_DIR, "batch.js")) as {
      makeBatchState: (urls: string[], concurrency: number) => { urls: string[]; status: string };
    };
    const running = InmoBatch.makeBatchState(
      ["https://www.idealista.com/inmueble/1/", "https://www.idealista.com/inmueble/2/"],
      3,
    );
    const bgWrite = req(path.join(EXT_DIR, "background.js")) as unknown as {
      setBatchState: (s: unknown) => Promise<void>;
    };
    await bgWrite.setBatchState(running);

    await bg.handleBlockDetected("idealista", "captcha_wall");

    const state = await bg.getBatchState();
    // The two URLs are still exactly there (not cleared/reset) and the queue
    // was never stopped — this is the assertion that fails red if
    // handleBlockDetected called InmoBatch.stop (or STOP_BATCH's queue-drain)
    // instead of pause: stop() flips status to 'done' but leaves `urls` alone
    // too, so the REAL discriminator a regression would trip is `status`
    // becoming 'done' with no batch loop having ever run to legitimately
    // finish it.
    expect(state?.urls).toEqual([
      "https://www.idealista.com/inmueble/1/",
      "https://www.idealista.com/inmueble/2/",
    ]);
    expect(state?.status).not.toBe("done");
  });

  it("a block while the driver is ACTUALLY looping flips the persisted status to 'paused' (not just left alone)", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    // The pending-urls fetch never resolves during this test — the run stays
    // open on a real tab-capture wait the whole time, so batchLooping is
    // genuinely true for the whole window (same shape as
    // extension-background-batch-queue.test.ts's own B1 deferred-fetch
    // technique, reused here to keep the driver alive without needing a real
    // browser tab to settle).
    let resolvePending!: (v: { rows: unknown[] }) => void;
    const pendingPromise = new Promise<{ rows: unknown[] }>((res) => {
      resolvePending = res;
    });
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method || "GET";
      if (String(url).includes("/api/etl/worklist") && method !== "POST") {
        const result = await pendingPromise;
        return { ok: true, json: async () => result };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const bg = loadBackground(chrome, fetchMock);

    vi.useFakeTimers();
    try {
      // Kick off a capture queue the same way runEnumerationThenCapture's
      // happy path does: fetchPendingUrls → makeBatchState → runBatchLoop.
      // The fetch above is deliberately still pending, so nothing has
      // launched a tab yet — batchLooping is already true (set synchronously
      // at the top of runBatchLoop, before any await).
      const loopPromise = bg.runCaptureQueue("idealista", 1);
      await Promise.resolve(); // let runCaptureQueue's synchronous prefix run
      resolvePending({
        rows: [{ url: "https://www.idealista.com/inmueble/1/", status: "pending" }],
      });
      // Let the loop launch its one tab and reach the real (now-fake) 30s wait.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      await bg.handleBlockDetected("idealista", "captcha_wall");
      const pausedState = await bg.getBatchState();
      expect(pausedState?.status).toBe("paused");

      // Let the in-flight tab's 30s capture-signal wait time out so the loop
      // can exit cleanly and the test doesn't leak a live driver.
      await vi.advanceTimersByTimeAsync(31000);
      await loopPromise;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clearBlockIfActive — a real capture resolves the episode", () => {
  it("clears an active block so the NEXT detection is treated as a fresh episode", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    await bg.handleBlockDetected("idealista", "captcha_wall");
    expect(await bg.isPortalBlocked("idealista")).toBe(true);

    await bg.clearBlockIfActive("idealista");
    expect(await bg.isPortalBlocked("idealista")).toBe(false);

    // A fresh detection after clearing notifies AGAIN (it's a new episode).
    await bg.handleBlockDetected("idealista", "captcha_wall");
    expect(chrome.notifications.create).toHaveBeenCalledTimes(2);
  });

  it("clearing a portal with no active block is a silent no-op", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    await expect(bg.clearBlockIfActive("aliseda")).resolves.toBeUndefined();
    expect(await bg.isPortalBlocked("aliseda")).toBe(false);
  });
});

describe("getAutoProgress — the popup's armed-status line must see an active block", () => {
  it("surfaces the active episode regardless of whether Auto is on", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    await bg.handleBlockDetected("aliseda", "geetest_challenge");
    const progress = await bg.getAutoProgress();
    expect(progress.blocked).toEqual(
      expect.objectContaining({ portal: "aliseda", signature: "geetest_challenge" }),
    );
  });

  it("blocked is null when nothing is blocked — the popup shows its normal ON/OFF line", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    const progress = await bg.getAutoProgress();
    expect(progress.blocked).toBeNull();
  });
});
