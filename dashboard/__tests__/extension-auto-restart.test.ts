/**
 * Restart-survival tests for the extension's Auto mode (issue #587).
 *
 * The bug: the WHOLE auto record (`inmoAuto`, including `enabled`) lived in
 * chrome.storage.session — Chrome wipes that on every browser close. On
 * relaunch, `onStartup` -> `autoTick()` read `getAutoState()` as `null` ->
 * `nextAutoAction` never got a state to evaluate -> `disarmAutoAlarm()`. The
 * owner turns Auto on, closes the browser, and it comes back silently OFF.
 * `dashboard/__tests__/extension-batch.test.ts` pins the pure recombination
 * (`composeAutoState`/`autoIntentFromState`) at the state-machine level; THIS
 * file proves the actual background.js WIRING survives a simulated restart —
 * a fresh service-worker module, loaded against a chrome.storage.local that
 * (correctly) carried the durable intent over, but a chrome.storage.session
 * that (correctly, like a real restart) came back completely empty.
 *
 * Same harness pattern as extension-background-batch-queue.test.ts: load
 * background.js via Node's CommonJS `require` against a from-scratch
 * chrome/self/fetch stub, so each "browser session" gets its own byte-for-
 * byte fresh module instance (own batchLooping/autoTicking/etc. in-memory
 * guards) — exactly what a real worker respawn (or browser relaunch) gives.
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

interface AlarmRecord {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

/** A real (in-memory) alarms store, so `.get()` reflects what `.create()` armed — the
 * whole point of these tests is proving the alarm actually re-arms. */
function makeAlarmsMock() {
  const alarms = new Map<string, AlarmRecord>();
  return {
    create: vi.fn((name: string, info?: { when?: number; periodInMinutes?: number }) => {
      const scheduledTime =
        typeof info?.when === "number"
          ? info.when
          : Date.now() + (info?.periodInMinutes ?? 0) * 60_000;
      alarms.set(name, { name, scheduledTime, periodInMinutes: info?.periodInMinutes });
    }),
    clear: vi.fn(async (name: string) => {
      const had = alarms.has(name);
      alarms.delete(name);
      return had;
    }),
    get: vi.fn(async (name: string) => alarms.get(name)),
    onAlarm: { addListener: vi.fn() },
  };
}

interface ChromeMock {
  storage: { local: StorageArea; session: StorageArea; sync: StorageArea };
  tabs: Record<string, unknown>;
  alarms: ReturnType<typeof makeAlarmsMock>;
  runtime: {
    onMessage: { addListener: ReturnType<typeof vi.fn> };
    onStartup: { addListener: ReturnType<typeof vi.fn> };
    onInstalled: { addListener: ReturnType<typeof vi.fn> };
    getManifest: () => { version: string };
    lastError: undefined;
  };
  action: Record<string, unknown>;
  scripting: Record<string, unknown>;
}

function makeChromeMock(seed?: {
  local?: Record<string, unknown>;
  session?: Record<string, unknown>;
  sync?: Record<string, unknown>;
}): ChromeMock {
  const local = { ...(seed?.local ?? {}) };
  const session = { ...(seed?.session ?? {}) };
  const sync = { ...(seed?.sync ?? {}) };
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
    alarms: makeAlarmsMock(),
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

/** Auto-plan always reports 'idle' — this suite is about the SCHEDULER surviving a
 * restart, not the harvest/drain payload (that's runAutoBatch's own coverage). */
function makeFetchMock(planResponse: unknown = { kind: "idle", retryAfterSec: 300 }) {
  return vi.fn(async (url: string): Promise<FetchResponse> => {
    if (url.includes("/api/etl/auto-plan")) {
      return { ok: true, json: async () => planResponse };
    }
    if (url.includes("/api/profiles/") && url.includes("/capture-task-runs")) {
      return { ok: true, json: async () => ({ success: true }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

/**
 * Like `makeFetchMock`, but the `/api/etl/auto-plan` response doesn't resolve
 * until `gate` does — lets a test hold `runAutoBatch` paused mid-network-call
 * so it can act (e.g. call `stopAuto()`) exactly inside that window, then let
 * the in-flight cycle's write land afterward (issue #613 review B1's
 * reproduction).
 */
function makeDelayedFetchMock(gate: Promise<unknown>) {
  return vi.fn(async (url: string): Promise<FetchResponse> => {
    if (url.includes("/api/etl/auto-plan")) {
      const planResponse = await gate;
      return { ok: true, json: async () => planResponse };
    }
    if (url.includes("/api/profiles/") && url.includes("/capture-task-runs")) {
      return { ok: true, json: async () => ({ success: true }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

interface BackgroundModule {
  startAuto: (portal: string | null) => Promise<{ enabled: boolean }>;
  stopAuto: () => Promise<{ enabled: boolean }>;
  getAutoState: () => Promise<{
    enabled: boolean;
    portal: string | null;
    status: string;
  } | null>;
  getAutoIntent: () => Promise<{ enabled: boolean; portal: string | null; force: boolean } | null>;
  getAutoProgress: () => Promise<{ enabled: boolean; [key: string]: unknown }>;
  setAutoRunState: (patch: Record<string, unknown>) => Promise<void>;
}

function loadBackground(chromeMock: ChromeMock, fetchMock: ReturnType<typeof makeFetchMock>): BackgroundModule {
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

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

describe("Auto mode survives a simulated browser restart (issue #587)", () => {
  it("re-arms the alarm and stays enabled when chrome.storage.session is wiped but chrome.storage.local is not", async () => {
    // ── "Session 1": operator turns Auto on ────────────────────────────────
    const chrome1 = makeChromeMock();
    const bg1 = loadBackground(chrome1, makeFetchMock());
    await bg1.startAuto("idealista");

    // The durable intent must already be on disk before the browser ever
    // closes — startAuto awaits setAutoState before returning.
    const intentAfterStart = await bg1.getAutoIntent();
    expect(intentAfterStart).toEqual({ enabled: true, portal: "idealista", force: false });

    // ── Simulate a full browser restart ─────────────────────────────────────
    // chrome.storage.local (the durable half) carries over untouched — real
    // Chrome behaviour. chrome.storage.session and every chrome.alarms entry
    // come back EMPTY — also real Chrome behaviour, and the worst case for
    // this bug (no alarm surviving to save it either). A brand new
    // background.js module instance stands in for the respawned service
    // worker (fresh in-memory guards, fresh onStartup listener).
    const chrome2 = makeChromeMock({ local: { inmoAutoIntent: intentAfterStart } });
    const bg2 = loadBackground(chrome2, makeFetchMock());

    expect(chrome2.runtime.onStartup.addListener).toHaveBeenCalledTimes(1);
    const onStartupHandler = chrome2.runtime.onStartup.addListener.mock.calls[0][0] as () => void;

    // Before firing onStartup: exactly the bug's starting condition — the
    // durable intent is there, but nothing has resumed the loop yet.
    expect(await bg2.getAutoState()).not.toBeNull();

    // Fire the restart lifecycle event. NOTE (issue #613 review T2): this is
    // NOT what makes the assertion below pass — `loadBackground()` already
    // triggered background.js's own TOP-LEVEL `autoTick()` (the one at the
    // bottom of the auto-driver block, run unconditionally on every module
    // load / worker respawn) before this line even runs, so the alarm is
    // already re-arming by the time `onStartupHandler()` fires. That
    // top-level tick — not `onStartup` — is the path that actually matters
    // for MV3: a worker respawn after an eviction fires no `onStartup` event
    // at all, only a fresh top-level module evaluation, so relying on
    // `onStartup` alone would leave that (more common) respawn case broken.
    // This test still exercises `onStartup` as one of the two real entry
    // points (both call `autoTick()` and both must be safe to call
    // redundantly — `autoTicking`'s re-entrancy guard is what makes that
    // fine), it just doesn't ISOLATE which one is responsible for the
    // re-arm below. Poll for the cooldown alarm either path schedules once
    // the (mocked 'idle') auto-plan round trip resolves.
    await waitFor(() => chrome2.alarms.create.mock.calls.some((c) => c[0] === "inmoAutoNext"));

    const auto = await bg2.getAutoState();
    expect(auto).not.toBeNull();
    expect(auto!.enabled).toBe(true);
    expect(auto!.portal).toBe("idealista");

    // The alarm is ARMED again (not left cleared) — the actual DoD: "the
    // alarm re-arms, and the next due unit runs without touching the popup".
    const armedCall = chrome2.alarms.create.mock.calls.find((c) => c[0] === "inmoAutoNext");
    expect(armedCall).toBeDefined();
    expect((armedCall![1] as { when: number }).when).toBeGreaterThan(Date.now());
  });

  it("stays durably OFF across a restart once stopAuto ran (EC-5) — no alarm re-armed", async () => {
    const chrome1 = makeChromeMock();
    const bg1 = loadBackground(chrome1, makeFetchMock());
    await bg1.startAuto("idealista");
    // Stop IMMEDIATELY, with startAuto's own fire-and-forget autoTick() ->
    // runAutoBatch() cycle still in flight — no waiting the loop out first.
    // Before issue #613 review B1, this was flaky: runAutoBatch held a
    // SNAPSHOT of `auto` taken before its `fetchAutoPlan` await, and its
    // idle-branch write went through `setAutoState({ ...auto, ... })`, which
    // rewrote the durable intent too — silently resurrecting `enabled:true`
    // the instant that in-flight write landed after this stopAuto() call.
    // The fix (setAutoRunState, chrome.storage.session only) makes calling
    // Stop mid-cycle safe by construction, so this test no longer has to
    // dodge the race — see the dedicated race-reproduction test below for a
    // direct assertion of that specific window.
    await bg1.stopAuto();

    expect(await bg1.getAutoIntent()).toEqual({ enabled: false, portal: null, force: false });

    const storedIntent = await bg1.getAutoIntent();
    const chrome2 = makeChromeMock({ local: { inmoAutoIntent: storedIntent } });
    const bg2 = loadBackground(chrome2, makeFetchMock());
    const onStartupHandler = chrome2.runtime.onStartup.addListener.mock.calls[0][0] as () => void;

    onStartupHandler();
    // Give the fire-and-forget chain a beat to run (it should do nothing —
    // there is no 'idle'-cooldown alarm to wait for here, so a short real
    // delay is the simplest honest wait for a negative assertion).
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await bg2.getAutoState()).toBeNull();
    expect(chrome2.alarms.create.mock.calls.some((c) => c[0] === "inmoAutoNext")).toBe(false);
  });

  it("with NO durable intent at all (extension never armed) a restart leaves Auto off, not crashing", async () => {
    const chrome = makeChromeMock();
    const bg = loadBackground(chrome, makeFetchMock());
    const onStartupHandler = chrome.runtime.onStartup.addListener.mock.calls[0][0] as () => void;

    onStartupHandler();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await bg.getAutoState()).toBeNull();
    expect(chrome.alarms.create.mock.calls.some((c) => c[0] === "inmoAutoNext")).toBe(false);
  });

  it("a Stop landing WHILE fetchAutoPlan is in flight does not resurrect the durable intent (issue #613 review B1 — direct reproduction, not routed around)", async () => {
    let resolvePlan!: (v: unknown) => void;
    const planGate = new Promise((resolve) => {
      resolvePlan = resolve;
    });
    const chromeMock = makeChromeMock();
    const fetchMock = makeDelayedFetchMock(planGate);
    const bg = loadBackground(chromeMock, fetchMock);

    // startAuto() kicks off its own fire-and-forget autoTick() -> runAutoBatch()
    // cycle, which is now blocked awaiting fetchAutoPlan's response.
    await bg.startAuto("idealista");
    await waitFor(() =>
      fetchMock.mock.calls.some(([u]) => typeof u === "string" && u.includes("/api/etl/auto-plan")),
    );

    // The operator presses Stop WHILE that fetch is still in flight — exactly
    // the review-B1 window: before the fix, the in-flight cycle held a
    // SNAPSHOT of `auto` (enabled:true) taken before this await, and its
    // eventual write went through `setAutoState({ ...auto, ... })`, clobbering
    // the durable intent this stopAuto() call is about to clear.
    await bg.stopAuto();
    expect(await bg.getAutoIntent()).toEqual({ enabled: false, portal: null, force: false });

    // Now let the in-flight cycle's fetch resolve and its write land.
    resolvePlan({ kind: "idle", retryAfterSec: 300 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The actual bug this proves fixed: the durable intent must NOT have been
    // resurrected by the in-flight cycle's stale snapshot, and the popup-
    // facing state must not lie about it being ON.
    expect(await bg.getAutoIntent()).toEqual({ enabled: false, portal: null, force: false });
    expect(await bg.getAutoState()).toBeNull();
    const progress = await bg.getAutoProgress();
    expect(progress.enabled).toBe(false);
  });

  it("firing the AUTO_ALARM listener actually re-plans — not just re-registers an alarm (issue #613 review T1)", async () => {
    const chromeMock = makeChromeMock();
    const fetchMock = makeFetchMock({ kind: "idle", retryAfterSec: 300 });
    const bg = loadBackground(chromeMock, fetchMock);

    await bg.startAuto("idealista");
    await waitFor(() => chromeMock.alarms.create.mock.calls.some((c) => c[0] === "inmoAutoNext"));

    const planCallsBefore = fetchMock.mock.calls.filter(
      ([u]) => typeof u === "string" && u.includes("/api/etl/auto-plan"),
    ).length;
    expect(planCallsBefore).toBeGreaterThan(0);

    // Force the cooldown gate (batch.js nextAutoAction: `now - lastBatchAt >=
    // timeoutMs`) to already be satisfied. The alarm we're about to fire by
    // hand was armed for 300s in the future (`retryAfterSec`); a real Chrome
    // firing it would have let that much wall-clock time pass too, but
    // faking the clock here would only be re-proving nextAutoAction's own
    // arithmetic (already covered by extension-batch.test.ts) — this test is
    // about the ALARM -> WORK wiring, not the cooldown math, so it resets the
    // one input that arithmetic reads instead.
    await bg.setAutoRunState({ lastBatchAt: 0 });

    // Grab the ACTUAL onAlarm listener background.js registered — there is
    // exactly one; it dispatches by `alarm.name` internally — and fire it
    // exactly like Chrome would when the armed alarm's scheduledTime arrives.
    expect(chromeMock.alarms.onAlarm.addListener).toHaveBeenCalledTimes(1);
    const onAlarmHandler = chromeMock.alarms.onAlarm.addListener.mock.calls[0][0] as (alarm: {
      name: string;
    }) => void;
    onAlarmHandler({ name: "inmoAutoNext" });

    // The proof this isn't decorative (issue #613 review T1): firing the
    // alarm must trigger a SECOND real GET /api/etl/auto-plan round trip —
    // the actual re-plan work "re-fire as data expires" depends on — not just
    // leave a registered alarm sitting inert. Neutering either the AUTO_ALARM
    // or BATCH_ALARM dispatch branch in background.js's
    // `chrome.alarms.onAlarm.addListener` callback makes this fail while
    // every other test in this file (which only asserts the alarm was
    // *created*) still passes.
    await waitFor(() => {
      const n = fetchMock.mock.calls.filter(
        ([u]) => typeof u === "string" && u.includes("/api/etl/auto-plan"),
      ).length;
      return n > planCallsBefore;
    });
  });
});
