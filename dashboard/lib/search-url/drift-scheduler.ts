/**
 * Weekly portal filter-drift scheduler (issue #511, D-052/D-054 pattern).
 *
 * The aliseda static drift check used to only run when someone clicked a button
 * on the Descubrimiento tab — "a manual tab nobody visits detects nothing".
 * #511 retired that tab and schedules the check server-side, mirroring the
 * digest scheduler exactly: a single in-process `setInterval` loop started once
 * from `instrumentation.ts`, its own kill switch, idempotent, non-fatal.
 *
 * Idempotency without a new watermark table: the `portal_filter_catalog` row's
 * `captured_at` IS the watermark. Each tick runs the check only for portals
 * whose latest catalog is older than `drift_check_interval_days` (or missing).
 * Re-running a tick, or a second process, re-reads the just-written timestamp
 * and finds the portal no longer due.
 *
 * Configurable via config/schema.yaml (env > config.yaml > default):
 *   - discovery.drift_auto_enabled        (bool, default true)  — kill switch
 *   - discovery.drift_tick_seconds        (int,  default 21600) — tick cadence
 *   - discovery.drift_check_interval_days (int,  default 7)     — per-portal due window
 *
 * Server-only.
 */

import { readBool, readPositiveInt } from "@/lib/notifications/config-read";
import { findLatestCatalog } from "@/lib/db/portal-filter-catalog";
import { DRIFT_CHECK_PORTALS, runDriftCheck } from "@/lib/search-url/drift-check";

interface DriftSchedulerConfig {
  enabled: boolean;
  tickSeconds: number;
  intervalDays: number;
}

const DEFAULTS: DriftSchedulerConfig = {
  enabled: true,
  tickSeconds: 21600, // 6h — a stale weekly check is picked up within the day
  intervalDays: 7,
};

export function loadDriftSchedulerConfig(): DriftSchedulerConfig {
  return {
    enabled: readBool("discovery.drift_auto_enabled", "DISCOVERY_DRIFT_AUTO_ENABLED", DEFAULTS.enabled),
    tickSeconds: readPositiveInt(
      "discovery.drift_tick_seconds",
      "DISCOVERY_DRIFT_TICK_SECONDS",
      DEFAULTS.tickSeconds,
    ),
    intervalDays: readPositiveInt(
      "discovery.drift_check_interval_days",
      "DISCOVERY_DRIFT_CHECK_INTERVAL_DAYS",
      DEFAULTS.intervalDays,
    ),
  };
}

/**
 * Is a portal due for a fresh drift check? Pure — the single source of truth for
 * the cadence rule, tested in isolation. A never-checked portal
 * (`lastCapturedAt === null`) is always due; otherwise due once `intervalDays`
 * have elapsed since the last capture. An unparseable timestamp is treated as
 * never checked.
 */
export function isDriftCheckDue(
  lastCapturedAt: string | null,
  now: Date,
  intervalDays: number,
): boolean {
  if (lastCapturedAt === null) return true;
  const last = new Date(lastCapturedAt).getTime();
  if (Number.isNaN(last)) return true;
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
  return now.getTime() - last >= intervalMs;
}

export interface DriftPassResult {
  /** Portals inspected. */
  portals: number;
  /** Portals that were due this pass. */
  due: number;
  /** Drift checks that ran (extract + save). */
  checked: number;
  /** Due portals whose check threw (isolated — the pass continued). */
  errors: number;
}

/**
 * Run one drift pass: for every configured portal, run the check if its latest
 * catalog is stale. Each portal is isolated in its own try/catch — an
 * unreachable portal never aborts the rest (D-041: the health page must never
 * error). Injectable clock for deterministic tests.
 */
export async function runDriftPass(opts: { now?: Date } = {}): Promise<DriftPassResult> {
  const now = opts.now ?? new Date();
  const cfg = loadDriftSchedulerConfig();
  const result: DriftPassResult = { portals: 0, due: 0, checked: 0, errors: 0 };

  for (const connector of DRIFT_CHECK_PORTALS) {
    result.portals += 1;
    try {
      const latest = await findLatestCatalog(connector);
      if (!isDriftCheckDue(latest?.captured_at ?? null, now, cfg.intervalDays)) continue;
      result.due += 1;
      await runDriftCheck(connector);
      result.checked += 1;
    } catch (err) {
      console.error(`[drift:scheduler] check failed for «${connector}»:`, err);
      result.errors += 1;
    }
  }
  return result;
}

// ─── Interval loop (mirrors lib/notifications/scheduler.ts) ──────────────────

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** Run one tick. Never throws — a failure is logged and the loop survives. */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const r = await runDriftPass();
    if (r.due > 0) {
      console.info(
        `[drift:scheduler] tick: portals=${r.portals} due=${r.due} checked=${r.checked} errors=${r.errors}`,
      );
    }
  } catch (err) {
    console.error("[drift:scheduler] tick failed:", err);
  } finally {
    ticking = false;
  }
}

/**
 * Start the drift scheduler. Idempotent: a second call is a no-op. Returns
 * without starting when disabled by config. The interval is `unref()`'d so it
 * never keeps the Node process alive on its own.
 */
export function startDriftScheduler(): void {
  if (started) return;
  started = true;

  const cfg = loadDriftSchedulerConfig();
  if (!cfg.enabled) {
    console.info("[drift:scheduler] disabled via discovery.drift_auto_enabled — not starting.");
    return;
  }

  console.info(
    `[drift:scheduler] starting: tickSeconds=${cfg.tickSeconds} intervalDays=${cfg.intervalDays}`,
  );
  timer = setInterval(() => {
    void tick();
  }, cfg.tickSeconds * 1000);
  timer.unref?.();
}

/** Test-only: stop the loop and reset the singleton guards. */
export function stopDriftScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  ticking = false;
}
