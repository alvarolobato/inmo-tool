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
  clampConcurrency,
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
} = B as {
  STATUSES: { RUNNING: string; PAUSED: string; DONE: string };
  SLOT: { PENDING: string; INFLIGHT: string; CAPTURED: string; FAILED: string };
  DEFAULT_CONCURRENCY: number;
  MAX_CONCURRENCY: number;
  clampConcurrency: (n: unknown) => number;
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
  paceBaseMs: (processed: number) => number;
  shouldReattach: (s: BatchState | null, looping: boolean) => boolean;
  orphanTabsToClose: (
    s: BatchState | null,
    looping: boolean,
    persistedTabIds: unknown,
  ) => number[];
};

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

  it("default is small (3) and the cap is bounded (≤5) — WAF safety", () => {
    expect(DEFAULT_CONCURRENCY).toBe(3);
    expect(MAX_CONCURRENCY).toBeLessThanOrEqual(5);
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
  it("keeps the 4–9 s minimum at the start of a run", () => {
    expect(paceBaseMs(0)).toBe(4000);
    expect(paceBaseMs(24)).toBe(4000);
    expect(jitterDelay(paceBaseMs(0), 5000, () => 0)).toBe(4000);
    expect(jitterDelay(paceBaseMs(0), 5000, () => 0.9999)).toBeLessThan(9000);
  });

  it("lengthens the base stepwise as the run gets long", () => {
    expect(paceBaseMs(25)).toBe(6000);
    expect(paceBaseMs(50)).toBe(8000);
    expect(paceBaseMs(100)).toBe(12000);
  });

  it("caps the base so it never runs away (MIN + 12 s)", () => {
    expect(paceBaseMs(150)).toBe(16000);
    expect(paceBaseMs(100000)).toBe(16000);
  });

  it("treats a negative/garbage processed count as 0", () => {
    expect(paceBaseMs(-5)).toBe(4000);
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
