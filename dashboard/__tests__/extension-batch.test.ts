/**
 * Unit tests for the browser-extension's pure batch-capture queue logic
 * (issue #262, bounded concurrency #318, D-043). These import the REAL
 * extension module (browser-extension/batch.js) — not a copy — so the shipped
 * scheduler / pacing logic is what's under test. The chrome-tab wiring around
 * it (open/activate/close, AUTO_CAPTURE_DONE waits) lives in background.js and
 * is not unit-testable in-process; this file covers the pure scheduler:
 * makeBatchState/launchNext (≤N in flight), recordResultAt (out-of-order
 * settle + completion), reset/pause/resume/stop, progress, jitterDelay
 * (jittered spacing), and the MV3 reattach predicates.
 */

import { describe, it, expect } from "vitest";
import * as mod from "../../browser-extension/batch.js";

// batch.js publishes via `module.exports = api`; vite's CJS interop may expose
// it as the default export or spread the named keys — accept either (same
// pattern as extension-detect.test.ts).
const B = (mod as unknown as { default?: Record<string, unknown> }).default ?? mod;

interface BatchState {
  urls: string[];
  slots: string[];
  concurrency: number;
  status: string;
}
interface Progress {
  total: number;
  done: number;
  captured: number;
  failed: number;
  inflight: number;
  status: string;
}
interface Launch {
  state: BatchState;
  index: number;
  url: string | null;
}

const {
  STATUSES,
  SLOT,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  DEFAULT_PACE_BASE_MS,
  MIN_PACE_BASE_MS,
  MAX_PACE_BASE_MS,
  DEFAULT_PACE_SPREAD_MS,
  MIN_PACE_SPREAD_MS,
  MAX_PACE_SPREAD_MS,
  clampConcurrency,
  clampPaceBase,
  clampSpread,
  makeBatchState,
  inflightCount,
  firstPendingIndex,
  canLaunch,
  launchNext,
  recordResultAt,
  resetInflightToPending,
  pause,
  resume,
  stop,
  isActive,
  progress,
  jitterDelay,
  paceBaseMs,
  shouldReattach,
  orphanTabsToClose,
  makeSerializer,
  AUTO_STATUS,
  DEFAULT_AUTO_BATCH_SIZE,
  MIN_AUTO_BATCH_SIZE,
  MAX_AUTO_BATCH_SIZE,
  DEFAULT_AUTO_TIMEOUT_SEC,
  MIN_AUTO_TIMEOUT_SEC,
  MAX_AUTO_TIMEOUT_SEC,
  clampAutoBatchSize,
  clampAutoTimeoutSec,
  makeAutoState,
  shouldContinueAuto,
  selectNextPending,
  nextAutoAction,
} = B as {
  STATUSES: { RUNNING: string; PAUSED: string; DONE: string };
  SLOT: { PENDING: string; INFLIGHT: string; CAPTURED: string; FAILED: string };
  DEFAULT_CONCURRENCY: number;
  MAX_CONCURRENCY: number;
  DEFAULT_PACE_BASE_MS: number;
  MIN_PACE_BASE_MS: number;
  MAX_PACE_BASE_MS: number;
  DEFAULT_PACE_SPREAD_MS: number;
  MIN_PACE_SPREAD_MS: number;
  MAX_PACE_SPREAD_MS: number;
  clampConcurrency: (n: unknown) => number;
  clampPaceBase: (n: unknown) => number;
  clampSpread: (n: unknown) => number;
  makeBatchState: (urls: unknown, concurrency?: number) => BatchState;
  inflightCount: (s: BatchState | null) => number;
  firstPendingIndex: (s: BatchState | null) => number;
  canLaunch: (s: BatchState | null) => boolean;
  launchNext: (s: BatchState) => Launch;
  recordResultAt: (s: BatchState, index: number, ok: boolean) => BatchState;
  resetInflightToPending: (s: BatchState) => BatchState;
  pause: (s: BatchState) => BatchState;
  resume: (s: BatchState) => BatchState;
  stop: (s: BatchState) => BatchState;
  isActive: (s: BatchState | null) => boolean;
  progress: (s: BatchState | null) => Progress;
  jitterDelay: (base: number, spread: number, rnd?: () => number) => number;
  paceBaseMs: (processed: number, minBase?: number) => number;
  shouldReattach: (s: BatchState | null, looping: boolean) => boolean;
  orphanTabsToClose: (
    s: BatchState | null,
    looping: boolean,
    persistedTabIds: unknown,
  ) => number[];
  makeSerializer: () => <T>(fn: () => Promise<T> | T) => Promise<T>;
  // Auto-capture continuous driver (issue #424)
  AUTO_STATUS: {
    IDLE: string;
    RUNNING: string;
    WAITING: string;
    EMPTY: string;
    STOPPED: string;
  };
  DEFAULT_AUTO_BATCH_SIZE: number;
  MIN_AUTO_BATCH_SIZE: number;
  MAX_AUTO_BATCH_SIZE: number;
  DEFAULT_AUTO_TIMEOUT_SEC: number;
  MIN_AUTO_TIMEOUT_SEC: number;
  MAX_AUTO_TIMEOUT_SEC: number;
  clampAutoBatchSize: (n: unknown) => number;
  clampAutoTimeoutSec: (n: unknown) => number;
  makeAutoState: (opts: unknown) => AutoState;
  shouldContinueAuto: (s: AutoState | null, pendingCount: number) => boolean;
  selectNextPending: (
    items: unknown,
    duePriority: Record<string, number>,
    limit: number,
  ) => PendingItem[];
  nextAutoAction: (
    s: AutoState | null,
    opts: { batchActive?: boolean; now?: number },
  ) => string;
};

interface AutoState {
  enabled: boolean;
  portal: string | null;
  batchSize: number;
  timeoutSec: number;
  status: string;
  batchesDone: number;
  lastBatchAt: number | null;
  totalPending: number | null;
}
interface PendingItem {
  url: string;
  portal: string;
  createdAt: string | number | null;
}

const URLS = [
  "https://www.idealista.com/inmueble/1/",
  "https://www.idealista.com/inmueble/2/",
  "https://www.idealista.com/inmueble/3/",
];

describe("clampConcurrency — small, capped, safe default", () => {
  it("defaults when absent/garbage/non-positive", () => {
    expect(clampConcurrency(undefined)).toBe(DEFAULT_CONCURRENCY);
    expect(clampConcurrency(0)).toBe(DEFAULT_CONCURRENCY);
    expect(clampConcurrency(-4)).toBe(DEFAULT_CONCURRENCY);
    expect(clampConcurrency("x")).toBe(DEFAULT_CONCURRENCY);
  });

  it("keeps a valid small value and floors fractions", () => {
    expect(clampConcurrency(1)).toBe(1);
    expect(clampConcurrency(2)).toBe(2);
    expect(clampConcurrency(3.9)).toBe(3);
  });

  it("hard-caps at MAX_CONCURRENCY so a bad config can't burst tabs", () => {
    expect(clampConcurrency(50)).toBe(MAX_CONCURRENCY);
    expect(clampConcurrency(MAX_CONCURRENCY + 1)).toBe(MAX_CONCURRENCY);
  });

  it("default is small (3) and the raised cap is bounded (8) — issue #410", () => {
    // #410 raised the ceiling 5→8 to give the operator headroom, while keeping
    // the safe default small. The cap stays a HARD bound so config can't burst.
    expect(DEFAULT_CONCURRENCY).toBe(3);
    expect(MAX_CONCURRENCY).toBe(8);
    expect(clampConcurrency(8)).toBe(8); // the new ceiling is reachable
    expect(clampConcurrency(9)).toBe(8); // but never exceeded
  });
});

describe("clampPaceBase / clampSpread — user-tunable pacing (issue #410)", () => {
  it("defaults when absent/garbage/non-finite", () => {
    expect(clampPaceBase(undefined)).toBe(DEFAULT_PACE_BASE_MS);
    expect(clampPaceBase("x")).toBe(DEFAULT_PACE_BASE_MS);
    expect(clampPaceBase(NaN)).toBe(DEFAULT_PACE_BASE_MS);
    expect(clampSpread(undefined)).toBe(DEFAULT_PACE_SPREAD_MS);
    expect(clampSpread("x")).toBe(DEFAULT_PACE_SPREAD_MS);
  });

  it("the new lower default base is 2000 ms, spread stays 5000 ms", () => {
    expect(DEFAULT_PACE_BASE_MS).toBe(2000);
    expect(DEFAULT_PACE_SPREAD_MS).toBe(5000);
  });

  it("keeps a valid value and floors fractions", () => {
    expect(clampPaceBase(3000)).toBe(3000);
    expect(clampPaceBase(2500.9)).toBe(2500);
    expect(clampSpread(1000)).toBe(1000);
    expect(clampSpread(0)).toBe(0); // spread may be disabled entirely
  });

  it("clamps base into [MIN,MAX] — never removes the stagger, never runs away", () => {
    expect(clampPaceBase(0)).toBe(MIN_PACE_BASE_MS); // floor keeps WAF stagger
    expect(clampPaceBase(-100)).toBe(MIN_PACE_BASE_MS);
    expect(clampPaceBase(999999)).toBe(MAX_PACE_BASE_MS);
  });

  it("clamps spread into [MIN,MAX]", () => {
    expect(clampSpread(-5)).toBe(MIN_PACE_SPREAD_MS);
    expect(clampSpread(999999)).toBe(MAX_PACE_SPREAD_MS);
  });
});

describe("makeBatchState", () => {
  it("starts every slot pending, running, at the requested concurrency", () => {
    const s = makeBatchState(URLS, 3);
    expect(s.status).toBe(STATUSES.RUNNING);
    expect(s.concurrency).toBe(3);
    expect(s.urls).toEqual(URLS);
    expect(s.slots).toEqual([SLOT.PENDING, SLOT.PENDING, SLOT.PENDING]);
  });

  it("defaults + clamps the concurrency", () => {
    expect(makeBatchState(URLS).concurrency).toBe(DEFAULT_CONCURRENCY);
    expect(makeBatchState(URLS, 99).concurrency).toBe(MAX_CONCURRENCY);
  });

  it("starts an empty list already done", () => {
    expect(makeBatchState([]).status).toBe(STATUSES.DONE);
    expect(makeBatchState([]).slots).toEqual([]);
  });

  it("filters out non-string / empty entries defensively", () => {
    const s = makeBatchState(["https://a/inmueble/1", "", null, 5, undefined]);
    expect(s.urls).toEqual(["https://a/inmueble/1"]);
    expect(s.slots).toEqual([SLOT.PENDING]);
  });

  it("treats a non-array as empty", () => {
    expect(makeBatchState(undefined).status).toBe(STATUSES.DONE);
    expect(makeBatchState(undefined).urls).toEqual([]);
  });
});

describe("launchNext — never exceeds the concurrency cap", () => {
  it("claims the first pending slot, flips it to inflight (pure)", () => {
    const s0 = makeBatchState(URLS, 2);
    const l = launchNext(s0);
    expect(l.index).toBe(0);
    expect(l.url).toBe(URLS[0]);
    expect(l.state.slots[0]).toBe(SLOT.INFLIGHT);
    // pure — original untouched
    expect(s0.slots[0]).toBe(SLOT.PENDING);
  });

  it("stops launching once `concurrency` tabs are in flight", () => {
    let s = makeBatchState(URLS, 2);
    s = launchNext(s).state; // idx 0 inflight
    s = launchNext(s).state; // idx 1 inflight
    expect(inflightCount(s)).toBe(2);
    expect(canLaunch(s)).toBe(false); // cap reached even though idx 2 is pending
    const blocked = launchNext(s);
    expect(blocked.index).toBe(-1);
    expect(blocked.url).toBeNull();
    expect(blocked.state).toBe(s); // unchanged
  });

  it("resumes launching after a slot settles (frees capacity)", () => {
    let s = makeBatchState(URLS, 2);
    s = launchNext(s).state; // 0 inflight
    s = launchNext(s).state; // 1 inflight
    s = recordResultAt(s, 0, true); // 0 settles → capacity freed
    expect(canLaunch(s)).toBe(true);
    const l = launchNext(s);
    expect(l.index).toBe(2); // the last pending
    expect(inflightCount(l.state)).toBe(2);
  });

  it("never launches from a paused / stopped / done queue", () => {
    expect(launchNext(pause(makeBatchState(URLS))).index).toBe(-1);
    expect(launchNext(stop(makeBatchState(URLS))).index).toBe(-1);
    expect(launchNext(makeBatchState([])).index).toBe(-1);
  });

  it("full drive of a run keeps in-flight ≤ N at every step", () => {
    const N = 2;
    const many = Array.from({ length: 7 }, (_, i) => `https://a/inmueble/${i}`);
    let s = makeBatchState(many, N);
    const launched: number[] = [];
    let guard = 0;
    // Simulate the driver: launch while possible, then settle the oldest.
    while (isActive(s) && guard++ < 100) {
      while (canLaunch(s)) {
        const l = launchNext(s);
        s = l.state;
        launched.push(l.index);
        expect(inflightCount(s)).toBeLessThanOrEqual(N); // <= N invariant
      }
      // settle the lowest-indexed in-flight slot
      const idx = s.slots.findIndex((x) => x === SLOT.INFLIGHT);
      if (idx === -1) break;
      s = recordResultAt(s, idx, true);
    }
    expect(s.status).toBe(STATUSES.DONE);
    expect(progress(s).captured).toBe(7);
    // every URL was launched exactly once
    expect([...launched].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("at the raised ceiling (N=8) still never exceeds `concurrency` in flight", () => {
    const N = MAX_CONCURRENCY; // 8 (issue #410)
    const many = Array.from({ length: 30 }, (_, i) => `https://a/inmueble/${i}`);
    let s = makeBatchState(many, N);
    expect(s.concurrency).toBe(8);
    let maxSeen = 0;
    let guard = 0;
    while (isActive(s) && guard++ < 1000) {
      while (canLaunch(s)) {
        s = launchNext(s).state;
        maxSeen = Math.max(maxSeen, inflightCount(s));
        expect(inflightCount(s)).toBeLessThanOrEqual(N); // the hard invariant
      }
      const idx = s.slots.findIndex((x) => x === SLOT.INFLIGHT);
      if (idx === -1) break;
      s = recordResultAt(s, idx, true);
    }
    expect(s.status).toBe(STATUSES.DONE);
    expect(progress(s).captured).toBe(30);
    expect(maxSeen).toBe(8); // the pool really did fill to the raised ceiling
  });
});

describe("recordResultAt — out-of-order settle + completion", () => {
  it("marks the addressed slot captured/failed and derives counts", () => {
    let s = makeBatchState(URLS, 3);
    s = launchNext(s).state; // 0
    s = launchNext(s).state; // 1
    s = launchNext(s).state; // 2
    // settle OUT OF ORDER: 2, then 0, then 1
    s = recordResultAt(s, 2, true);
    s = recordResultAt(s, 0, false);
    expect(progress(s)).toMatchObject({ captured: 1, failed: 1, inflight: 1, done: 2 });
    s = recordResultAt(s, 1, true);
    expect(s.status).toBe(STATUSES.DONE);
    expect(progress(s)).toMatchObject({ captured: 2, failed: 1, inflight: 0, total: 3 });
  });

  it("flips to done only when nothing is pending AND nothing is in flight", () => {
    let s = makeBatchState(URLS, 3);
    s = launchNext(s).state; // 0 inflight; 1,2 still pending
    s = recordResultAt(s, 0, true); // 0 done, but 1,2 pending
    expect(s.status).toBe(STATUSES.RUNNING);
  });

  it("is pure — does not mutate its argument", () => {
    const s0 = launchNext(makeBatchState(URLS)).state;
    recordResultAt(s0, 0, true);
    expect(s0.slots[0]).toBe(SLOT.INFLIGHT);
  });

  it("ignores a stray signal for a non-inflight slot", () => {
    const s = makeBatchState(URLS, 3); // all pending
    expect(recordResultAt(s, 0, true)).toBe(s); // slot 0 isn't inflight
    const settled = recordResultAt(launchNext(s).state, 0, true);
    expect(recordResultAt(settled, 0, false)).toBe(settled); // already captured
  });

  it("ignores a late signal after the queue is stopped", () => {
    const running = launchNext(makeBatchState(URLS)).state;
    const stopped = stop(running);
    expect(recordResultAt(stopped, 0, true)).toBe(stopped);
  });

  it("ignores an out-of-range index", () => {
    const s = launchNext(makeBatchState(URLS)).state;
    expect(recordResultAt(s, 99, true)).toBe(s);
    expect(recordResultAt(s, -1, true)).toBe(s);
  });
});

describe("resetInflightToPending — MV3 eviction re-launch", () => {
  it("turns every in-flight slot back to pending, leaving settled ones", () => {
    let s = makeBatchState(URLS, 3);
    s = launchNext(s).state; // 0 inflight
    s = launchNext(s).state; // 1 inflight
    s = recordResultAt(s, 0, true); // 0 captured
    const r = resetInflightToPending(s);
    expect(r.slots).toEqual([SLOT.CAPTURED, SLOT.PENDING, SLOT.PENDING]);
    expect(inflightCount(r)).toBe(0);
  });

  it("is a no-op when nothing is in flight", () => {
    const s = makeBatchState(URLS, 3);
    expect(resetInflightToPending(s)).toBe(s);
  });
});

describe("pause / resume / stop", () => {
  it("pause halts a running queue; resume continues (nothing lost)", () => {
    let s = launchNext(makeBatchState(URLS, 3)).state; // 0 inflight
    s = pause(s);
    expect(s.status).toBe(STATUSES.PAUSED);
    expect(isActive(s)).toBe(false);
    expect(canLaunch(s)).toBe(false);
    const r = resume(s);
    expect(r.status).toBe(STATUSES.RUNNING);
    expect(inflightCount(r)).toBe(1); // the in-flight tab survived the pause
  });

  it("resume of a queue with no work left completes rather than re-runs", () => {
    let s = makeBatchState(["https://a/inmueble/1"], 3);
    s = recordResultAt(launchNext(s).state, 0, true); // done already
    s = { ...s, status: STATUSES.PAUSED }; // force paused-at-end
    expect(resume(s).status).toBe(STATUSES.DONE);
  });

  it("stop marks running or paused as done", () => {
    expect(stop(makeBatchState(URLS)).status).toBe(STATUSES.DONE);
    expect(stop(pause(makeBatchState(URLS))).status).toBe(STATUSES.DONE);
  });

  it("pause / resume are no-ops in the wrong state", () => {
    const running = makeBatchState(URLS);
    expect(resume(running)).toBe(running);
    const done = stop(running);
    expect(pause(done)).toBe(done);
  });
});

describe("progress", () => {
  it("reports total/done/captured/failed/inflight for the UI", () => {
    let s = makeBatchState(URLS, 3);
    s = launchNext(s).state; // 0 inflight
    s = launchNext(s).state; // 1 inflight
    s = recordResultAt(s, 0, true);
    s = recordResultAt(s, 1, false);
    expect(progress(s)).toEqual({
      total: 3,
      done: 2,
      captured: 1,
      failed: 1,
      inflight: 0,
      status: STATUSES.RUNNING,
    });
  });

  it("reports an empty done view for a null/malformed state", () => {
    expect(progress(null)).toEqual({
      total: 0,
      done: 0,
      captured: 0,
      failed: 0,
      inflight: 0,
      status: STATUSES.DONE,
    });
  });
});

describe("jitterDelay — jittered launch spacing (never a metronome)", () => {
  it("returns base + a value within [0, spread) using the injected rng", () => {
    expect(jitterDelay(4000, 5000, () => 0)).toBe(4000);
    expect(jitterDelay(4000, 5000, () => 0.9999)).toBe(4000 + Math.floor(0.9999 * 5000));
    expect(jitterDelay(4000, 5000, () => 0.5)).toBe(4000 + Math.floor(0.5 * 5000));
  });

  it("clamps negative base/spread to 0", () => {
    expect(jitterDelay(-1, -1, () => 0.9)).toBe(0);
  });

  it("stays within bounds across many random draws (real Math.random)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const d = jitterDelay(4000, 5000);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(9000);
      seen.add(d);
    }
    // Randomised, not a fixed interval — many distinct values across draws.
    expect(seen.size).toBeGreaterThan(10);
  });
});

describe("paceBaseMs — gentle backoff for long sweeps", () => {
  it("uses the (lowered) default base of 2000 ms at the start of a run", () => {
    // #410 lowered the default base 4000→2000, so with the default 5000 spread
    // the opening launches land in [2000, 7000) instead of [4000, 9000).
    expect(paceBaseMs(0)).toBe(2000);
    expect(paceBaseMs(24)).toBe(2000);
    expect(jitterDelay(paceBaseMs(0), 5000, () => 0)).toBe(2000);
    expect(jitterDelay(paceBaseMs(0), 5000, () => 0.9999)).toBeLessThan(7000);
  });

  it("lengthens the base stepwise as the run gets long (on top of the default)", () => {
    expect(paceBaseMs(25)).toBe(4000);
    expect(paceBaseMs(50)).toBe(6000);
    expect(paceBaseMs(100)).toBe(10000);
  });

  it("caps the base so it never runs away (default + 12 s)", () => {
    expect(paceBaseMs(150)).toBe(14000);
    expect(paceBaseMs(100000)).toBe(14000);
  });

  it("treats a negative/garbage processed count as 0", () => {
    expect(paceBaseMs(-5)).toBe(2000);
  });

  it("honours a configured minimum base (issue #410), still clamped", () => {
    // The operator's stagger base becomes the floor; the backoff builds on top.
    expect(paceBaseMs(0, 3000)).toBe(3000);
    expect(paceBaseMs(25, 3000)).toBe(5000); // +1 step
    expect(paceBaseMs(0, 1000)).toBe(1000); // faster than default
    // A garbage/out-of-range configured base is clamped, never trusted raw.
    expect(paceBaseMs(0, 0)).toBe(MIN_PACE_BASE_MS);
    expect(paceBaseMs(0, 999999)).toBe(MAX_PACE_BASE_MS);
    expect(paceBaseMs(0, "x" as unknown as number)).toBe(DEFAULT_PACE_BASE_MS);
  });
});

describe("shouldReattach — MV3 eviction recovery decision", () => {
  const running = makeBatchState(URLS);

  it("re-attaches when the queue is running but no loop is active", () => {
    expect(shouldReattach(running, false)).toBe(true);
  });

  it("does nothing when a loop is already driving the queue", () => {
    expect(shouldReattach(running, true)).toBe(false);
  });

  it("does nothing for a paused / done / null queue", () => {
    expect(shouldReattach(pause(running), false)).toBe(false);
    expect(shouldReattach(stop(running), false)).toBe(false);
    expect(shouldReattach(makeBatchState([]), false)).toBe(false);
    expect(shouldReattach(null, false)).toBe(false);
  });
});

describe("orphanTabsToClose — reconcile the tabs leaked at eviction", () => {
  const running = makeBatchState(URLS);

  it("returns every persisted tab id when the run is stranded", () => {
    expect(orphanTabsToClose(running, false, [42, 43, 44])).toEqual([42, 43, 44]);
  });

  it("filters non-numeric ids defensively", () => {
    expect(orphanTabsToClose(running, false, [42, "x", null, 43])).toEqual([42, 43]);
  });

  it("returns [] when a loop is still alive (never disturb live tabs)", () => {
    expect(orphanTabsToClose(running, true, [42])).toEqual([]);
  });

  it("returns [] when no ids were persisted / bad input", () => {
    expect(orphanTabsToClose(running, false, [])).toEqual([]);
    expect(orphanTabsToClose(running, false, null)).toEqual([]);
  });

  it("returns [] for a paused/done queue even with persisted ids", () => {
    expect(orphanTabsToClose(pause(running), false, [42])).toEqual([]);
    expect(orphanTabsToClose(stop(running), false, [42])).toEqual([]);
  });
});

// ── makeSerializer — the in-memory async mutex (issue #321) ─────────────────
//
// The driver's get-modify-set of the shared batch state runs on
// chrome.storage.session, whose get()/set() are async. With bounded
// concurrency (#318) two driveOnePage calls can settle in the same tick and
// interleave read → modify → write, lost-updating one another's slot flip.
// These tests model that exact async get-modify-set against an in-memory store
// (a tick() microtask stands in for storage's async boundary) and prove the
// serializer closes the race that an unguarded update leaves open.
describe("makeSerializer — serialize the storage get-modify-set", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // An async key-value cell mimicking chrome.storage.session: both get and set
  // yield, so an unguarded read-modify-write can interleave with another's.
  function makeAsyncStore(initial: BatchState) {
    let value = initial;
    return {
      get: async () => {
        await tick();
        return value;
      },
      set: async (v: BatchState) => {
        await tick();
        value = v;
      },
      peek: () => value,
    };
  }

  // Two slots already in flight — the state at the moment two tabs settle.
  function twoInflight(): BatchState {
    const first = launchNext(makeBatchState(URLS)); // slot 0 → inflight
    return launchNext(first.state).state; // slot 1 → inflight
  }

  it("UNGUARDED get-modify-set loses one update (the race we're closing)", async () => {
    const store = makeAsyncStore(twoInflight());
    const update = async (fn: (s: BatchState) => BatchState) => {
      const s = await store.get();
      await store.set(fn(s)); // read and write straddle the async boundary
    };
    // Two tabs settle at once: slot 0 and slot 1 both captured.
    await Promise.all([
      update((s) => recordResultAt(s, 0, true)),
      update((s) => recordResultAt(s, 1, true)),
    ]);
    // The later write read the pre-flip state and clobbered the earlier flip —
    // only one capture survives. This is the lost update from #321.
    expect(progress(store.peek()).captured).toBe(1);
  });

  it("SERIALIZED get-modify-set persists BOTH updates (fix)", async () => {
    const store = makeAsyncStore(twoInflight());
    const run = makeSerializer();
    const update = (fn: (s: BatchState) => BatchState) =>
      run(async () => {
        const s = await store.get();
        await store.set(fn(s));
      });
    await Promise.all([
      update((s) => recordResultAt(s, 0, true)),
      update((s) => recordResultAt(s, 1, true)),
    ]);
    // Both flips survive — no lost update.
    expect(progress(store.peek()).captured).toBe(2);
  });

  it("runs sections strictly one-at-a-time, in call order (FIFO)", async () => {
    const run = makeSerializer();
    const events: string[] = [];
    const section = (id: string) =>
      run(async () => {
        events.push(`${id}:start`);
        await tick();
        events.push(`${id}:end`);
      });
    await Promise.all([section("a"), section("b"), section("c")]);
    // No two sections overlap, and they execute in the order submitted.
    expect(events).toEqual([
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  it("returns each caller's own result and keeps the chain alive after a rejection", async () => {
    const run = makeSerializer();
    const ok1 = run(async () => "one");
    const boom = run(async () => {
      throw new Error("boom");
    });
    const ok2 = run(async () => "two");
    await expect(ok1).resolves.toBe("one");
    await expect(boom).rejects.toThrow("boom");
    // A rejected section must not stall or break later sections.
    await expect(ok2).resolves.toBe("two");
  });
});

// ═══ Auto-capture continuous driver (issue #424) ════════════════════════════

describe("clampAutoBatchSize / clampAutoTimeoutSec — bounded, safe defaults", () => {
  it("defaults when absent/garbage (non-numeric)", () => {
    expect(clampAutoBatchSize(undefined)).toBe(DEFAULT_AUTO_BATCH_SIZE);
    expect(clampAutoBatchSize("x")).toBe(DEFAULT_AUTO_BATCH_SIZE);
    expect(clampAutoBatchSize(NaN)).toBe(DEFAULT_AUTO_BATCH_SIZE);
    expect(clampAutoTimeoutSec(undefined)).toBe(DEFAULT_AUTO_TIMEOUT_SEC);
    expect(clampAutoTimeoutSec("x")).toBe(DEFAULT_AUTO_TIMEOUT_SEC);
  });

  it("clamps an in-range-but-too-small numeric value up to MIN (not the default)", () => {
    // A finite number below MIN is clamped up (like clampSpread), not defaulted.
    expect(clampAutoBatchSize(0)).toBe(MIN_AUTO_BATCH_SIZE);
    expect(clampAutoTimeoutSec(-9)).toBe(MIN_AUTO_TIMEOUT_SEC);
  });

  it("hard-caps both so a bad config can't run away", () => {
    expect(clampAutoBatchSize(99999)).toBe(MAX_AUTO_BATCH_SIZE);
    expect(clampAutoBatchSize(MIN_AUTO_BATCH_SIZE)).toBe(MIN_AUTO_BATCH_SIZE);
    expect(clampAutoTimeoutSec(99999)).toBe(MAX_AUTO_TIMEOUT_SEC);
    // Below the 30 s Chrome-alarm floor is clamped up.
    expect(clampAutoTimeoutSec(1)).toBe(MIN_AUTO_TIMEOUT_SEC);
    expect(MIN_AUTO_TIMEOUT_SEC).toBe(30);
  });

  it("keeps a valid in-range value and floors fractions", () => {
    expect(clampAutoBatchSize(100)).toBe(100);
    expect(clampAutoBatchSize(50.9)).toBe(50);
    expect(clampAutoTimeoutSec(60)).toBe(60);
  });

  it("default batch size is 100 (issue #424)", () => {
    expect(DEFAULT_AUTO_BATCH_SIZE).toBe(100);
  });
});

describe("makeAutoState — clamped, sane initial shape", () => {
  it("clamps knobs and defaults status/counters", () => {
    const s = makeAutoState({ enabled: true, portal: "idealista", batchSize: 9999, timeoutSec: 1 });
    expect(s.enabled).toBe(true);
    expect(s.portal).toBe("idealista");
    expect(s.batchSize).toBe(MAX_AUTO_BATCH_SIZE);
    expect(s.timeoutSec).toBe(MIN_AUTO_TIMEOUT_SEC);
    expect(s.status).toBe(AUTO_STATUS.IDLE);
    expect(s.batchesDone).toBe(0);
    expect(s.lastBatchAt).toBeNull();
  });

  it("null portal means 'drain every portal'", () => {
    expect(makeAutoState({ enabled: true }).portal).toBeNull();
    expect(makeAutoState({ enabled: true, portal: "" }).portal).toBeNull();
  });
});

describe("shouldContinueAuto — flag on AND pending > 0", () => {
  const on = makeAutoState({ enabled: true });
  const off = makeAutoState({ enabled: false });
  it("continues only when enabled and there is work", () => {
    expect(shouldContinueAuto(on, 5)).toBe(true);
    expect(shouldContinueAuto(on, 1)).toBe(true);
  });
  it("stops when the flag is off, even with pending work", () => {
    expect(shouldContinueAuto(off, 5)).toBe(false);
  });
  it("stops when the worklist is empty, even while enabled", () => {
    expect(shouldContinueAuto(on, 0)).toBe(false);
  });
  it("is false for a null/absent state", () => {
    expect(shouldContinueAuto(null, 5)).toBe(false);
  });
});

describe("selectNextPending — cap N, due-priority then oldest", () => {
  const items: PendingItem[] = [
    { url: "u-alt-old", portal: "altamira", createdAt: "2026-01-01T00:00:00Z" },
    { url: "u-ide-new", portal: "idealista", createdAt: "2026-03-01T00:00:00Z" },
    { url: "u-ide-old", portal: "idealista", createdAt: "2026-02-01T00:00:00Z" },
    { url: "u-ali-old", portal: "aliseda", createdAt: "2026-01-15T00:00:00Z" },
  ];
  // idealista due (0), aliseda half-done (1); altamira absent → unknown (last).
  const due = { idealista: 0, aliseda: 1 };

  it("caps the result at N", () => {
    expect(selectNextPending(items, due, 2)).toHaveLength(2);
    expect(selectNextPending(items, due, 0)).toEqual([]);
    expect(selectNextPending(items, due, 99)).toHaveLength(items.length);
  });

  it("orders by portal due-rank, then oldest createdAt", () => {
    const urls = selectNextPending(items, due, 99).map((x) => x.url);
    // idealista (rank 0): oldest first → u-ide-old before u-ide-new;
    // then aliseda (rank 1); then altamira (unknown rank) last.
    expect(urls).toEqual(["u-ide-old", "u-ide-new", "u-ali-old", "u-alt-old"]);
  });

  it("the capped batch takes the most-due first", () => {
    expect(selectNextPending(items, due, 1).map((x) => x.url)).toEqual(["u-ide-old"]);
  });

  it("with no due map, falls back to pure oldest-first", () => {
    const urls = selectNextPending(items, {}, 99).map((x) => x.url);
    expect(urls).toEqual(["u-alt-old", "u-ali-old", "u-ide-old", "u-ide-new"]);
  });

  it("is stable and never exceeds the concurrency cap when fed to the queue", () => {
    // The selected batch drives makeBatchState; launchNext must still respect
    // the concurrency cap (the auto path reuses the SAME bounded queue).
    const picked = selectNextPending(items, due, 3).map((x) => x.url);
    let s = makeBatchState(picked, 2);
    let launched = 0;
    for (;;) {
      const r = launchNext(s);
      if (r.index === -1) break;
      s = r.state;
      launched += 1;
    }
    expect(inflightCount(s)).toBeLessThanOrEqual(2);
    expect(launched).toBe(2); // never more than the cap in flight at once
  });
});

describe("nextAutoAction — the alarm-tick decision", () => {
  const base = makeAutoState({ enabled: true, timeoutSec: 60 });

  it("idle when Auto is off", () => {
    expect(nextAutoAction(makeAutoState({ enabled: false }), {})).toBe("idle");
    expect(nextAutoAction(null, {})).toBe("idle");
  });

  it("defers while any batch is in flight", () => {
    expect(nextAutoAction(base, { batchActive: true })).toBe("defer");
    expect(nextAutoAction({ ...base, status: AUTO_STATUS.RUNNING }, { batchActive: true })).toBe("defer");
  });

  it("marks complete when a running batch is no longer active", () => {
    expect(
      nextAutoAction({ ...base, status: AUTO_STATUS.RUNNING }, { batchActive: false }),
    ).toBe("complete");
  });

  it("starts immediately when never run", () => {
    expect(nextAutoAction({ ...base, lastBatchAt: null }, { batchActive: false })).toBe("start");
  });

  it("waits during the cooldown, starts once the timeout elapsed", () => {
    const now = 1_000_000;
    const waiting = { ...base, status: AUTO_STATUS.WAITING, lastBatchAt: now - 10_000 };
    expect(nextAutoAction(waiting, { batchActive: false, now })).toBe("wait");
    const elapsed = { ...base, status: AUTO_STATUS.WAITING, lastBatchAt: now - 60_000 };
    expect(nextAutoAction(elapsed, { batchActive: false, now })).toBe("start");
  });

  it("re-checks (start) after the cooldown even when the list was empty", () => {
    const now = 1_000_000;
    const empty = { ...base, status: AUTO_STATUS.EMPTY, lastBatchAt: now - 61_000 };
    expect(nextAutoAction(empty, { batchActive: false, now })).toBe("start");
  });
});
