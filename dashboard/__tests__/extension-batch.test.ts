/**
 * Unit tests for the browser-extension's pure batch-capture queue logic
 * (issue #262, D-043). These import the REAL extension module
 * (browser-extension/batch.js) — not a copy — so the shipped queue-advance /
 * pacing logic is what's under test. The chrome-tab wiring around it
 * (open/activate/close, AUTO_CAPTURE_DONE waits) lives in background.js and is
 * not unit-testable in-process; this file covers the three pure pieces the
 * issue calls out: makeBatchState/currentUrl, recordResult (advance),
 * pause/resume/stop, progress, and jitterDelay.
 */

import { describe, it, expect } from "vitest";
import * as mod from "../../browser-extension/batch.js";

// batch.js publishes via `module.exports = api`; vite's CJS interop may expose
// it as the default export or spread the named keys — accept either (same
// pattern as extension-detect.test.ts).
const B = (mod as unknown as { default?: Record<string, unknown> }).default ?? mod;

interface BatchState {
  urls: string[];
  index: number;
  captured: number;
  failed: number;
  status: string;
}
interface Progress {
  total: number;
  done: number;
  captured: number;
  failed: number;
  status: string;
}

const {
  STATUSES,
  makeBatchState,
  currentUrl,
  recordResult,
  pause,
  resume,
  stop,
  isActive,
  progress,
  jitterDelay,
  paceBaseMs,
  shouldReattach,
  orphanTabToClose,
} = B as {
  STATUSES: { RUNNING: string; PAUSED: string; DONE: string };
  makeBatchState: (urls: unknown) => BatchState;
  currentUrl: (s: BatchState | null) => string | null;
  recordResult: (s: BatchState, ok: boolean) => BatchState;
  pause: (s: BatchState) => BatchState;
  resume: (s: BatchState) => BatchState;
  stop: (s: BatchState) => BatchState;
  isActive: (s: BatchState | null) => boolean;
  progress: (s: BatchState | null) => Progress;
  jitterDelay: (base: number, spread: number, rnd?: () => number) => number;
  paceBaseMs: (processed: number) => number;
  shouldReattach: (s: BatchState | null, looping: boolean) => boolean;
  orphanTabToClose: (
    s: BatchState | null,
    looping: boolean,
    persistedTabId: number | null,
  ) => number | null;
};

const URLS = [
  "https://www.idealista.com/inmueble/1/",
  "https://www.idealista.com/inmueble/2/",
  "https://www.idealista.com/inmueble/3/",
];

describe("makeBatchState", () => {
  it("starts a non-empty list running at index 0", () => {
    const s = makeBatchState(URLS);
    expect(s.status).toBe(STATUSES.RUNNING);
    expect(s.index).toBe(0);
    expect(s.captured).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.urls).toEqual(URLS);
  });

  it("starts an empty list already done", () => {
    expect(makeBatchState([]).status).toBe(STATUSES.DONE);
  });

  it("filters out non-string / empty entries defensively", () => {
    const s = makeBatchState(["https://a/inmueble/1", "", null, 5, undefined]);
    expect(s.urls).toEqual(["https://a/inmueble/1"]);
  });

  it("treats a non-array as empty", () => {
    expect(makeBatchState(undefined).status).toBe(STATUSES.DONE);
    expect(makeBatchState(undefined).urls).toEqual([]);
  });
});

describe("currentUrl", () => {
  it("returns the URL at the current index while running", () => {
    expect(currentUrl(makeBatchState(URLS))).toBe(URLS[0]);
  });

  it("returns null for a paused / done / null queue", () => {
    expect(currentUrl(pause(makeBatchState(URLS)))).toBeNull();
    expect(currentUrl(makeBatchState([]))).toBeNull();
    expect(currentUrl(null)).toBeNull();
  });
});

describe("recordResult — advance", () => {
  it("captured++ and advances the pointer on success", () => {
    const s1 = recordResult(makeBatchState(URLS), true);
    expect(s1.index).toBe(1);
    expect(s1.captured).toBe(1);
    expect(s1.failed).toBe(0);
    expect(currentUrl(s1)).toBe(URLS[1]);
  });

  it("failed++ on a failure but still advances", () => {
    const s1 = recordResult(makeBatchState(URLS), false);
    expect(s1.index).toBe(1);
    expect(s1.captured).toBe(0);
    expect(s1.failed).toBe(1);
  });

  it("flips to done after the last URL", () => {
    let s = makeBatchState(URLS);
    s = recordResult(s, true);
    s = recordResult(s, false);
    s = recordResult(s, true);
    expect(s.status).toBe(STATUSES.DONE);
    expect(s.captured).toBe(2);
    expect(s.failed).toBe(1);
    expect(currentUrl(s)).toBeNull();
  });

  it("is pure — does not mutate its argument", () => {
    const s0 = makeBatchState(URLS);
    recordResult(s0, true);
    expect(s0.index).toBe(0);
    expect(s0.captured).toBe(0);
  });

  it("leaves a non-running queue untouched (a late signal after stop)", () => {
    const stopped = stop(makeBatchState(URLS));
    expect(recordResult(stopped, true)).toBe(stopped);
  });
});

describe("pause / resume / stop", () => {
  it("pause halts a running queue and resume continues from the same index", () => {
    let s = recordResult(makeBatchState(URLS), true); // index 1
    s = pause(s);
    expect(s.status).toBe(STATUSES.PAUSED);
    expect(isActive(s)).toBe(false);
    const r = resume(s);
    expect(r.status).toBe(STATUSES.RUNNING);
    expect(currentUrl(r)).toBe(URLS[1]);
  });

  it("resume of a queue already past the end completes rather than re-runs", () => {
    let s = makeBatchState(["https://a/inmueble/1"]);
    s = pause(s);
    // force pointer to the end as if the last page settled while paused
    s = { ...s, index: 1 };
    expect(resume(s).status).toBe(STATUSES.DONE);
  });

  it("stop marks running or paused as done", () => {
    expect(stop(makeBatchState(URLS)).status).toBe(STATUSES.DONE);
    expect(stop(pause(makeBatchState(URLS))).status).toBe(STATUSES.DONE);
  });

  it("pause / resume are no-ops in the wrong state", () => {
    const running = makeBatchState(URLS);
    expect(resume(running)).toBe(running); // resume of running → unchanged
    const done = stop(running);
    expect(pause(done)).toBe(done);
  });
});

describe("progress", () => {
  it("reports total/done/captured/failed for the UI", () => {
    let s = makeBatchState(URLS);
    s = recordResult(s, true);
    s = recordResult(s, false);
    const p = progress(s);
    expect(p).toEqual({ total: 3, done: 2, captured: 1, failed: 1, status: STATUSES.RUNNING });
  });

  it("reports an empty done view for a null state", () => {
    expect(progress(null)).toEqual({
      total: 0,
      done: 0,
      captured: 0,
      failed: 0,
      status: STATUSES.DONE,
    });
  });
});

describe("jitterDelay", () => {
  it("returns base + a value within [0, spread) using the injected rng", () => {
    expect(jitterDelay(4000, 5000, () => 0)).toBe(4000);
    expect(jitterDelay(4000, 5000, () => 0.9999)).toBe(4000 + Math.floor(0.9999 * 5000));
    expect(jitterDelay(4000, 5000, () => 0.5)).toBe(4000 + Math.floor(0.5 * 5000));
  });

  it("clamps negative base/spread to 0", () => {
    expect(jitterDelay(-1, -1, () => 0.9)).toBe(0);
  });

  it("stays within bounds across many random draws (real Math.random)", () => {
    for (let i = 0; i < 200; i++) {
      const d = jitterDelay(4000, 5000);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(9000);
    }
  });
});

describe("paceBaseMs — gentle backoff for long sweeps (issue #262 follow-up)", () => {
  it("keeps the 4–9 s minimum at the start of a run", () => {
    expect(paceBaseMs(0)).toBe(4000);
    expect(paceBaseMs(24)).toBe(4000);
    // Combined with the 5000 spread, the actual dwell is [4000, 9000).
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

describe("shouldReattach — MV3 eviction recovery decision (issue #262 review)", () => {
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

describe("orphanTabToClose — reconcile the tab leaked at eviction (issue #262 review)", () => {
  const running = makeBatchState(URLS);

  it("returns the persisted tab id when the run is stranded", () => {
    expect(orphanTabToClose(running, false, 42)).toBe(42);
  });

  it("returns null when a loop is still alive (never disturb a live tab)", () => {
    expect(orphanTabToClose(running, true, 42)).toBeNull();
  });

  it("returns null when no tab id was persisted", () => {
    expect(orphanTabToClose(running, false, null)).toBeNull();
  });

  it("returns null for a paused/done queue even with a persisted id", () => {
    expect(orphanTabToClose(pause(running), false, 42)).toBeNull();
    expect(orphanTabToClose(stop(running), false, 42)).toBeNull();
  });
});
