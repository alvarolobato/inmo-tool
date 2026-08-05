/**
 * batch.js — Pure sequential-queue state for batch capture (issue #262).
 *
 * NO side effects at load time: no `chrome`/`window`/`document`/network. This
 * is the queue *logic* only — "which URL is next", "advance after a page
 * finished", "how long to wait before the next one". The chrome-API wiring that
 * actually opens/activates/closes tabs and listens for AUTO_CAPTURE_DONE lives
 * in background.js; keeping this file pure makes the advance/pacing decisions
 * unit-testable outside a browser (dashboard/__tests__/extension-batch.test.ts).
 *
 * Loaded into the service worker via `importScripts('batch.js')` (classic MV3
 * worker) and published on `self.InmoBatch`; also exported via CommonJS for the
 * tests.
 *
 * ── Why sequential, and why paced ──────────────────────────────────────────
 * The owner's north-star for #262 is "click once, do nothing else": the
 * extension opens each detail URL, activates the tab itself (an ACTIVE tab is
 * not subject to Chrome's background-tab render throttling, so auto-capture's
 * render wait actually completes), captures, closes it, and advances. This
 * REPLACES the earlier human-paced "open one tab per click" design
 * (lib/worklist.ts `firstPendingUrl`, see D-043) — but it deliberately keeps
 * real pacing between pages. An auto-advance loop that opens tab N+1 the instant
 * tab N captures is closer to bot navigation than the human-paced version it
 * replaces; Idealista/Aliseda both sit behind WAFs that a burst would trip. So
 * the queue advances ONE page at a time and background.js waits a JITTERED
 * (randomised, not fixed) delay between closing one tab and opening the next.
 */

(function () {
  "use strict";

  var STATUSES = { RUNNING: "running", PAUSED: "paused", DONE: "done" };

  /**
   * Build the initial queue state for a batch run over `urls` (already
   * de-duplicated pending URLs). Starts `running` at index 0. An empty list
   * starts already `done`.
   */
  function makeBatchState(urls) {
    var list = Array.isArray(urls) ? urls.filter(function (u) {
      return typeof u === "string" && u.length > 0;
    }) : [];
    return {
      urls: list,
      index: 0,
      captured: 0,
      failed: 0,
      status: list.length > 0 ? STATUSES.RUNNING : STATUSES.DONE,
    };
  }

  /**
   * The URL the loop should open right now, or null. Only a `running` queue
   * with an in-range index has a current URL — a paused/done queue yields null
   * so background.js's loop naturally halts.
   */
  function currentUrl(state) {
    if (!state || state.status !== STATUSES.RUNNING) return null;
    if (state.index < 0 || state.index >= state.urls.length) return null;
    return state.urls[state.index];
  }

  /**
   * Record the outcome of the current page and advance. `ok` true → captured++,
   * false (timed out / enqueue failed) → failed++. Advancing past the last URL
   * flips the queue to `done`. A queue that isn't `running` is returned
   * unchanged (a late signal after a stop/pause must not move the pointer).
   * Returns a NEW state object (pure — never mutates its argument), so the
   * caller can persist it verbatim to chrome.storage.session.
   */
  function recordResult(state, ok) {
    if (!state || state.status !== STATUSES.RUNNING) return state;
    var next = {
      urls: state.urls,
      index: state.index + 1,
      captured: state.captured + (ok ? 1 : 0),
      failed: state.failed + (ok ? 0 : 1),
      status: state.status,
    };
    if (next.index >= next.urls.length) next.status = STATUSES.DONE;
    return next;
  }

  /** Pause a running queue (no-op otherwise). Returns a new state. */
  function pause(state) {
    if (!state || state.status !== STATUSES.RUNNING) return state;
    return Object.assign({}, state, { status: STATUSES.PAUSED });
  }

  /**
   * Resume a paused queue. If the pointer is already past the end, resuming
   * completes it rather than re-running (defensive). Returns a new state.
   */
  function resume(state) {
    if (!state || state.status !== STATUSES.PAUSED) return state;
    var status =
      state.index >= state.urls.length ? STATUSES.DONE : STATUSES.RUNNING;
    return Object.assign({}, state, { status: status });
  }

  /** Stop a queue outright (running or paused → done). Returns a new state. */
  function stop(state) {
    if (!state) return state;
    if (state.status === STATUSES.DONE) return state;
    return Object.assign({}, state, { status: STATUSES.DONE });
  }

  /** True while there is still work the loop should be driving. */
  function isActive(state) {
    return !!state && state.status === STATUSES.RUNNING;
  }

  /**
   * A compact, UI-friendly view of progress (what the popup renders as N/M).
   * `done` is how many pages have been processed (captured + failed), so an
   * in-flight page counts once it settles, not while it's open.
   */
  function progress(state) {
    if (!state) {
      return { total: 0, done: 0, captured: 0, failed: 0, status: STATUSES.DONE };
    }
    return {
      total: state.urls.length,
      done: state.captured + state.failed,
      captured: state.captured,
      failed: state.failed,
      status: state.status,
    };
  }

  /**
   * Milliseconds to wait between closing one tab and opening the next. A
   * RANDOMISED delay (base + up to `spread`), not a fixed interval, so the
   * cadence doesn't read as a metronome to a WAF (see the module header / D-043).
   * `rnd` is injectable (defaults to Math.random) purely so the delay is
   * deterministic under test.
   */
  function jitterDelay(base, spread, rnd) {
    var r = typeof rnd === "function" ? rnd : Math.random;
    var b = base > 0 ? base : 0;
    var s = spread > 0 ? spread : 0;
    return b + Math.floor(r() * s);
  }

  // ── Long-run gentle backoff (issue #262 follow-up) ─────────────────────────
  // A 100+ listing sweep is 10–15 min of steady automated navigation — the most
  // likely rate-trip scenario. Rather than cap the run (and make the operator
  // click again), the dwell BASE lengthens as the run gets long, so late pages
  // are spaced further apart. The mandatory 4–9 s minimum is preserved: at
  // processed=0 the base is PACE_MIN_BASE_MS and jitterDelay(base, 5000) is
  // [4000, 9000). The extra is stepwise and capped.
  var PACE_MIN_BASE_MS = 4000;
  var PACE_STEP_EVERY = 25; // add one step per this many processed pages
  var PACE_STEP_MS = 2000; // size of each step
  var PACE_MAX_EXTRA_MS = 12000; // cap: base never exceeds MIN + this

  /**
   * The dwell BASE (ms) for the next page given how many have already been
   * processed. `jitterDelay(paceBaseMs(done), spread)` gives the actual pause.
   * Pure; never below PACE_MIN_BASE_MS, never above MIN + PACE_MAX_EXTRA_MS.
   */
  function paceBaseMs(processed) {
    var n = processed > 0 ? Math.floor(processed) : 0;
    var extra = Math.floor(n / PACE_STEP_EVERY) * PACE_STEP_MS;
    if (extra > PACE_MAX_EXTRA_MS) extra = PACE_MAX_EXTRA_MS;
    return PACE_MIN_BASE_MS + extra;
  }

  // ── MV3 eviction recovery (issue #262 review) ──────────────────────────────
  // The driver loop is in-memory; only START/RESUME (re)start it. If Chrome
  // evicts the worker mid-run, the persisted state stays `running` but no loop
  // is driving it. A watchdog (chrome.alarms + onStartup, plus a popup open)
  // calls back into these pure predicates to decide whether to re-attach.

  /**
   * True when a respawned worker should re-attach the driver: the persisted
   * queue is still `running` but no in-memory loop is active. False when the
   * loop is already running (nothing stranded), or the queue is paused/done.
   */
  function shouldReattach(state, looping) {
    return isActive(state) && !looping;
  }

  /**
   * The tab id a re-attaching worker must reconcile (close) before resuming, or
   * null. When we re-attach after an eviction, the tab that was open at
   * eviction time is orphaned (its in-memory id was lost) — return the id
   * persisted for it so the caller can close it. Returns null when nothing is
   * stranded or no tab id was persisted (so a live loop is never disturbed).
   */
  function orphanTabToClose(state, looping, persistedTabId) {
    if (!shouldReattach(state, looping)) return null;
    if (persistedTabId == null) return null;
    return persistedTabId;
  }

  var api = {
    STATUSES: STATUSES,
    makeBatchState: makeBatchState,
    currentUrl: currentUrl,
    recordResult: recordResult,
    pause: pause,
    resume: resume,
    stop: stop,
    isActive: isActive,
    progress: progress,
    jitterDelay: jitterDelay,
    paceBaseMs: paceBaseMs,
    shouldReattach: shouldReattach,
    orphanTabToClose: orphanTabToClose,
  };

  if (typeof self !== "undefined") {
    self.InmoBatch = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
