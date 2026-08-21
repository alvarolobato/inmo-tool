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
 *   - a tick that touched a FULL page (`result.properties >= batchSize`) most
 *     likely left more work behind it — reschedule after the short
 *     `drainIntervalSeconds` instead of the full interval, so a backlog
 *     drains as fast as the concurrency/quota/budget guards allow;
 *   - a tick that touched FEWER than a full page found (near-)nothing to do
 *     — the selection query is effectively empty — so back off to the full
 *     `intervalSeconds` rather than hot-looping the DB;
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
 * pre-#666 default (5) predates concurrency existing at all; measured
 * (D-149) against the real CLI backend, throughput kept improving out to
 * concurrency 8 (worker pool actually saturated) with only marginal further
 * gain at 10 — so both moved to 8 together, not just `concurrency` alone.
 *
 * Server-only.
 */

import { getSystemConfig } from "@/lib/system-config/loader";
import { runAssessmentBatch } from "./batch";
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

/**
 * Hard cap on `dashboard.assessment_concurrency`, independent of whatever an
 * operator types into config. Sits AT the default rather than above it
 * (unlike D-043's browser-extension batch-capture pattern, which leaves
 * headroom above its default) because D-149's measurement found returns
 * diminishing right around here — concurrency 8 was a genuine ~5x wall-clock
 * speedup over serial, concurrency 10 only a further ~12% on top of that.
 * Bounds real host resources (one `claude` CLI child process per in-flight
 * call, D-106) and the db-write pool's connection budget (D-149) — not the
 * LLM API itself, which measured fine well past this level on its own.
 */
const MAX_CONCURRENCY = 8;

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
      MAX_CONCURRENCY,
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
// second import) starting two loops. `ticking` prevents overlapping ticks —
// belt-and-suspenders now that the self-rescheduling loop below already makes
// overlap structurally impossible (the next tick is only ever scheduled AFTER
// the previous one resolves), kept because it's cheap and it is exactly what
// the #666 "no pass may overlap another" exit criterion pins with a test.
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;

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
    // #666: a budget/circuit/quota stop backs off to the full idle interval —
    // there is no point retrying in `drainIntervalSeconds` against a cap that
    // resets on its own clock. Otherwise, a full page (properties reached the
    // configured batchSize) likely leaves more backlog behind it — drain
    // fast; anything short of a full page means the selection query came back
    // (near-)empty, so back off to the idle cadence.
    if (result.stopped) return idleDelayMs;
    if (result.properties >= cfg.batchSize) return cfg.drainIntervalSeconds * 1000;
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
function scheduleNextTick(cfg: SchedulerConfig, delayMs: number): void {
  timer = setTimeout(() => {
    void (async () => {
      const nextDelayMs = await tick(cfg);
      // `stopAssessmentScheduler()` may have fired while this tick was in
      // flight — don't resurrect the loop underneath it.
      if (started) scheduleNextTick(cfg, nextDelayMs);
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

  // The first tick still waits the full idle interval — only the cadence
  // BETWEEN ticks is adaptive (see the module doc).
  scheduleNextTick(cfg, cfg.intervalSeconds * 1000);
}

/** Test-only: stop the loop and reset the singleton guards. */
export function stopAssessmentScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  started = false;
  ticking = false;
}
