/**
 * Integration tests for browser-extension/background.js's block/challenge
 * response (issue #634): detect a CAPTCHA/WAF page, stop the run, alert
 * exactly once per episode, report it, and self-heal on a real capture.
 *
 * Hardened per a fresh-context review that found three BLOCKERS in the first
 * cut of this file:
 *   B2 — handleBlockDetected's read-modify-write had no serializer, so
 *        CONCURRENT detections (the normal case under D-043's concurrency —
 *        a WAF flip is per-egress-IP, every in-flight tab renders the
 *        challenge within milliseconds of each other) could all read the
 *        same "not active" snapshot and fire N notifications for one
 *        episode. The fix wraps the record in runBatchStateExclusive, same
 *        as every other shared-state mutation in background.js.
 *   B3 — the two most safety-critical paths (the post-enumeration paused-
 *        batch branch, and clearBlockIfActive actually firing off the real
 *        EXTRACT message dispatch rather than being called directly) had NO
 *        test that could fail if either was deleted. This file now drives
 *        both through the REAL code paths (a real chrome.tabs.create/
 *        onUpdated/sendMessage-driven enumeration walk; the REAL registered
 *        onMessage listener for EXTRACT) rather than calling the exported
 *        function directly.
 *   B4 — the pause used to be portal-UNCONDITIONAL (any block, on any tab,
 *        paused whatever batch happened to be looping) even though the
 *        episode itself is per-portal — an idealista challenge in a manual
 *        tab could pause an unrelated aliseda run. Now scoped via the
 *        batch state's own `portal` field.
 * Plus the TTL/reported-retry/onClicked follow-ups from the same review.
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

type TabUpdatedListener = (
  tabId: number,
  info: { status?: string },
  tab: { id: number; url?: string },
) => void;
type OnMessageListener = (
  msg: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (res: unknown) => void,
) => boolean | void;
type NotificationClickListener = (notificationId: string) => void;

function makeChromeMock() {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const sync: Record<string, unknown> = {};
  let nextTabId = 1;
  const onUpdatedListeners: TabUpdatedListener[] = [];
  const onMessageListeners: OnMessageListener[] = [];
  const onNotificationClicked: NotificationClickListener[] = [];

  return {
    storage: {
      local: makeStorageArea(local),
      session: makeStorageArea(session),
      sync: makeStorageArea(sync),
    },
    tabs: {
      create: vi.fn(async (opts: { url?: string }) => {
        const id = nextTabId++;
        const tab = { id, url: opts?.url };
        // Auto-complete on the next MACROtask (setTimeout(0), not
        // queueMicrotask) so waitTabComplete (the enumeration walk's own
        // wait) resolves without a real navigation. A microtask queued here
        // would run BEFORE the caller's `await chrome.tabs.create(...)` even
        // resumes — i.e. before waitTabComplete has registered its
        // onUpdated listener — and fire uselessly against an empty listener
        // array; setTimeout(0) always runs after that registration.
        // Capture's own wait (waitForCaptureSignal) is keyed on
        // AUTO_CAPTURE_DONE messages, not onUpdated, so this is inert for
        // every capture-path test.
        setTimeout(() => {
          for (const l of onUpdatedListeners) l(id, { status: "complete" }, tab);
        }, 0);
        return tab;
      }),
      update: vi.fn(async (tabId: number, opts: { url?: string }) => {
        setTimeout(() => {
          for (const l of onUpdatedListeners) l(tabId, { status: "complete" }, { id: tabId, url: opts?.url });
        }, 0);
        return {};
      }),
      remove: vi.fn(async () => {}),
      get: vi.fn(async () => ({})),
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => null),
      onUpdated: {
        addListener: vi.fn((l: TabUpdatedListener) => onUpdatedListeners.push(l)),
        removeListener: vi.fn((l: TabUpdatedListener) => {
          const i = onUpdatedListeners.indexOf(l);
          if (i !== -1) onUpdatedListeners.splice(i, 1);
        }),
      },
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: vi.fn() },
    },
    runtime: {
      onMessage: {
        addListener: vi.fn((l: OnMessageListener) => onMessageListeners.push(l)),
      },
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
      clear: vi.fn(),
      onClicked: {
        addListener: vi.fn((l: NotificationClickListener) => onNotificationClicked.push(l)),
      },
    },
    // Test-only escape hatches (not part of the real chrome.* API) so a test
    // can dispatch a real onMessage/onClicked event through the ACTUAL
    // listener background.js registered, rather than calling an exported
    // function directly (issue #634 review B3 — a direct call proves the
    // function works, never that the wiring that invokes it in production
    // still does).
    __dispatchMessage(msg: Record<string, unknown>): Promise<unknown> {
      return new Promise((resolve) => {
        for (const l of onMessageListeners) {
          const handled = l(msg, {}, (res) => resolve(res));
          if (handled) return;
        }
        resolve(undefined);
      });
    },
    __clickNotification(notificationId: string): void {
      for (const l of onNotificationClicked) l(notificationId);
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
    queue?: unknown[];
  }) => Promise<unknown>;
  runCaptureQueue: (portal: string, discoveredCount?: number) => Promise<unknown>;
  runEnumerationThenCapture: (
    portal: string,
    searchUrl: string | null,
    page1Urls: string[],
  ) => Promise<void>;
  runBatchLoop: () => Promise<void>;
  runBatchStateExclusive: <T>(fn: () => Promise<T> | T) => Promise<T>;
  handleBlockDetected: (portal: string, signature: string) => Promise<void>;
  tryReportBlockEpisode: (portal: string, signature: string, detectedAt: number) => Promise<void>;
  clearBlockIfActive: (portal: string) => Promise<void>;
  getBlockState: () => Promise<
    Record<string, { active: boolean; signature: string; detectedAt: number; reported: boolean }>
  >;
  setBlockState: (state: unknown) => Promise<void>;
  isPortalBlocked: (portal: string) => Promise<boolean>;
  activeBlockSummary: () => Promise<{ portal: string; signature: string; detectedAt: number } | null>;
  getBatchState: () => Promise<{ status: string; portal?: string | null } | null>;
  setBatchState: (s: unknown) => Promise<void>;
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

  it("review B2 — N CONCURRENT detections (the normal case: a WAF flip is per-egress-IP, every in-flight D-043 tab renders it within milliseconds) still notify/report exactly once", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    // D-043's hard concurrency cap is 8 — fire 8 truly concurrent detections
    // (no await between them) the way 8 simultaneously-rendering tabs would.
    await Promise.all(
      Array.from({ length: 8 }, () => bg.handleBlockDetected("idealista", "captcha_wall")),
    );

    // Fails red without runBatchStateExclusive serializing the
    // recordBlock read-modify-write: without it, all 8 calls read the same
    // "not active" snapshot and all decide isNewEpisode:true.
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
      makeBatchState: (
        urls: string[],
        concurrency: number,
        emptyReason?: string,
        portal?: string,
      ) => { urls: string[]; status: string };
    };
    const running = InmoBatch.makeBatchState(
      ["https://www.idealista.com/inmueble/1/", "https://www.idealista.com/inmueble/2/"],
      3,
      undefined,
      "idealista",
    );
    await bg.setBatchState(running);

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
    // genuinely true for the whole window (same deferred-fetch technique as
    // extension-background-batch-queue.test.ts's own B1 test).
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
      // And the pause was correctly attributed to the SAME portal that's
      // actually running (review B4's cross-portal guard doesn't accidentally
      // suppress the on-portal case).
      expect(pausedState?.portal).toBe("idealista");

      // Let the in-flight tab's 30s capture-signal wait time out so the loop
      // can exit cleanly and the test doesn't leak a live driver.
      await vi.advanceTimersByTimeAsync(31000);
      await loopPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("review B4 — a block on a DIFFERENT portal than the one actually looping must NOT pause it (cross-portal collateral)", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
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
      // An aliseda batch is genuinely looping (same technique as the test
      // above), then an idealista challenge is detected in an unrelated
      // manual tab — checkForBlock runs on EVERY render, including one that
      // has nothing to do with the run currently in flight.
      const loopPromise = bg.runCaptureQueue("aliseda", 1);
      await Promise.resolve();
      resolvePending({
        rows: [{ url: "https://www.alisedainmobiliaria.com/inmueble/1", status: "pending" }],
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      await bg.handleBlockDetected("idealista", "captcha_wall");
      const state = await bg.getBatchState();
      // Fails red if the pause is portal-unconditional: the aliseda run must
      // stay RUNNING — an idealista block is not this run's problem.
      expect(state?.status).toBe("running");
      expect(state?.portal).toBe("aliseda");
      // The idealista episode itself is still recorded/alerted — only the
      // (unrelated) pause is what's scoped away.
      expect(await bg.isPortalBlocked("idealista")).toBe(true);
      expect(chrome.notifications.create).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(31000);
      await loopPromise;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("review B3 — the post-enumeration paused-batch branch, driven through the REAL enumeration walk", () => {
  it("a block detected mid-walk (after page 1 already harvested something) stops page 2 from ever rendering and never opens a capture tab", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    let discoverPending: Array<{ url: string; status: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method || "GET";
      if (String(url).includes("/api/etl/worklist") && method === "POST") {
        // seedWorklist: remember what enumeration harvested so the later
        // fetchPendingUrls (inside the blocked branch) can return it.
        const body = JSON.parse((init as { body?: string })?.body || "{}");
        discoverPending = (body.urls || []).map((u: string) => ({ url: u, status: "pending" }));
        return { ok: true, json: async () => ({ success: true }) };
      }
      if (String(url).includes("/api/etl/worklist")) {
        return { ok: true, json: async () => ({ rows: discoverPending }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const bg = loadBackground(chrome, fetchMock);

    // Page 1 renders fine, harvests one detail URL, AND points at a page 2 —
    // then, on that SAME tab, the content script's checkForBlock also fires
    // (both signals can legitimately come from the same render). A page-2
    // harvest is recorded too, so the assertion below has something real to
    // fail against if the block failed to stop the walk.
    let harvestCalls = 0;
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tabId: number, msg: { type: string }) => {
        if (msg.type !== "HARVEST_LISTING_PAGE") return null;
        harvestCalls++;
        if (harvestCalls === 1) {
          await bg.handleBlockDetected("aliseda", "geetest_challenge");
          (chrome.notifications.create as ReturnType<typeof vi.fn>).mockClear();
          return {
            portal: "aliseda",
            detailUrls: ["https://www.alisedainmobiliaria.com/inmueble/1"],
            nextUrl: "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos?pagina=2",
          };
        }
        return {
          portal: "aliseda",
          detailUrls: ["https://www.alisedainmobiliaria.com/inmueble/2"],
          nextUrl: null,
        };
      },
    );

    // Called DIRECTLY (not via startBatch, which fires this same function
    // off WITHOUT awaiting it — "click once", matching production) so the
    // test can await the real enumeration→blocked-branch chain to full
    // completion instead of guessing how many microtask ticks it needs;
    // an under-awaited guess would leave a dangling promise that keeps
    // running into a LATER test, after that later test's own chrome/fetch
    // mocks have been torn down. Mirrors what startBatch's claim step does
    // before invoking it (seed the 'enumerating' claim first).
    await bg.setEnumState({ status: "enumerating", portal: "aliseda", discovered: 0, page: 1 });
    // Between page 1 and a would-be page 2 the walk sleeps a real, jittered
    // pace (D-043's WAF-safety stagger) — fake timers + advanceTimersByTimeAsync
    // (which also flushes the microtask-driven render/harvest/seed work in
    // between) carry the whole chain through without a multi-second real wait.
    vi.useFakeTimers();
    try {
      const enumPromise = bg.runEnumerationThenCapture(
        "aliseda",
        "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos",
        [],
      );
      await vi.advanceTimersByTimeAsync(20000);
      await enumPromise;
    } finally {
      vi.useRealTimers();
    }

    // The load-bearing assertions (issue #634 review B3):
    //   1. Page 2 is NEVER harvested — the walk's own next-iteration
    //      enumerationStopped(portal) check catches the block. Fails red if
    //      the enumerationStopped(portal) extension is reverted to ignore
    //      the portal argument.
    expect(harvestCalls).toBe(1);
    expect(chrome.tabs.update).not.toHaveBeenCalled(); // page 2 would reuse the tab via update()
    //   2. No CAPTURE tab is ever opened for the URL page 1 already seeded —
    //      only the one enumeration-render tab. Fails red if the blocked
    //      branch is deleted (it would fall through to runCaptureQueue,
    //      which opens a capture tab per pending URL).
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);

    const state = await bg.getBatchState();
    expect(state?.status).toBe("paused");
    expect(state?.portal).toBe("aliseda");
    expect(state?.urls).toEqual(["https://www.alisedainmobiliaria.com/inmueble/1"]);
  });
});

describe("review B3 — clearBlockIfActive fires through the REAL EXTRACT message dispatch", () => {
  it("a successful EXTRACT for a blocked portal's URL resolves the episode via the actual onMessage listener", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/extension/capture")) {
        return { ok: true, json: async () => ({ success: true, capture_id: 1 }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const bg = loadBackground(chrome, fetchMock);

    await bg.handleBlockDetected("idealista", "captcha_wall");
    expect(await bg.isPortalBlocked("idealista")).toBe(true);

    // Dispatch through the REAL registered chrome.runtime.onMessage listener
    // — NOT a direct call to clearBlockIfActive. Fails red if the EXTRACT
    // handler's success branch stops calling clearBlockIfActive.
    const res = await chrome.__dispatchMessage({
      type: "EXTRACT",
      url: "https://www.idealista.com/inmueble/123456/",
      html: "<html></html>",
    });
    expect((res as { success?: boolean })?.success).toBe(true);
    // The EXTRACT handler calls sendResponse() synchronously alongside (not
    // after) its fire-and-forget clearBlockIfActive — flush microtasks so
    // that async work actually lands before asserting on it.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(await bg.isPortalBlocked("idealista")).toBe(false);
  });

  it("a FAILED EXTRACT does not clear the episode", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/extension/capture")) {
        return { ok: false, json: async () => ({ error: { message: "still blocked" } }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const bg = loadBackground(chrome, fetchMock);

    await bg.handleBlockDetected("idealista", "captcha_wall");

    await chrome.__dispatchMessage({
      type: "EXTRACT",
      url: "https://www.idealista.com/inmueble/123456/",
      html: "<html></html>",
    });
    expect(await bg.isPortalBlocked("idealista")).toBe(true);
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

describe("a dropped dashboard report is retried, not lost forever (issue #634 review)", () => {
  it("retries the POST on the next detection while unreported, without a second local notification", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    let failReport = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/extension/block-episode")) {
        if (failReport) return { ok: false, json: async () => ({ error: {} }) };
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const bg = loadBackground(chrome, fetchMock);

    await bg.handleBlockDetected("idealista", "captcha_wall");
    let state = await bg.getBlockState();
    expect(state.idealista.reported).toBe(false);
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);

    // The report starts succeeding; a REPEAT detection (still the same
    // active episode) is what triggers the retry.
    failReport = false;
    await bg.handleBlockDetected("idealista", "captcha_wall");

    state = await bg.getBlockState();
    expect(state.idealista.reported).toBe(true);
    // Still exactly one notification — the retry must never re-alert.
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    const reportCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/api/extension/block-episode"),
    );
    expect(reportCalls).toHaveLength(2); // the failed attempt + the retry
  });
});

describe("chrome.notifications.onClicked — the alert is not a dead end (issue #634 review)", () => {
  it("clicking a block notification opens /etl/salud", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = makeFetchMock();
    loadBackground(chrome, fetchMock);

    chrome.__clickNotification("inmo-block-idealista-123456");
    await new Promise((r) => setTimeout(r, 0));

    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://localhost:4000/etl/salud" }),
    );
  });

  it("ignores a click on an unrelated notification id", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = makeFetchMock();
    loadBackground(chrome, fetchMock);

    chrome.__clickNotification("some-other-notification");
    await new Promise((r) => setTimeout(r, 0));

    expect(chrome.tabs.create).not.toHaveBeenCalled();
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

  it("blocked is null once the episode expires past its TTL — Auto is not silenced forever", async () => {
    const chrome = makeChromeMock();
    await configureApiKey(chrome);
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    const InmoBatch = req(path.join(EXT_DIR, "batch.js")) as { BLOCK_EPISODE_TTL_MS: number };
    const longAgo = Date.now() - InmoBatch.BLOCK_EPISODE_TTL_MS - 1000;
    await bg.setBlockState({
      idealista: { active: true, signature: "captcha_wall", detectedAt: longAgo, reported: true },
    });

    const progress = await bg.getAutoProgress();
    expect(progress.blocked).toBeNull();
    expect(await bg.isPortalBlocked("idealista")).toBe(false);
  });
});
