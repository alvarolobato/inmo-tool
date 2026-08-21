/**
 * #308 — the dashboard-side scheduled pass that fires `runAssessmentBatch()`.
 *
 * A single in-process, SELF-RESCHEDULING loop (a chain of `setTimeout`s, not
 * a fixed `setInterval`), started once from `instrumentation.ts`'s
 * `register()` (the same startup seam that already bootstraps config.yaml
 * and applies init.sql). Each tick runs one bounded assessment batch. This is
 * the whole trigger — no cron, no ETL Python, no new container. See D-052 for
 * why the trigger lives here rather than in the ETL orchestrator (short
 * version: the flows and their budget/circuit-breaker safety are TypeScript
 * and dashboard-side, so a Python trigger would only ever call back into the
 * dashboard anyway; keeping it here touches zero Python and avoids churn with
 * the connector scheduler, D-046).
 *
 * ## #666 — adaptive duty cycle
 *
 * Before #666 this was a plain `setInterval`: run a batch, then ALWAYS wait
 * the full `intervalSeconds` (15 min by default) before the next one — even
 * when the batch fully drained its `batchSize` page and there was obviously
 * more backlog sitting right behind it. Production: ~490 properties/day
 * ingested, 1,310 unassessed at any given time, 30 sequential LLM calls per
 * pass (5 properties × 6 flows) — the pass itself took well under a minute,
 * so the scheduler spent nearly all of every 15-minute window idle with a
 * real backlog waiting.
 *
 * Each tick now decides its OWN next delay instead of trusting a fixed timer:
 *   - a tick that made REAL progress (`result.assessed > 0`) on a FULL page
 *     (`result.properties >= batchSize`) most likely left more work behind
 *     it — reschedule after the short `drainIntervalSeconds` instead of the
 *     full interval, so a backlog drains as fast as the
 *     concurrency/quota/budget guards allow. BOTH conditions matter (review
 *     finding, D-149): a full page that assessed NOTHING — every call
 *     skipped, parked, or errored — must NOT drain fast, or a page of
 *     already-known-bad properties gets retried every few seconds instead of
 *     at the old, safer rate;
 *   - anything else (fewer than a full page, or a full page with zero real
 *     progress) backs off to the full `intervalSeconds` rather than
 *     hot-looping the DB or re-spending on inputs that keep failing;
 *   - a tick that STOPPED (budget/circuit/quota, `result.stopped !== null`)
 *     also backs off to the full `intervalSeconds` — hammering a closed
 *     circuit or an exhausted quota window every few seconds helps nobody
 *     (D-107 says an unknown quota reading must never block, but a KNOWN
 *     "over the cap" reading is exactly this case, and it resets on its own
 *     clock, not the drain clock).
 *
 * The very FIRST tick after `startAssessmentScheduler()` still waits the
 * full `intervalSeconds`, unchanged from before #666 — this only reduces the
 * idle time BETWEEN ticks once the loop is running, not the boot delay.
 *
 * Configurable via `config/schema.yaml` (env > config.yaml > default), same
 * loader the rest of the dashboard reads:
 *   - dashboard.assessment_auto_enabled        (bool, default true)  — kill switch
 *   - dashboard.assessment_batch_size          (int,  default 8)     — N per tick, #666
 *   - dashboard.assessment_interval_seconds    (int,  default 900)   — idle cadence
 *   - dashboard.assessment_concurrency         (int,  default 8, hard cap 8) — #666
 *   - dashboard.assessment_drain_interval_seconds (int, default 5)  — #666
 *
 * `batchSize` and `concurrency` default to the SAME value deliberately (see
 * D-149): a flow's round only ever has `batchSize` properties to hand out
 * (one tick selects at most `batchSize` properties up front, and every flow
 * round works over that same page), so `min(concurrency, batchSize)` is the
 * REAL worker count regardless of what `concurrency` alone says — setting
 * `concurrency` above `batchSize` would silently do nothing. `batchSize`'s
 * pre-#666 default (5) predates concurrency existing at all; both moved to
 * 8 together, not just `concurrency` alone, per D-149's measurement (real
 * CLI backend, multi-wave: `n` properties >> `concurrency`, never a single
 * wave) — throughput kept climbing through concurrency 12 with no clean
 * plateau in the tested range; 8 is a deliberate balance point (real ~6x
 * wall-clock speedup, matches the dedicated connection-pool headroom D-149
 * provisions, moderate host resource use — one `claude` CLI child process
 * per in-flight call) rather than a measured ceiling. The curve is
 * host-dependent; re-measure on the actual deployment host
 * (`scripts/bench-assessment-concurrency.ts`) before raising it further.
 *
 * Server-only.
 */

import { getSystemConfig } from "@/lib/system-config/loader";
import { runAssessmentBatch, MAX_ASSESSMENT_CONCURRENCY } from "./batch";
import { isLlmEnabled, assertQuotaAvailable, LlmQuotaExceededError } from "@/lib/llm-enabled";

interface SchedulerConfig {
  enabled: boolean;
  batchSize: number;
  intervalSeconds: number;
  /** #666 — (property, flow) calls in flight at once within a flow's round. */
  concurrency: number;
  /** #666 — cadence between ticks while a tick just touched a full page. */
  drainIntervalSeconds: number;
}

// Hard cap on `dashboard.assessment_concurrency`: `batch.ts`'s
// `MAX_ASSESSMENT_CONCURRENCY`, the SAME constant `runAssessmentBatch`
// itself clamps to (#666/D-149 review — a cap enforced in only one of the
// two places isn't a cap) and `cache.ts`'s dedicated advisory-lock pool is
// sized off. Sits AT the default rather than above it (unlike D-043's
// browser-extension batch-capture pattern, which leaves headroom above its
// default) — a deliberate balance point, NOT a measured plateau: D-149's
// corrected multi-wave measurement (n properties >> concurrency, never a
// single wave) found throughput still climbing at concurrency 12 with no
// clean ceiling in the tested range. 8 keeps host resource use (one
// `claude` CLI child process per in-flight call, D-106) and the dedicated
// connection-pool headroom this decision provisions moderate while still
// capturing most of the measured gain (~6x of the ~7x seen at 12).

const DEFAULTS: SchedulerConfig = {
  enabled: true,
  batchSize: 8,
  intervalSeconds: 900,
  concurrency: 8,
  drainIntervalSeconds: 5,
};

/**
 * Read one config key through the central loader, falling back to an env var
 * and then a literal default — mirrors `checkDailyBudget()`'s pattern so the
 * scheduler honours the same env > config.yaml > default precedence as
 * everything else and stays testable by stubbing env.
 */
function readConfigString(key: string, envVar: string): string | null {
  try {
    const raw = getSystemConfig()[key]?.value;
    if (raw !== null && raw !== undefined) return String(raw).trim();
  } catch {
    // Loader unavailable (schema file missing / build context) — fall through.
  }
  const env = process.env[envVar];
  return env !== undefined ? env.trim() : null;
}

function readBool(key: string, envVar: string, fallback: boolean): boolean {
  const v = readConfigString(key, envVar);
  if (v === null || v === "") return fallback;
  return !(v === "false" || v === "0" || v.toLowerCase() === "no");
}

function readPositiveInt(key: string, envVar: string, fallback: number): number {
  const v = readConfigString(key, envVar);
  if (v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Same as `readPositiveInt`, clamped to `[1, max]`. */
function readClampedPositiveInt(
  key: string,
  envVar: string,
  fallback: number,
  max: number,
): number {
  return Math.min(readPositiveInt(key, envVar, fallback), max);
}

export function loadSchedulerConfig(): SchedulerConfig {
  return {
    enabled: readBool(
      "dashboard.assessment_auto_enabled",
      "DASHBOARD_ASSESSMENT_AUTO_ENABLED",
      DEFAULTS.enabled,
    ),
    batchSize: readPositiveInt(
      "dashboard.assessment_batch_size",
      "DASHBOARD_ASSESSMENT_BATCH_SIZE",
      DEFAULTS.batchSize,
    ),
    intervalSeconds: readPositiveInt(
      "dashboard.assessment_interval_seconds",
      "DASHBOARD_ASSESSMENT_INTERVAL_SECONDS",
      DEFAULTS.intervalSeconds,
    ),
    concurrency: readClampedPositiveInt(
      "dashboard.assessment_concurrency",
      "DASHBOARD_ASSESSMENT_CONCURRENCY",
      DEFAULTS.concurrency,
      MAX_ASSESSMENT_CONCURRENCY,
    ),
    drainIntervalSeconds: readPositiveInt(
      "dashboard.assessment_drain_interval_seconds",
      "DASHBOARD_ASSESSMENT_DRAIN_INTERVAL_SECONDS",
      DEFAULTS.drainIntervalSeconds,
    ),
  };
}

// Module-level singletons: `register()` is meant to run once per server
// process, but guard against a double-invocation (dev fast-refresh, a stray
// second import) starting two loops. `ticking` prevents overlapping tick
// EXECUTION — belt-and-suspenders now that the self-rescheduling loop below
// already makes that structurally impossible (the next tick is only ever
// scheduled AFTER the previous one resolves), kept because it's cheap and
// it is exactly what the #666 "no pass may overlap another" exit criterion
// pins with a test.
//
// `generation` closes a SEPARATE race `ticking` alone does not (#666/D-149
// review, "also"): a `stopAssessmentScheduler()` followed by a
// `startAssessmentScheduler()` while an OLD tick is still in flight. The old
// chain's `scheduleNextTick` callback only checked `started` before
// rescheduling itself — and `started` is `true` again by the time the old
// tick resolves (the new start set it), so the callback would arm a SECOND,
// independent `setTimeout` chain alongside the one the new start just armed.
// `ticking` still stops the two chains' tick BODIES from ever running
// concurrently, so this was never an actual pass-overlap — but two live
// timer chains ticking (mostly emptily, since one always loses the `ticking`
// race) forever is a real resource leak, not a merely theoretical one. Each
// `startAssessmentScheduler()` call bumps `generation` and captures it;
// `scheduleNextTick`'s callback only re-arms itself if its captured
// generation still matches the current one — a `stopAssessmentScheduler()`
// (or a fresh start) bumping `generation` invalidates every older chain
// immediately, with no dependency on `ticking`'s timing at all.
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let generation = 0;

/**
 * #666/D-149 review "also" — wall-clock duration (ms) of the most recent
 * PRODUCTIVE tick (`result.assessed > 0`), i.e. exactly the kind of tick
 * `db/llm-health.ts`'s backlog-ETA projection needs to know the real cost
 * of. `null` until at least one productive tick has run. In-memory only
 * (resets on process restart, NOT on a scheduler stop/start cycle — a
 * restart doesn't invalidate what the last real tick cost) — matches every
 * other piece of scheduler state here;
 * good enough for "is the drain interval alone realistic" without adding a
 * persisted-telemetry column.
 */
let lastProductiveTickDurationMs: number | null = null;

/** Read-only accessor — `db/llm-health.ts`'s backlog projection uses this. */
export function getLastProductiveTickDurationMs(): number | null {
  return lastProductiveTickDurationMs;
}

/**
 * Run one tick and return the delay (ms) before the NEXT one should fire —
 * see the module doc's "adaptive duty cycle" section for the three cases.
 * Never throws — a batch failure is logged and the loop survives to the next
 * tick. Returns the full idle interval (never overlaps) if a tick is already
 * in flight when called.
 */
async function tick(cfg: SchedulerConfig): Promise<number> {
  const idleDelayMs = cfg.intervalSeconds * 1000;
  if (ticking) return idleDelayMs;
  ticking = true;
  const tickStartedAt = Date.now();
  try {
    // Check the quota once per tick rather than discovering it inside the
    // batch loop: cheaper, and it keeps the "cap reached" message to one line
    // per tick instead of one per property.
    try {
      await assertQuotaAvailable();
    } catch (err) {
      if (err instanceof LlmQuotaExceededError) {
        console.info(`[ai-assessment:scheduler] tick skipped — ${err.message}`);
        return idleDelayMs;
      }
      throw err;
    }
    const result = await runAssessmentBatch({
      batchSize: cfg.batchSize,
      concurrency: cfg.concurrency,
    });
    if (result.properties > 0 || result.stopped) {
      console.info(
        `[ai-assessment:scheduler] tick: properties=${result.properties} ` +
          `assessed=${result.assessed} skipped=${result.skipped} ` +
          `noListings=${result.noListings} parked=${result.parked} ` +
          `errors=${result.errors} stopped=${result.stopped ?? "none"}`,
      );
    }
    if (result.assessed > 0) {
      lastProductiveTickDurationMs = Date.now() - tickStartedAt;
    }
    // #666: a budget/circuit/quota stop backs off to the full idle interval —
    // there is no point retrying in `drainIntervalSeconds` against a cap that
    // resets on its own clock.
    if (result.stopped) return idleDelayMs;
    // #666/D-149 review finding 1 (HIGH) — the original heuristic keyed on
    // `result.properties` (work TOUCHED — set unconditionally the moment
    // `runOne` reaches a property, before it knows whether that property was
    // skipped/parked/errored) rather than `result.assessed` (work actually
    // DONE). A tick where every call in a full page errors or is already
    // parked still reported `properties === batchSize` and drained again in
    // `drainIntervalSeconds` — for a page that is ENTIRELY errors/parks that
    // is a tight loop paying for real LLM calls every few seconds instead of
    // the old bound of at most once per `intervalSeconds` (900s default): a
    // 180x higher retry rate on inputs already known to be bad, which is
    // quota, not €, and quota is the actual constraint. Requiring BOTH a
    // full page (more backlog likely behind it) AND real progress this tick
    // (`assessed > 0`, so retrying again soon is worth it) fixes that: an
    // all-bad page now falls back to the idle cadence, same as before #666.
    // `selectPropertiesNeedingAssessment`'s selection query ALSO now
    // excludes actively-parked flows (`eligibility.ts`'s `pendingClause`)
    // so a parked head-of-queue page stops being re-selected at all, rather
    // than merely retried more slowly — the two
    // fixes are complementary, not redundant: this one bounds the RATE for
    // any all-bad page (parked or not yet parked); that one stops a
    // PERMANENTLY parked page from blocking every property behind it in
    // `created_at ASC` order forever.
    if (result.assessed > 0 && result.properties >= cfg.batchSize) {
      return cfg.drainIntervalSeconds * 1000;
    }
    return idleDelayMs;
  } catch (err) {
    // runAssessmentBatch only propagates a failure of the selection query
    // itself; everything else it folds into its summary. Keep the loop alive.
    console.error("[ai-assessment:scheduler] tick failed:", err);
    return idleDelayMs;
  } finally {
    ticking = false;
  }
}

/**
 * Schedule the next tick `delayMs` from now, and — once it resolves — the one
 * after that, and so on, for as long as `started` stays true. This chain of
 * `setTimeout`s (not a fixed `setInterval`) is what lets each tick pick its
 * OWN next delay (the adaptive duty cycle) while still making two ticks
 * running at once structurally impossible: the next `setTimeout` is only
 * ever armed after the in-flight `tick()` promise has resolved.
 */
function scheduleNextTick(cfg: SchedulerConfig, delayMs: number, gen: number): void {
  timer = setTimeout(() => {
    void (async () => {
      const nextDelayMs = await tick(cfg);
      // `stopAssessmentScheduler()` (or a subsequent restart) may have fired
      // while this tick was in flight — `generation` having moved on since
      // this chain was armed means don't resurrect (or duplicate) the loop.
      if (started && gen === generation) scheduleNextTick(cfg, nextDelayMs, gen);
    })();
  }, delayMs);
  // Do not hold the event loop open on the timer alone.
  timer.unref?.();
}

/**
 * Start the assessment scheduler. Idempotent: a second call is a no-op.
 * Returns without starting a loop when the feature is disabled by config.
 *
 * The interval is `unref()`'d so it never keeps the Node process alive on its
 * own (mirrors how a background poller should behave); the persistent Next.js
 * server keeps the process up regardless.
 */
export function startAssessmentScheduler(): void {
  if (started) return;
  started = true;

  // Master switch first: with the LLM off, every tick would do nothing but
  // discover it is not allowed to work. Log once at boot instead.
  if (!isLlmEnabled()) {
    console.info("[ai-assessment:scheduler] LLM disabled via dashboard.llm_enabled — not starting.");
    return;
  }

  const cfg = loadSchedulerConfig();
  if (!cfg.enabled) {
    console.info("[ai-assessment:scheduler] disabled via dashboard.assessment_auto_enabled — not starting.");
    return;
  }

  console.info(
    `[ai-assessment:scheduler] starting: batchSize=${cfg.batchSize} ` +
      `concurrency=${cfg.concurrency} intervalSeconds=${cfg.intervalSeconds} ` +
      `drainIntervalSeconds=${cfg.drainIntervalSeconds}`,
  );

  generation += 1;
  // The first tick still waits the full idle interval — only the cadence
  // BETWEEN ticks is adaptive (see the module doc).
  scheduleNextTick(cfg, cfg.intervalSeconds * 1000, generation);
}

/** Test-only: stop the loop and reset the singleton guards. */
export function stopAssessmentScheduler(): void {
  // Bump FIRST: invalidates any older chain's in-flight tick before it can
  // possibly resolve and re-check `generation` — see the module state doc.
  generation += 1;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  started = false;
  ticking = false;
}
