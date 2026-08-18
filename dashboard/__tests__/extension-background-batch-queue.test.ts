/**
 * Integration tests for browser-extension/background.js's pending-search
 * queue WIRING (issue #554 review — B1/N8).
 *
 * background.js is the imperative shell around Chrome's extension APIs and
 * has, until now, never been unit-tested — batch.js carries the pure state
 * machine and IS tested (extension-batch.test.ts). The #554 fresh-context
 * review found a REAL concurrency bug (B1) in exactly this wiring: the
 * handoff between clearing the 'enumerating' claim and persisting the new
 * capture state spans a NETWORK round trip
 * (`fetchPendingUrls`/`getBatchConfig`), during which `isBatchActive()` read
 * false — so a concurrently-arriving `startBatch`/`advanceQueueIfIdle` call
 * could CLAIM the run instead of queuing behind it, exactly the clobbering
 * bug #554 exists to fix. A prior version of this file's regression test
 * only proved that `enqueueSearch` doesn't mutate an unrelated `BatchState`
 * object — true of any two unrelated pure values, and not a reproduction of
 * the bug at all (it failed pre-fix only because the new batch.js exports
 * didn't exist yet, not because the OLD code exhibited the bug). This file
 * replaces that with real reproductions of the actual wiring.
 *
 * Approach: background.js is loaded via Node's CommonJS `require` (NOT
 * Vite's import graph) against a from-scratch `chrome`/`self`/`fetch` stub
 * installed on `globalThis`, so each test gets a byte-for-byte fresh module
 * instance (including its own `batchLooping`/`enumRunning` in-memory state) —
 * see `loadBackground()`. `importScripts` is shimmed to `require()` the
 * sibling files (detect.js/batch.js/capture-search-url.js/
 * observe-search-url.js) from the SAME stubbed `self`, exactly like the real
 * MV3 classic worker publishes `self.InmoDetect`/`self.InmoBatch`/etc.
 * `searchUrl: null` is used throughout to skip the results-page ENUMERATION
 * walk entirely (`enumerateResultsPages` returns immediately when `searchUrl`
 * is falsy) — that walk needs real tab rendering, which is out of scope
 * here; the handoff bug lives entirely in what happens AFTER enumeration,
 * which these tests exercise directly.
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

/** Bust Node's require cache for background.js + everything it importScripts. */
function resetRequireCache() {
  for (const file of SIBLING_FILES) {
    const resolved = req.resolve(path.join(EXT_DIR, file));
    delete req.cache[resolved];
  }
}

interface ChromeMock {
  storage: {
    session: StorageArea;
    sync: StorageArea;
  };
  tabs: Record<string, unknown>;
  alarms: Record<string, unknown>;
  runtime: Record<string, unknown>;
  action: Record<string, unknown>;
  scripting: Record<string, unknown>;
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
    // Wrapped in vi.fn() (issue #556 review N6) so tests can assert HOW MANY
    // storage writes a call caused, not just the resulting value — the N6 fix
    // is specifically about avoiding a redundant no-op write, which a
    // value-only assertion can't distinguish from "wrote the same value twice".
    set: vi.fn(async (obj: Record<string, unknown>) => {
      Object.assign(store, obj);
    }),
    remove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete store[k];
    },
  };
}

/** A minimal-but-real chrome mock: async storage areas, no-op everything else. */
function makeChromeMock(): ChromeMock {
  const session: Record<string, unknown> = {};
  const sync: Record<string, unknown> = {};
  let nextTabId = 1;
  return {
    storage: {
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
  };
}

type FetchResponse = { ok: boolean; json: () => Promise<unknown> };

/**
 * A `fetch` stub that understands just enough of the worklist API:
 *   - POST /api/etl/worklist (seedWorklist) → always succeeds.
 *   - GET  /api/etl/worklist?portal=X (fetchPendingUrls) → resolved via
 *     `pendingUrlsByPortal[X]()`, defaulting to an empty pending set.
 *   - anything else (heartbeat, search-url-example, …) → succeeds emptily;
 *     none of these are exercised when `searchUrl` is null throughout.
 */
function makeFetchMock(
  pendingUrlsByPortal: Record<string, () => Promise<{ rows: unknown[] }> | { rows: unknown[] }> = {},
) {
  return vi.fn(async (url: string, init?: { method?: string }): Promise<FetchResponse> => {
    const method = init?.method || "GET";
    if (url.includes("/api/etl/worklist") && method === "POST") {
      return { ok: true, json: async () => ({ success: true }) };
    }
    if (url.includes("/api/etl/worklist")) {
      const m = /portal=([^&]+)/.exec(url);
      const portal = m ? decodeURIComponent(m[1]) : "";
      const provider = pendingUrlsByPortal[portal];
      if (provider) {
        const result = await provider();
        return { ok: true, json: async () => result };
      }
      return { ok: true, json: async () => ({ rows: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

function makeDeferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface BackgroundModule {
  startBatch: (msg: {
    portal: string;
    urls: string[];
    searchUrl: string | null;
    queue?: { portal: string; searchUrl: string | null }[];
  }) => Promise<{ started?: boolean; queued?: boolean; queueDepth?: number; aheadCount?: number; total?: number }>;
  advanceQueueIfIdle: () => Promise<boolean>;
  runCaptureQueue: (portal: string, discoveredCount?: number) => Promise<unknown>;
  stopBatch: () => Promise<unknown>;
  reattachIfStranded: () => Promise<void>;
  isBatchActive: () => Promise<boolean>;
  getBatchState: () => Promise<{ status: string; emptyReason?: string | null } | null>;
  setBatchState: (state: unknown) => Promise<void>;
  getEnumState: () => Promise<{ portal?: string; status?: string } | null>;
  getSearchQueue: () => Promise<Array<{ portal: string; searchUrl: string | null; urls: string[] }>>;
  setSearchQueue: (queue: unknown[]) => Promise<void>;
}

/** Fresh-load background.js against a from-scratch chrome/self/fetch stub. */
function loadBackground(chromeMock: ChromeMock, fetchMock: ReturnType<typeof makeFetchMock>): BackgroundModule {
  resetRequireCache();
  // `self` must alias `globalThis` itself (not a separate object) — the real
  // MV3 service worker's `self` IS its global scope, so `self.InmoBatch = x`
  // there also makes bare `InmoBatch` resolve via global lookup, which
  // background.js relies on throughout (e.g. `InmoBatch.progress(...)`
  // without a `self.` prefix).
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
  // Published onto globalThis (== self, see loadBackground) by the sibling
  // scripts' own `if (typeof self !== "undefined") { self.X = api; }` — clean
  // up so a next test's fresh require() starts from a clean global scope.
  delete g.InmoDetect;
  delete g.InmoBatch;
  delete g.InmoSearchUrl;
  delete g.InmoObserve;
});

describe("B1 — the enum→capture handoff must stay claimed across the network round trip", () => {
  it("isBatchActive() reads true for the WHOLE fetchPendingUrls call, and a second search queues instead of clobbering", async () => {
    const deferredA = makeDeferred<{ rows: unknown[] }>();
    const chrome = makeChromeMock();
    const fetchMock = makeFetchMock({
      idealista: () => deferredA.promise,
    });
    const bg = loadBackground(chrome, fetchMock);

    const resA = await bg.startBatch({
      portal: "idealista",
      urls: ["https://www.idealista.com/inmueble/1/"],
      searchUrl: null,
    });
    expect(resA.started).toBe(true);

    // Let the fire-and-forget chain (beginRun → runEnumerationThenCapture →
    // runCaptureQueue) actually reach the fetchPendingUrls call before
    // probing state — poll rather than a fixed number of ticks, so this
    // isn't fragile to how many microtask hops the real chain needs.
    await vi.waitFor(() => {
      const reached = fetchMock.mock.calls.some(
        ([url]) => typeof url === "string" && url.includes("portal=idealista"),
      );
      if (!reached) throw new Error("fetchPendingUrls(idealista) not called yet");
    });

    // THE regression assertion — B1's exact invariant. Pre-fix this reads
    // false here (enum state already cleared, batch state not yet set,
    // batchLooping still false): nothing signals a run is active while the
    // network call is in flight.
    expect(await bg.isBatchActive()).toBe(true);

    // A second search fired NOW — while search A is stuck mid-handoff — must
    // queue, never claim a second run.
    const resB = await bg.startBatch({
      portal: "aliseda",
      urls: ["https://www.alisedainmobiliaria.com/x/"],
      searchUrl: null,
    });
    expect(resB.started).toBeFalsy();
    expect(resB.queued).toBe(true);

    const queueMidFlight = await bg.getSearchQueue();
    expect(queueMidFlight).toHaveLength(1);
    expect(queueMidFlight[0].portal).toBe("aliseda");

    // Release search A's fetch — let its handoff complete. Search A has
    // empty pending too, so its own run finishes essentially instantly and
    // its runBatchLoop `finally` will itself pop search B right away — so
    // the correctness signal here is NOT "B is still sitting in the queue"
    // (it may already have been cleanly popped) but "B's own handoff
    // eventually runs on its own terms" (fetchPendingUrls(aliseda) gets
    // called) rather than having been silently dropped or double-claimed.
    deferredA.resolve({ rows: [] });
    await vi.waitFor(() => {
      const reachedB = fetchMock.mock.calls.some(
        ([url]) => typeof url === "string" && url.includes("portal=aliseda"),
      );
      if (!reachedB) throw new Error("search B's own handoff never ran");
    });

    // Exactly ONE fetchPendingUrls(aliseda) call — never double-claimed by a
    // second, redundant advance racing the first.
    const alisedaCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === "string" && url.includes("portal=aliseda"),
    );
    expect(alisedaCalls).toHaveLength(1);

    // And the queue itself ends up empty — B was consumed exactly once, not
    // left behind or duplicated.
    await vi.waitFor(async () => {
      const queue = await bg.getSearchQueue();
      if (queue.length !== 0) throw new Error("queue did not settle empty");
    });
  });

  it("a natural completion (no eviction) auto-starts the next queued search via runBatchLoop's own finally", async () => {
    const deferredA = makeDeferred<{ rows: unknown[] }>();
    const chrome = makeChromeMock();
    const fetchMock = makeFetchMock({
      idealista: () => deferredA.promise,
      aliseda: () => ({ rows: [] }),
    });
    const bg = loadBackground(chrome, fetchMock);

    await bg.startBatch({
      portal: "idealista",
      urls: ["https://www.idealista.com/inmueble/1/"],
      searchUrl: null,
    });
    await vi.waitFor(() => {
      const reached = fetchMock.mock.calls.some(
        ([url]) => typeof url === "string" && url.includes("portal=idealista"),
      );
      if (!reached) throw new Error("fetchPendingUrls(idealista) not called yet");
    });

    const resB = await bg.startBatch({
      portal: "aliseda",
      urls: ["https://www.alisedainmobiliaria.com/x/"],
      searchUrl: null,
    });
    expect(resB.queued).toBe(true);

    deferredA.resolve({ rows: [] }); // search A drains (0 pending) and completes

    // Nothing external pokes the queue here — no reattachIfStranded call —
    // proving runBatchLoop's own `finally` is what advances it.
    await vi.waitFor(() => {
      const reachedB = fetchMock.mock.calls.some(
        ([url]) => typeof url === "string" && url.includes("portal=aliseda"),
      );
      if (!reachedB) throw new Error("aliseda's own handoff never started");
    });

    await vi.waitFor(async () => {
      const queue = await bg.getSearchQueue();
      if (queue.length !== 0) throw new Error("queue never drained");
    });
  });
});

describe("eviction recovery — the exit criterion: 'service-worker eviction between runs still resumes the queue'", () => {
  it("reattachIfStranded pops and starts a queued search stranded by an eviction between runs", async () => {
    const chrome = makeChromeMock();
    const fetchMock = makeFetchMock({}); // any portal → empty pending, resolves fast
    const bg = loadBackground(chrome, fetchMock);

    // Simulate exactly what a respawned worker finds: the previous run fully
    // finished (no batch state, no enum state — batchLooping is false in
    // this fresh module instance too), but a search is still waiting in the
    // queue, as if the worker died in the gap between "run finished" and
    // "advanceQueueIfIdle got to run" (issue #554's own framing of the risk).
    await bg.setSearchQueue([
      { portal: "idealista", searchUrl: null, urls: ["https://www.idealista.com/inmueble/9/"] },
    ]);
    expect(await bg.isBatchActive()).toBe(false); // nothing live, matching a fresh respawn

    await bg.reattachIfStranded();

    // Proof the resumed search actually got DRIVEN (not just dequeued and
    // dropped): its own fetchPendingUrls call must fire. isBatchActive()
    // alone isn't a reliable signal here — with empty pending (this test's
    // fetchMock) the whole handoff can settle back to idle within the same
    // tick, so "active" may already read false again by the time we check.
    await vi.waitFor(() => {
      const reached = fetchMock.mock.calls.some(
        ([url]) => typeof url === "string" && url.includes("portal=idealista"),
      );
      if (!reached) throw new Error("nothing picked up the resumed search");
    });
    await vi.waitFor(async () => {
      const queue = await bg.getSearchQueue();
      if (queue.length !== 0) throw new Error("queue was not resumed");
    });
  });
});

describe("same-portal drain reports cleanly through the real wiring (not just the pure predicate)", () => {
  it("runCaptureQueue classifies an empty pending set as already-captured when this search did discover something", async () => {
    const chrome = makeChromeMock();
    const fetchMock = makeFetchMock({
      idealista: () => ({ rows: [] }), // already drained by an earlier same-portal search
    });
    const bg = loadBackground(chrome, fetchMock);

    await bg.startBatch({
      portal: "idealista",
      urls: ["https://www.idealista.com/inmueble/1/", "https://www.idealista.com/inmueble/2/"],
      searchUrl: null,
    });

    await vi.waitFor(async () => {
      const state = await bg.getBatchState();
      if (!state || state.status !== "done") throw new Error("capture queue not settled yet");
    });

    const state = await bg.getBatchState();
    expect(state?.emptyReason).toBe("already-captured");
  });
});

describe("STOP_BATCH drains the whole pending-search queue", () => {
  it("stopBatch() empties the queue through the real wiring, not just clearSearchQueue() in isolation", async () => {
    const chrome = makeChromeMock();
    const fetchMock = makeFetchMock({});
    const bg = loadBackground(chrome, fetchMock);

    await bg.setSearchQueue([
      { portal: "idealista", searchUrl: null, urls: [] },
      { portal: "aliseda", searchUrl: null, urls: [] },
    ]);
    expect(await bg.getSearchQueue()).toHaveLength(2);

    await bg.stopBatch();

    expect(await bg.getSearchQueue()).toHaveLength(0);
  });
});

describe("startBatch's `queue` field — the dashboard's 'Capturar todo' handoff (issue #556)", () => {
  it("appends every `queue` entry BEHIND a search that gets itself queued (a run is already active)", async () => {
    const deferredA = makeDeferred<{ rows: unknown[] }>();
    const chrome = makeChromeMock();
    const fetchMock = makeFetchMock({ idealista: () => deferredA.promise });
    const bg = loadBackground(chrome, fetchMock);

    // Search A claims the run and gets stuck mid-handoff (same technique as
    // the B1 test above), so isBatchActive() reads true deterministically.
    await bg.startBatch({ portal: "idealista", urls: [], searchUrl: null });
    await vi.waitFor(() => {
      const reached = fetchMock.mock.calls.some(
        ([url]) => typeof url === "string" && url.includes("portal=idealista"),
      );
      if (!reached) throw new Error("fetchPendingUrls(idealista) not called yet");
    });
    expect(await bg.isBatchActive()).toBe(true);

    // The dashboard's batch button opened search B's tab and piggybacked TWO
    // more ticked tasks on it — everything must queue behind the live run,
    // in order: B, then the two `queue` entries.
    const resB = await bg.startBatch({
      portal: "aliseda",
      urls: [],
      searchUrl: "https://www.alisedainmobiliaria.com/venta",
      queue: [
        { portal: "altamira", searchUrl: "https://www.altamirainmuebles.com/venta" },
        { portal: "servihabitat", searchUrl: "https://www.servihabitat.com/venta" },
      ],
    });
    expect(resB.started).toBeFalsy();
    expect(resB.queued).toBe(true);

    const queue = await bg.getSearchQueue();
    expect(queue.map((e) => e.portal)).toEqual(["aliseda", "altamira", "servihabitat"]);

    deferredA.resolve({ rows: [] }); // let search A's stuck handoff finish, unblocking teardown
  });

  it("appends `queue` entries behind a search that CLAIMS the run (nothing was active)", async () => {
    const chrome = makeChromeMock();
    const fetchMock = makeFetchMock({}); // idealista pending resolves empty instantly
    const bg = loadBackground(chrome, fetchMock);

    // Nothing active: search A claims the run directly. Assert the queue
    // state the SAME critical section leaves behind before any fire-and-forget
    // enumeration/capture work can drain it — this holds deterministically
    // because the extra entries are enqueued synchronously inside the same
    // `runBatchStateExclusive` section that persists the 'enumerating' claim,
    // strictly before `beginRun`'s async chain is even started.
    const resA = await bg.startBatch({
      portal: "idealista",
      urls: [],
      searchUrl: null,
      queue: [{ portal: "aliseda", searchUrl: null }],
    });
    expect(resA.started).toBe(true);

    const queue = await bg.getSearchQueue();
    expect(queue.map((e) => e.portal)).toEqual(["aliseda"]);
  });

  it("drops a malformed `queue` entry (missing portal) without dropping the well-formed ones", async () => {
    const deferredA = makeDeferred<{ rows: unknown[] }>();
    const chrome = makeChromeMock();
    const fetchMock = makeFetchMock({ idealista: () => deferredA.promise });
    const bg = loadBackground(chrome, fetchMock);

    await bg.startBatch({ portal: "idealista", urls: [], searchUrl: null });
    await vi.waitFor(() => {
      const reached = fetchMock.mock.calls.some(
        ([url]) => typeof url === "string" && url.includes("portal=idealista"),
      );
      if (!reached) throw new Error("fetchPendingUrls(idealista) not called yet");
    });

    await bg.startBatch({
      portal: "aliseda",
      urls: [],
      searchUrl: null,
      // @ts-expect-error — deliberately malformed to exercise the drop path
      queue: [{ searchUrl: "https://x/y" }, { portal: "altamira", searchUrl: "https://x/z" }],
    });

    const queue = await bg.getSearchQueue();
    expect(queue.map((e) => e.portal)).toEqual(["aliseda", "altamira"]);

    deferredA.resolve({ rows: [] });
  });

  it("an absent `queue` field behaves exactly as before (byte-identical to the pre-#556 shape)", async () => {
    const chrome = makeChromeMock();
    const fetchMock = makeFetchMock({});
    const bg = loadBackground(chrome, fetchMock);

    const res = await bg.startBatch({ portal: "idealista", urls: [], searchUrl: null });
    expect(res.started).toBe(true);
    expect(await bg.getSearchQueue()).toEqual([]);
  });

  it("N6: an empty `queue` on a CLAIMED run skips the redundant chrome.storage.session write entirely", async () => {
    const chrome = makeChromeMock();
    const fetchMock = makeFetchMock({});
    const bg = loadBackground(chrome, fetchMock);
    const setSpy = chrome.storage.session.set as unknown as { mock: { calls: unknown[][] } };

    await bg.startBatch({ portal: "idealista", urls: [], searchUrl: null }); // no `queue` field at all
    // Only the enumerating-claim write (setEnumState) — no separate, no-op
    // setSearchQueue write on the hot (no-batch-button) path.
    expect(setSpy.mock.calls).toHaveLength(1);
  });

  it("a non-empty `queue` on a CLAIMED run still writes the queue exactly once", async () => {
    const chrome = makeChromeMock();
    const fetchMock = makeFetchMock({});
    const bg = loadBackground(chrome, fetchMock);
    const setSpy = chrome.storage.session.set as unknown as { mock: { calls: unknown[][] } };

    await bg.startBatch({
      portal: "idealista",
      urls: [],
      searchUrl: null,
      queue: [{ portal: "aliseda", searchUrl: null }],
    });
    // setSearchQueue (the extra entry) + setEnumState (the claim) — exactly 2.
    expect(setSpy.mock.calls).toHaveLength(2);
    expect(await bg.getSearchQueue()).toHaveLength(1);
  });
});
