/**
 * #308 — the dashboard-side scheduled pass that fires `runAssessmentBatch()`.
 *
 * A single in-process `setInterval` loop, started once from
 * `instrumentation.ts`'s `register()` (the same startup seam that already
 * bootstraps config.yaml and applies init.sql). Each tick runs one bounded
 * assessment batch. This is the whole trigger — no cron, no ETL Python, no new
 * container. See D-052 for why the trigger lives here rather than in the ETL
 * orchestrator (short version: the flows and their budget/circuit-breaker
 * safety are TypeScript and dashboard-side, so a Python trigger would only
 * ever call back into the dashboard anyway; keeping it here touches zero
 * Python and avoids churn with the connector scheduler, D-046).
 *
 * Configurable via `config/schema.yaml` (env > config.yaml > default), same
 * loader the rest of the dashboard reads:
 *   - dashboard.assessment_auto_enabled     (bool,  default true)  — kill switch
 *   - dashboard.assessment_batch_size       (int,   default 5)     — N per tick
 *   - dashboard.assessment_interval_seconds (int,   default 900)   — cadence
 *
 * Server-only.
 */

import { getSystemConfig } from "@/lib/system-config/loader";
import { runAssessmentBatch } from "./batch";

interface SchedulerConfig {
  enabled: boolean;
  batchSize: number;
  intervalSeconds: number;
}

const DEFAULTS: SchedulerConfig = {
  enabled: true,
  batchSize: 5,
  intervalSeconds: 900,
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
  };
}

// Module-level singletons: `register()` is meant to run once per server
// process, but guard against a double-invocation (dev fast-refresh, a stray
// second import) starting two loops. `ticking` prevents overlapping ticks when
// a batch (an LLM round-trip per property) outlasts the interval.
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Run one tick. Never throws — a batch failure is logged and the loop
 * survives to the next interval. Skips its own body if the previous tick is
 * still in flight, so a slow pass never overlaps itself.
 */
async function tick(batchSize: number): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const result = await runAssessmentBatch({ batchSize });
    if (result.properties > 0 || result.stopped) {
      console.info(
        `[ai-assessment:scheduler] tick: properties=${result.properties} ` +
          `assessed=${result.assessed} skipped=${result.skipped} ` +
          `noListings=${result.noListings} errors=${result.errors} ` +
          `stopped=${result.stopped ?? "none"}`,
      );
    }
  } catch (err) {
    // runAssessmentBatch only propagates a failure of the selection query
    // itself; everything else it folds into its summary. Keep the loop alive.
    console.error("[ai-assessment:scheduler] tick failed:", err);
  } finally {
    ticking = false;
  }
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

  const cfg = loadSchedulerConfig();
  if (!cfg.enabled) {
    console.info("[ai-assessment:scheduler] disabled via dashboard.assessment_auto_enabled — not starting.");
    return;
  }

  console.info(
    `[ai-assessment:scheduler] starting: batchSize=${cfg.batchSize} ` +
      `intervalSeconds=${cfg.intervalSeconds}`,
  );

  timer = setInterval(() => {
    void tick(cfg.batchSize);
  }, cfg.intervalSeconds * 1000);
  // Do not hold the event loop open on the timer alone.
  timer.unref?.();
}

/** Test-only: stop the loop and reset the singleton guards. */
export function stopAssessmentScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  ticking = false;
}
