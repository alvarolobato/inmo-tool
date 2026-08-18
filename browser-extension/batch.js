/**
 * batch.js — Pure bounded-concurrency queue state for batch capture (issue #262,
 * concurrency in #318).
 *
 * NO side effects at load time: no `chrome`/`window`/`document`/network. This
 * is the queue *logic* only — "which URLs may I launch now", "record that one
 * finished", "how long to jitter between launches". The chrome-API wiring that
 * actually opens/activates/closes tabs and listens for AUTO_CAPTURE_DONE lives
 * in background.js; keeping this file pure makes the scheduling/pacing decisions
 * unit-testable outside a browser (dashboard/__tests__/extension-batch.test.ts).
 *
 * Loaded into the service worker via `importScripts('batch.js')` (classic MV3
 * worker) and published on `self.InmoBatch`; also exported via CommonJS for the
 * tests.
 *
 * ── Bounded concurrency, and why it stays paced ─────────────────────────────
 * The owner's north-star for #262 is "click once, do nothing else": the
 * extension opens each detail URL, activates the tab itself (an ACTIVE tab is
 * not subject to Chrome's background-tab render throttling, so auto-capture's
 * render wait actually completes), captures, closes it, and advances.
 *
 * The original #262 design drove this STRICTLY SEQUENTIALLY — one tab at a
 * time. The owner (#318) found that too slow on long idealista sweeps and asked
 * for several tabs open at once with random waits. So the queue is now a
 * BOUNDED-CONCURRENCY scheduler: up to N tabs in flight at a time (N is small
 * and CAPPED), each launch STAGGERED by a jittered/random delay — never a
 * simultaneous burst. Two hard constraints keep N small (see D-043):
 *   1. WAF safety. Idealista (CAPTCHA wall) and Aliseda (`Disallow: /`, D-019)
 *      punish bursts. Bounded + jittered launches read as human-ish browsing,
 *      an unbounded wall of tabs reads as a bot.
 *   2. Chrome background-tab render throttling. Only the ACTIVE tab renders
 *      reliably; unfocused tabs' JS/rendering is deferred. In the default
 *      (safe) mode each launch activates its new tab
 *      (`chrome.tabs.create({active:true})`), so the jittered stagger gives
 *      every tab a foreground window to render+capture before the next launch
 *      steals focus. Too-high N means later in-flight tabs sit throttled in the
 *      background and time out — MORE concurrency past a small N HURTS
 *      reliability rather than helping. N=3 balances throughput against that.
 *
 * ── Making the dials configurable (issue #410) ──────────────────────────────
 * The owner found the conservative defaults too slow on idealista sweeps and
 * asked for a faster cadence WITHOUT removing the safety. So:
 *   • Concurrency, stagger base, and stagger spread are now user-tunable
 *     (extension options → chrome.storage.sync), still validated/clamped here.
 *   • The ceiling was raised (MAX_CONCURRENCY 5→8) and the default stagger base
 *     lowered (4000→2000 ms) for a faster out-of-the-box cadence. The
 *     speed/reliability/WAF trade-off: higher N + shorter stagger = faster, but
 *     each in-flight tab gets a shorter foreground window before the next launch
 *     steals focus, so past a point later tabs sit throttled and time out, AND a
 *     denser launch cadence is more bot-like to a WAF. The jitter/spread and the
 *     long-run backoff below are always kept — they are the WAF guarantee.
 *   • A "background-tab" mode (`chrome.tabs.create({active:false})`) is exposed
 *     as an OPT-IN toggle (default OFF = the safe active mode). A new tab's
 *     INITIAL load + render generally still happens even unfocused (Chrome
 *     throttles long-running background TIMERS, not necessarily the first paint),
 *     so for fast-rendering portals this can lift real parallelism without
 *     stealing focus. It is opt-in because reliability on JS-heavy SPAs can't be
 *     guaranteed from the Chrome APIs alone — the owner enables it and watches
 *     the N/M captured ratio. See background.js captureOnePage + D-043.
 *
 * State model — a per-URL slot array (so out-of-order settlement and MV3
 * eviction recovery are both exact):
 *   slots[i] ∈ { pending, inflight, captured, failed }
 * The scheduler launches the first `pending` slot while `inflightCount <
 * concurrency`; a settle flips a slot to captured/failed; the run is `done`
 * when nothing is pending and nothing is in flight. On eviction the slot array
 * (with any `inflight`) is persisted, and a respawned worker resets `inflight →
 * pending` (those tabs are gone) and re-launches them — safe because capture is
 * idempotent (worklist `match_key` + the content-script fire-once guard).
 */

(function () {
  "use strict";

  var STATUSES = { RUNNING: "running", PAUSED: "paused", DONE: "done" };
  // Per-URL slot lifecycle: pending → inflight → captured | failed.
  var SLOT = {
    PENDING: "pending",
    INFLIGHT: "inflight",
    CAPTURED: "captured",
    FAILED: "failed",
  };

  // How many detail tabs may be open (in flight) at once. Small on purpose —
  // WAF safety + Chrome background-tab render throttling (see the module
  // header / D-043). DEFAULT is the balanced pick; MAX is a hard clamp so a
  // bad/hostile config can never turn the run into an unbounded tab burst.
  var DEFAULT_CONCURRENCY = 3;
  // Ceiling raised 5→8 for issue #410 so the owner can push throughput. It stays
  // a HARD clamp: even a hostile/garbage config can never turn the run into an
  // unbounded tab burst. Past this, background-tab throttling + WAF risk make
  // more concurrency counter-productive — see the module header trade-off note.
  var MAX_CONCURRENCY = 8;

  /** Clamp a requested concurrency to [1, MAX_CONCURRENCY]; default when absent/garbage. */
  function clampConcurrency(n) {
    var c = typeof n === "number" && n > 0 ? Math.floor(n) : DEFAULT_CONCURRENCY;
    if (c < 1) c = 1;
    if (c > MAX_CONCURRENCY) c = MAX_CONCURRENCY;
    return c;
  }

  // ── User-tunable pacing bounds (issue #410) ────────────────────────────────
  // The stagger BASE and SPREAD are configurable from the extension options, but
  // always validated/clamped here so a bad value can never remove the WAF-safety
  // stagger entirely or set an absurd dwell. DEFAULT_PACE_BASE_MS was lowered
  // 4000→2000 for a faster default cadence (with the default 5000 spread the
  // opening launches land in [2000, 7000) ms instead of [4000, 9000)).
  var DEFAULT_PACE_BASE_MS = 2000;
  var MIN_PACE_BASE_MS = 500; // floor: never fully remove the stagger (WAF)
  var MAX_PACE_BASE_MS = 30000;
  var DEFAULT_PACE_SPREAD_MS = 5000; // jitter width — unchanged default
  var MIN_PACE_SPREAD_MS = 0;
  var MAX_PACE_SPREAD_MS = 30000;

  /** Clamp an integer into [lo, hi], falling back to `dflt` for absent/garbage. */
  function clampInt(n, lo, hi, dflt) {
    var v = typeof n === "number" && isFinite(n) ? Math.floor(n) : dflt;
    if (v < lo) v = lo;
    if (v > hi) v = hi;
    return v;
  }

  /** Clamp a requested stagger base (ms) to [MIN,MAX]; default when absent/garbage. */
  function clampPaceBase(n) {
    return clampInt(n, MIN_PACE_BASE_MS, MAX_PACE_BASE_MS, DEFAULT_PACE_BASE_MS);
  }

  /** Clamp a requested stagger spread (ms) to [MIN,MAX]; default when absent/garbage. */
  function clampSpread(n) {
    return clampInt(
      n,
      MIN_PACE_SPREAD_MS,
      MAX_PACE_SPREAD_MS,
      DEFAULT_PACE_SPREAD_MS,
    );
  }

  /**
   * Build the initial queue state for a batch run over `urls` (already
   * de-duplicated pending URLs), with up to `concurrency` tabs in flight.
   * Every slot starts `pending`. Starts `running`; an empty list starts `done`.
   *
   * `emptyReason` (issue #554, optional) is attached only when the list is
   * empty — a classification (see `classifyEmptyCapture`/`EMPTY_REASON`
   * below) of WHY there's nothing to capture, so the popup can explain a 0/0
   * instead of showing a bare, confusing one.
   */
  function makeBatchState(urls, concurrency, emptyReason) {
    var list = Array.isArray(urls)
      ? urls.filter(function (u) {
          return typeof u === "string" && u.length > 0;
        })
      : [];
    var state = {
      urls: list,
      slots: list.map(function () {
        return SLOT.PENDING;
      }),
      concurrency: clampConcurrency(concurrency),
      status: list.length > 0 ? STATUSES.RUNNING : STATUSES.DONE,
    };
    if (list.length === 0 && typeof emptyReason === "string") {
      state.emptyReason = emptyReason;
    }
    return state;
  }

  /** Count slots in a given state (0 for a malformed state). */
  function countSlot(state, kind) {
    var slots = state && state.slots;
    if (!slots) return 0;
    var n = 0;
    for (var i = 0; i < slots.length; i++) if (slots[i] === kind) n++;
    return n;
  }

  /** How many tabs are currently in flight. */
  function inflightCount(state) {
    return countSlot(state, SLOT.INFLIGHT);
  }

  /** Index of the first `pending` slot, or -1 if none remain. */
  function firstPendingIndex(state) {
    var slots = state && state.slots;
    if (!slots) return -1;
    for (var i = 0; i < slots.length; i++) {
      if (slots[i] === SLOT.PENDING) return i;
    }
    return -1;
  }

  /**
   * May the driver launch another tab right now? True only when the queue is
   * running, we're below the concurrency cap, and at least one URL is pending.
   * A paused/done queue (or a full in-flight pool) yields false so the driver
   * naturally stops opening new tabs.
   */
  function canLaunch(state) {
    if (!state || state.status !== STATUSES.RUNNING) return false;
    if (inflightCount(state) >= state.concurrency) return false;
    return firstPendingIndex(state) !== -1;
  }

  /**
   * Claim the next pending URL for launch. Returns `{ state, index, url }` with
   * the chosen slot flipped to `inflight` on a NEW state (pure — never mutates
   * its argument). When nothing may be launched, returns the state unchanged
   * with `{ index: -1, url: null }`.
   */
  function launchNext(state) {
    if (!canLaunch(state)) return { state: state, index: -1, url: null };
    var i = firstPendingIndex(state);
    var slots = state.slots.slice();
    slots[i] = SLOT.INFLIGHT;
    return {
      state: Object.assign({}, state, { slots: slots }),
      index: i,
      url: state.urls[i],
    };
  }

  /**
   * Record the outcome of the in-flight page at `index` and return a NEW state
   * (pure). `ok` true → that slot becomes `captured`, false → `failed`. When no
   * slot is left pending or in flight, a running queue flips to `done`. Ignored
   * (state returned unchanged) if the queue is already `done` — a late signal
   * after a stop must not resurrect counts — or if `index` isn't an in-flight
   * slot (a duplicate/stray signal). Settlement may arrive OUT OF ORDER across
   * the concurrent tabs; addressing the exact slot keeps counts exact.
   */
  function recordResultAt(state, index, ok) {
    if (!state || !state.slots || state.status === STATUSES.DONE) return state;
    if (index < 0 || index >= state.slots.length) return state;
    if (state.slots[index] !== SLOT.INFLIGHT) return state;
    var slots = state.slots.slice();
    slots[index] = ok ? SLOT.CAPTURED : SLOT.FAILED;
    var next = Object.assign({}, state, { slots: slots });
    if (
      state.status === STATUSES.RUNNING &&
      firstPendingIndex(next) === -1 &&
      inflightCount(next) === 0
    ) {
      next.status = STATUSES.DONE;
    }
    return next;
  }

  /**
   * Reset every `inflight` slot back to `pending` (pure). Used on MV3
   * eviction-recovery: the tabs those slots referred to were orphaned and
   * closed, so their work must be re-launched. No-op when nothing is in flight.
   */
  function resetInflightToPending(state) {
    if (!state || !state.slots || inflightCount(state) === 0) return state;
    var slots = state.slots.map(function (s) {
      return s === SLOT.INFLIGHT ? SLOT.PENDING : s;
    });
    return Object.assign({}, state, { slots: slots });
  }

  /** Pause a running queue (no-op otherwise). Returns a new state. */
  function pause(state) {
    if (!state || state.status !== STATUSES.RUNNING) return state;
    return Object.assign({}, state, { status: STATUSES.PAUSED });
  }

  /**
   * Resume a paused queue. If nothing is left to do (no pending, none in
   * flight), resuming completes it rather than re-running (defensive). Returns
   * a new state.
   */
  function resume(state) {
    if (!state || state.status !== STATUSES.PAUSED) return state;
    var complete =
      firstPendingIndex(state) === -1 && inflightCount(state) === 0;
    return Object.assign({}, state, {
      status: complete ? STATUSES.DONE : STATUSES.RUNNING,
    });
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
   * `done` is how many pages have settled (captured + failed); `inflight` is how
   * many tabs are open right now.
   */
  function progress(state) {
    if (!state || !state.slots) {
      return {
        total: 0,
        done: 0,
        captured: 0,
        failed: 0,
        inflight: 0,
        status: STATUSES.DONE,
        emptyReason: null,
      };
    }
    var captured = countSlot(state, SLOT.CAPTURED);
    var failed = countSlot(state, SLOT.FAILED);
    return {
      total: state.urls.length,
      done: captured + failed,
      captured: captured,
      failed: failed,
      inflight: inflightCount(state),
      status: state.status,
      // issue #554: why a 0-total run is empty (already drained by an earlier
      // same-portal search vs. genuinely no results) — null when not
      // applicable (a non-empty run, or an empty one with no classification).
      emptyReason: state.emptyReason || null,
    };
  }

  /**
   * Milliseconds to wait between one tab LAUNCH and the next. A RANDOMISED
   * delay (base + up to `spread`), not a fixed interval, so the launch cadence
   * doesn't read as a metronome to a WAF (see the module header / D-043). With
   * bounded concurrency this delay is what staggers the launches — it is the
   * pacing guarantee that keeps N tabs from opening simultaneously.
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
  // click again), the launch-stagger BASE lengthens as the run gets long, so
  // late launches are spaced further apart. The configured minimum base is
  // preserved: at processed=0 the base is `minBase` (the user's stagger base,
  // default DEFAULT_PACE_BASE_MS=2000) and jitterDelay(base, spread) is
  // [minBase, minBase+spread). The extra is stepwise and capped.
  var PACE_STEP_EVERY = 25; // add one step per this many processed pages
  var PACE_STEP_MS = 2000; // size of each step
  var PACE_MAX_EXTRA_MS = 12000; // cap: base never exceeds minBase + this

  /**
   * The launch-stagger BASE (ms) given how many pages have already settled and
   * the configured minimum base `minBase` (issue #410 — user-tunable; clamped,
   * defaults to DEFAULT_PACE_BASE_MS when absent). `jitterDelay(paceBaseMs(done,
   * base), spread)` gives the actual pause between launches. Pure; never below
   * the clamped minBase, never above minBase + MAX_EXTRA.
   */
  function paceBaseMs(processed, minBase) {
    var base = clampPaceBase(minBase);
    var n = processed > 0 ? Math.floor(processed) : 0;
    var extra = Math.floor(n / PACE_STEP_EVERY) * PACE_STEP_MS;
    if (extra > PACE_MAX_EXTRA_MS) extra = PACE_MAX_EXTRA_MS;
    return base + extra;
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
   * The tab ids a re-attaching worker must reconcile (close) before resuming.
   * With bounded concurrency there may be several tabs open at eviction time;
   * their ids are persisted alongside the state, and this returns the subset
   * worth closing (numeric ids) — but ONLY when the run is genuinely stranded,
   * so a live loop's tabs are never disturbed. Returns [] when not stranded or
   * no ids were persisted.
   */
  function orphanTabsToClose(state, looping, persistedTabIds) {
    if (!shouldReattach(state, looping)) return [];
    if (!Array.isArray(persistedTabIds)) return [];
    return persistedTabIds.filter(function (id) {
      return typeof id === "number";
    });
  }

  /**
   * makeSerializer() → run(fn): an in-memory async mutex (issue #321).
   *
   * Returns a `run` that chains each call onto the previous one's completion,
   * so overlapping callers execute their async `fn` strictly one-at-a-time.
   * background.js wraps it around every `chrome.storage.session` get-modify-set
   * of the shared batch state: with bounded concurrency (#318) two tabs can
   * settle in the same tick and interleave their read → modify → write,
   * lost-updating one another's slot flip. Serializing the critical section
   * removes the interleave so no write is clobbered.
   *
   * Each call resolves/rejects with its OWN `fn`'s outcome; a rejection does
   * not break the chain for later callers (the tail advances past both
   * fulfilment and rejection). Pure — Promises only, no chrome/DOM — so it lives
   * here with the rest of the unit-testable queue logic and is MV3-safe with no
   * dependency.
   */
  function makeSerializer() {
    var tail = Promise.resolve();
    function noop() {}
    return function run(fn) {
      var result = tail.then(fn);
      // Advance the chain past this section regardless of its success/failure,
      // but hand the caller its real outcome (don't swallow a rejection).
      tail = result.then(noop, noop);
      return result;
    };
  }

  // ═══ Auto-capture continuous driver (issue #424) ══════════════════════════
  //
  // "Auto" mode drains the WHOLE worklist unattended: fetch the next ≤N pending
  // URLs (prioritised), run the existing bounded-concurrency batch over them,
  // wait a configured timeout, then repeat — until the operator turns Auto off
  // or the worklist empties (it then slow-polls in case new work arrives). The
  // SCHEDULING is alarm-driven in background.js — a `setTimeout` in an MV3
  // service worker dies with the worker — so this file holds only the PURE
  // decisions, unit-testable outside a browser:
  //   • how big a batch may be / how long to wait between batches (clamped)
  //   • which pending URLs go in the next batch  → selectNextPending
  //   • whether to keep going or stop            → shouldContinueAuto
  //   • what the alarm tick should do next        → nextAutoAction
  // The actual tab-driving reuses the SAME bounded-concurrency queue above
  // (makeBatchState/launchNext/…), so Auto never exceeds `concurrency` and keeps
  // the WAF-safe jittered stagger; the inter-batch timeout is the extra cooldown.

  var AUTO_STATUS = {
    IDLE: "idle", // never started / freshly created
    PLANNING: "planning", // asking the server for the next unit (issue #516)
    HARVESTING: "harvesting", // running a discovery→seed→capture harvest (#516)
    RUNNING: "running", // a (drain) capture batch is in flight right now
    WAITING: "waiting", // between units, cooling down for the timeout
    EMPTY: "empty", // nothing due / pending; slow-polling for new work
    STOPPED: "stopped", // operator turned Auto off
  };

  // Batch size (N): how many pending URLs one auto batch drains. Default 100
  // (issue #424). Bounded so a bad config can never open an unbounded run; the
  // server endpoint clamps `limit` independently, so N is capped on both sides.
  var DEFAULT_AUTO_BATCH_SIZE = 100;
  var MIN_AUTO_BATCH_SIZE = 1;
  var MAX_AUTO_BATCH_SIZE = 500;
  // Timeout between batches (seconds): the WAF-friendly cooldown on top of the
  // per-launch jittered stagger. Default 60 s. The floor is 30 s because Chrome
  // clamps alarms shorter than ~30 s up to 30 s anyway — a smaller value would
  // lie about the real wait (documented in background.js scheduleAutoAlarm).
  var DEFAULT_AUTO_TIMEOUT_SEC = 60;
  var MIN_AUTO_TIMEOUT_SEC = 30;
  var MAX_AUTO_TIMEOUT_SEC = 3600;

  /** Clamp a requested auto batch size (N) to [MIN,MAX]; default when absent/garbage. */
  function clampAutoBatchSize(n) {
    return clampInt(
      n,
      MIN_AUTO_BATCH_SIZE,
      MAX_AUTO_BATCH_SIZE,
      DEFAULT_AUTO_BATCH_SIZE,
    );
  }

  /** Clamp a requested inter-batch timeout (s) to [MIN,MAX]; default when absent/garbage. */
  function clampAutoTimeoutSec(n) {
    return clampInt(
      n,
      MIN_AUTO_TIMEOUT_SEC,
      MAX_AUTO_TIMEOUT_SEC,
      DEFAULT_AUTO_TIMEOUT_SEC,
    );
  }

  /**
   * Build the durable auto-mode state (persisted in chrome.storage.session so it
   * survives MV3 eviction). `portal` null means "drain every portal". `batchSize`
   * / `timeoutSec` are clamped. `force` (issue #434, default false) is the
   * "Forzar" toggle: when true, auto re-captures even not-due / already-done
   * listings (the driver requests `dueOnly=0`); when false it captures only due
   * work. Starts IDLE with no batches done.
   */
  function makeAutoState(opts) {
    opts = opts || {};
    return {
      enabled: opts.enabled === true,
      portal:
        typeof opts.portal === "string" && opts.portal ? opts.portal : null,
      batchSize: clampAutoBatchSize(opts.batchSize),
      timeoutSec: clampAutoTimeoutSec(opts.timeoutSec),
      force: opts.force === true,
      status:
        typeof opts.status === "string" ? opts.status : AUTO_STATUS.IDLE,
      batchesDone:
        typeof opts.batchesDone === "number" && opts.batchesDone > 0
          ? Math.floor(opts.batchesDone)
          : 0,
      lastBatchAt:
        typeof opts.lastBatchAt === "number" ? opts.lastBatchAt : null,
      totalPending:
        typeof opts.totalPending === "number" && opts.totalPending >= 0
          ? Math.floor(opts.totalPending)
          : null,
      // The harvest unit in flight (issue #516), persisted so a worker eviction
      // mid-harvest can still record the task run on completion (else auto would
      // re-harvest the same due task forever). null when the current unit is a
      // drain / idle, or nothing is in flight. Shape: { profileId, taskId,
      // portal, url }.
      harvestTask:
        opts.harvestTask && typeof opts.harvestTask === "object"
          ? opts.harvestTask
          : null,
    };
  }

  /**
   * Continue-or-stop decision for the auto loop: keep going only while Auto is
   * enabled AND there is at least one pending URL. Pure. When this is false the
   * driver either stops (disabled) or slow-polls for new work (drained).
   */
  function shouldContinueAuto(state, pendingCount) {
    return !!state && state.enabled === true && pendingCount > 0;
  }

  // Portal not covered by any profile task → back of the queue, but still
  // eligible (sitemap-seeded / derived URLs). Kept well above any real
  // connector rank (due=0 / half-done=1 / not-due=2, see worklist-priority.ts).
  var AUTO_PORTAL_RANK_UNKNOWN = 99;

  // Rank AT OR ABOVE which a portal is NOT due this cycle (issue #434). The
  // #414 ranks are due=0 < half-done=1 < not-due=2 < unknown=99; a portal is
  // "due" (auto should capture it now) only when it has at least one due task
  // — i.e. rank 0 (due) or 1 (half-done). not-due (2, al día within the
  // staleness window) and unknown (99, no connector/profile → no staleness
  // window to respect) are NOT due, so due-only mode skips them (the operator
  // uses "Forzar" or a manual batch to re-capture those). Mirror of
  // lib/worklist.ts PORTAL_RANK_NOT_DUE.
  var PORTAL_RANK_NOT_DUE = 2;

  /**
   * Is this portal DUE this cycle, given its #414 due-rank? Pure. A due portal
   * has rank < PORTAL_RANK_NOT_DUE (0 due, or 1 half-done). Anything else — al
   * día (2), unknown/no-connector (99), or a non-finite rank — is NOT due.
   */
  function isPortalDue(rank) {
    return typeof rank === "number" && isFinite(rank) && rank < PORTAL_RANK_NOT_DUE;
  }

  function rankForItem(item, duePriorityByPortal) {
    if (!item) return AUTO_PORTAL_RANK_UNKNOWN;
    var r =
      duePriorityByPortal && typeof duePriorityByPortal === "object"
        ? duePriorityByPortal[item.portal]
        : undefined;
    return typeof r === "number" && isFinite(r) ? r : AUTO_PORTAL_RANK_UNKNOWN;
  }

  function tsForItem(item) {
    if (!item || item.createdAt == null) return Number.MAX_SAFE_INTEGER;
    var t =
      typeof item.createdAt === "number"
        ? item.createdAt
        : Date.parse(item.createdAt);
    return isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Choose the next auto batch: the first `limit` pending items ordered by portal
   * due-priority (asc — a due portal drains before a half-done one before an "al
   * día" one, mirroring the #414 logic) then oldest `createdAt` (asc). Pure and
   * STABLE — the original input order breaks any remaining tie. Each item is
   * `{ url, portal, createdAt }`; the returned slice preserves that shape so the
   * caller reads `.url`.
   *
   * `dueOnly` (issue #434, default false): when true, FILTER OUT items whose
   * portal is not due this cycle ({@link isPortalDue}) BEFORE ranking/slicing —
   * so auto captures only work whose connector's staleness window has elapsed.
   * When it filters everything out the result is `[]`, which the driver reads as
   * "nothing due" → it idles until the next tick (never spins). `dueOnly=false`
   * (the "Forzar" toggle) keeps the full pending set so already-done / not-due
   * listings are re-captured. This is the SERVER-mirror of
   * lib/worklist.ts `selectNextPendingUrls`; the two must stay in step.
   */
  function selectNextPending(items, duePriorityByPortal, limit, dueOnly) {
    var lim = typeof limit === "number" && limit > 0 ? Math.floor(limit) : 0;
    if (lim === 0) return [];
    var list = Array.isArray(items) ? items : [];
    if (dueOnly === true) {
      list = list.filter(function (it) {
        return isPortalDue(rankForItem(it, duePriorityByPortal));
      });
    }
    var indexed = list.map(function (it, i) {
      return { it: it, i: i };
    });
    indexed.sort(function (a, b) {
      var ra = rankForItem(a.it, duePriorityByPortal);
      var rb = rankForItem(b.it, duePriorityByPortal);
      if (ra !== rb) return ra - rb;
      var ta = tsForItem(a.it);
      var tb = tsForItem(b.it);
      if (ta !== tb) return ta - tb;
      return a.i - b.i; // stable
    });
    return indexed.slice(0, lim).map(function (x) {
      return x.it;
    });
  }

  /**
   * Decide what the alarm tick should do, from the persisted auto state plus the
   * live runtime facts. Pure — background.js performs the side effects. Both the
   * one-shot inter-batch alarm and the periodic watchdog call this, so it must be
   * idempotent about ordering.
   *
   *   opts.batchActive : is a capture batch (auto OR manual) in flight right now?
   *   opts.now         : Date.now() ms (defaults to real now)
   *
   * Returns one of:
   *   'idle'     — Auto is off; disarm the alarm.
   *   'defer'    — a batch is running; do nothing, re-check next tick.
   *   'complete' — our unit just finished (was RUNNING drain, or HARVESTING with
   *                nothing now active) → record it and begin the cooldown. For a
   *                harvest, background.js also POSTs the task run before cooling.
   *   'wait'     — cooling down; the timeout has not elapsed yet.
   *   'start'    — never ran, the timeout elapsed, or PLANNING was stranded
   *                (evicted before a unit ran) → fetch + start the next unit.
   *
   * PLANNING (issue #516) is transient — set while the driver fetches the next
   * unit from /api/etl/auto-plan. If the worker is evicted during that window,
   * no batch is active and re-planning is safe (the GET is idempotent), so a
   * stranded PLANNING re-starts. HARVESTING is treated like RUNNING for the
   * finish transition; the difference (recording the task run) is background's.
   */
  function nextAutoAction(state, opts) {
    opts = opts || {};
    if (!state || state.enabled !== true) return "idle";
    if (opts.batchActive === true) return "defer";
    if (
      state.status === AUTO_STATUS.RUNNING ||
      state.status === AUTO_STATUS.HARVESTING
    ) {
      return "complete";
    }
    if (state.status === AUTO_STATUS.PLANNING) return "start";
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var timeoutMs = clampAutoTimeoutSec(state.timeoutSec) * 1000;
    if (state.lastBatchAt == null) return "start";
    if (now - state.lastBatchAt >= timeoutMs) return "start";
    return "wait";
  }

  // ═══ Pending-search queue (issue #554) ═════════════════════════════════════
  //
  // The owner fires off several searches (different zones/portals) back to
  // back and wants the extension to work through them one at a time, instead
  // of a second START_BATCH clobbering the first run's state (the bug this
  // issue fixes — see D-043's single BATCH_KEY design and the extension
  // record for #554). This is a SEPARATE queue of not-yet-started searches,
  // never a second concurrent run: D-043's bounded concurrency + jittered
  // pacing govern how ONE run behaves and are completely untouched here. Two
  // searches never run at once — the WAF-safety envelope is per-browser, not
  // per-search.
  //
  // Entries are plain `{ portal, searchUrl, urls }` objects (urls = the
  // harvested page-1 detail URLs, same shape START_BATCH already carries).
  // Pure array operations only — background.js persists the array in
  // chrome.storage.session (matching BATCH_KEY's lifetime) and decides WHEN
  // to enqueue/dequeue (a run is active vs. idle) and what to do with the
  // popped entry (kick off the same enumerate→capture flow startBatch uses).

  /** A fresh, empty pending-search queue. */
  function makeSearchQueue() {
    return [];
  }

  /**
   * Validate + normalize one queue entry. Returns null (drop it) when `portal`
   * is missing — everything else defaults defensively so a malformed message
   * can never corrupt the persisted queue.
   */
  function normalizeSearchEntry(entry) {
    if (!entry || typeof entry.portal !== "string" || !entry.portal) {
      return null;
    }
    var urls = Array.isArray(entry.urls)
      ? entry.urls.filter(function (u) {
          return typeof u === "string" && u.length > 0;
        })
      : [];
    return {
      portal: entry.portal,
      searchUrl:
        typeof entry.searchUrl === "string" && entry.searchUrl
          ? entry.searchUrl
          : null,
      urls: urls,
    };
  }

  /**
   * Append one search to the queue (pure — returns a NEW array). An invalid
   * entry (see normalizeSearchEntry) is silently dropped, so a bad message can
   * never wedge the queue with junk.
   */
  function enqueueSearch(queue, entry) {
    var q = Array.isArray(queue) ? queue.slice() : [];
    var norm = normalizeSearchEntry(entry);
    if (!norm) return q;
    q.push(norm);
    return q;
  }

  /**
   * Pop the first queued search (FIFO — searches run in the order they were
   * fired off). Pure. Returns `{ queue, entry }`; `entry` is null (queue
   * returned unchanged) when there was nothing to pop.
   */
  function dequeueSearch(queue) {
    var q = Array.isArray(queue) ? queue.slice() : [];
    if (q.length === 0) return { queue: q, entry: null };
    var entry = q.shift();
    return { queue: q, entry: entry };
  }

  /**
   * Remove the queued search at `index` (pure — returns a NEW array). An
   * out-of-range / non-numeric index is a no-op, so a stale popup click (the
   * list changed underneath it) can never remove the wrong entry.
   */
  function removeSearchAt(queue, index) {
    var q = Array.isArray(queue) ? queue.slice() : [];
    if (typeof index !== "number" || index < 0 || index >= q.length) return q;
    q.splice(index, 1);
    return q;
  }

  /** Empty the queue outright ("Vaciar cola"). */
  function clearSearchQueue() {
    return [];
  }

  /** How many searches are waiting (0 for a malformed/absent queue). */
  function searchQueueDepth(queue) {
    return Array.isArray(queue) ? queue.length : 0;
  }

  /** The next search that will start, or null when the queue is empty. */
  function peekNextSearch(queue) {
    return Array.isArray(queue) && queue.length > 0 ? queue[0] : null;
  }

  /**
   * Should the watchdog / a just-finished run's continuation pop and start the
   * next queued search right now? Only when NOTHING is currently running
   * (`runActive` — background.js's isBatchActive(), covering the live loop,
   * an in-progress enumeration, and a running/paused capture queue) AND at
   * least one search is waiting. Pure — background.js supplies both facts.
   *
   * This is also the exact predicate that makes eviction recovery work: if the
   * service worker dies in the gap between "the run just finished" and "the
   * queue got checked," `runActive` reads false (nothing survived the
   * eviction to claim otherwise) and a respawned worker's watchdog tick calls
   * this again and gets the same true, so the follow-up search is never
   * silently stranded.
   */
  function shouldAdvanceQueue(runActive, queueDepth) {
    return !runActive && typeof queueDepth === "number" && queueDepth > 0;
  }

  /**
   * Should a respawned worker recover a stranded ENUMERATION phase? Mirrors
   * `shouldReattach` for the capture queue, generalized to the phase that
   * precedes it (issue #554 — a stranded enumeration would otherwise make
   * `isBatchActive()` report "active" forever and wedge the pending-search
   * queue right behind it, in addition to the existing #516 concern that it
   * wedges Auto). True only when an enum state is persisted (`hasEnumState`)
   * AND nothing in THIS worker is actually walking it (`enumRunning` false)
   * AND no capture loop is driving (`batchLooping` false) AND no capture
   * queue is already active (`batchActive` false, e.g. a previous recovery
   * already handed off to it).
   */
  function shouldRecoverStrandedEnumeration(
    hasEnumState,
    enumRunning,
    batchLooping,
    batchActive,
  ) {
    if (!hasEnumState) return false;
    if (enumRunning || batchLooping) return false;
    if (batchActive) return false;
    return true;
  }

  // ── Same-portal drain: a clean "nothing left" instead of a bare 0/0 ────────
  //
  // The capture queue is portal-scoped (runCaptureQueue fetches every PENDING
  // row for the whole portal), so two queued searches on the SAME portal share
  // one worklist — a single capture pass can already drain both. The second
  // search's capture phase then legitimately finds 0 pending. That must read
  // as a clean, explained no-op ("ya capturada por la búsqueda anterior"),
  // never a bare confusing 0/0 and never an error.

  var EMPTY_REASON = {
    // This search's own detail URLs (page 1 + everything enumeration found)
    // were seeded, but by the time the capture queue read the worklist they
    // were already handled (captured/failed) by an earlier same-portal
    // search that drained the shared pending set first.
    ALREADY_CAPTURED: "already-captured",
    // This search genuinely discovered nothing to capture (an empty results
    // page, or a search URL that matched no listings) — unrelated to queueing.
    NO_RESULTS: "no-results",
  };

  /**
   * Classify why a fresh capture queue is empty (0 pending), given how many
   * detail URLs THIS search discovered (page 1 + enumeration). Pure. Returns
   * null when the queue isn't actually empty — nothing to classify.
   */
  function classifyEmptyCapture(pendingCount, discoveredCount) {
    if (pendingCount > 0) return null;
    var discovered =
      typeof discoveredCount === "number" && discoveredCount > 0;
    return discovered ? EMPTY_REASON.ALREADY_CAPTURED : EMPTY_REASON.NO_RESULTS;
  }

  var api = {
    STATUSES: STATUSES,
    AUTO_STATUS: AUTO_STATUS,
    makeSerializer: makeSerializer,
    SLOT: SLOT,
    DEFAULT_CONCURRENCY: DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY: MAX_CONCURRENCY,
    DEFAULT_PACE_BASE_MS: DEFAULT_PACE_BASE_MS,
    MIN_PACE_BASE_MS: MIN_PACE_BASE_MS,
    MAX_PACE_BASE_MS: MAX_PACE_BASE_MS,
    DEFAULT_PACE_SPREAD_MS: DEFAULT_PACE_SPREAD_MS,
    MIN_PACE_SPREAD_MS: MIN_PACE_SPREAD_MS,
    MAX_PACE_SPREAD_MS: MAX_PACE_SPREAD_MS,
    clampConcurrency: clampConcurrency,
    clampPaceBase: clampPaceBase,
    clampSpread: clampSpread,
    makeBatchState: makeBatchState,
    countSlot: countSlot,
    inflightCount: inflightCount,
    firstPendingIndex: firstPendingIndex,
    canLaunch: canLaunch,
    launchNext: launchNext,
    recordResultAt: recordResultAt,
    resetInflightToPending: resetInflightToPending,
    pause: pause,
    resume: resume,
    stop: stop,
    isActive: isActive,
    progress: progress,
    jitterDelay: jitterDelay,
    paceBaseMs: paceBaseMs,
    shouldReattach: shouldReattach,
    orphanTabsToClose: orphanTabsToClose,
    // Auto-capture continuous driver (issue #424)
    DEFAULT_AUTO_BATCH_SIZE: DEFAULT_AUTO_BATCH_SIZE,
    MIN_AUTO_BATCH_SIZE: MIN_AUTO_BATCH_SIZE,
    MAX_AUTO_BATCH_SIZE: MAX_AUTO_BATCH_SIZE,
    DEFAULT_AUTO_TIMEOUT_SEC: DEFAULT_AUTO_TIMEOUT_SEC,
    MIN_AUTO_TIMEOUT_SEC: MIN_AUTO_TIMEOUT_SEC,
    MAX_AUTO_TIMEOUT_SEC: MAX_AUTO_TIMEOUT_SEC,
    clampAutoBatchSize: clampAutoBatchSize,
    clampAutoTimeoutSec: clampAutoTimeoutSec,
    PORTAL_RANK_NOT_DUE: PORTAL_RANK_NOT_DUE,
    AUTO_PORTAL_RANK_UNKNOWN: AUTO_PORTAL_RANK_UNKNOWN,
    isPortalDue: isPortalDue,
    makeAutoState: makeAutoState,
    shouldContinueAuto: shouldContinueAuto,
    selectNextPending: selectNextPending,
    nextAutoAction: nextAutoAction,
    // Pending-search queue (issue #554)
    makeSearchQueue: makeSearchQueue,
    enqueueSearch: enqueueSearch,
    dequeueSearch: dequeueSearch,
    removeSearchAt: removeSearchAt,
    clearSearchQueue: clearSearchQueue,
    searchQueueDepth: searchQueueDepth,
    peekNextSearch: peekNextSearch,
    shouldAdvanceQueue: shouldAdvanceQueue,
    shouldRecoverStrandedEnumeration: shouldRecoverStrandedEnumeration,
    EMPTY_REASON: EMPTY_REASON,
    classifyEmptyCapture: classifyEmptyCapture,
  };

  if (typeof self !== "undefined") {
    self.InmoBatch = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
