/**
 * Daily digest scheduler (issue #35, Phase 5.5 v1).
 *
 * ## Where the trigger lives — dashboard-side, mirroring #308/D-052
 *
 * A single in-process `setInterval` loop, started once from
 * `instrumentation.ts`'s `register()` — the exact same startup seam and
 * pattern the AI-assessment scheduler uses (D-052). The digest is TypeScript
 * (it reuses `lib/candidates`, `lib/analytics/area-price`, the AI-assessment
 * badge vocabulary, and `nodemailer`), so a Python/ETL cron trigger would only
 * ever call back into the dashboard anyway — keeping the trigger here touches
 * zero Python and avoids churn with the connector scheduler (D-046). See D-054.
 *
 * ## Idempotent, one digest per day
 *
 * Each tick lists every active profile with its cadence + last `digest_run`
 * watermark, and `isDigestDue` (pure, tested) decides who to build for. A
 * `daily` profile is due at most once per calendar day (past the configured
 * send hour); a `weekly` profile once every 7 days. Every processed profile
 * gets a `digest_run` row — including the empty case (nothing new → no email,
 * but the watermark still advances, issue #35 EC-2). So re-running a tick,
 * or a second server process, cannot send a profile two digests in one day:
 * the just-written watermark makes the profile no longer due.
 *
 * Configurable via `config/schema.yaml` (env > config.yaml > default):
 *   - notifications.digest_auto_enabled     (bool, default true)  — kill switch
 *   - notifications.digest_interval_seconds (int,  default 3600)  — tick cadence
 *   - notifications.digest_send_hour        (int,  default 7)     — earliest local hour to send
 *
 * Server-only.
 */

import { readBool, readPositiveInt, readIntInRange } from "./config-read";
import { listDigestProfiles, recordDigestRun, type DigestCadence } from "@/lib/db/digest";
import { buildDigestForProfile, digestItemCount, isDigestEmpty, type DigestContent } from "./digest";
import { sendDigestEmail } from "./email";
import {
  loadSeguimientoPriceDrops,
  loadSeguimientoStatusChanges,
  readPriceChangeBand,
} from "./seguimiento";

interface SchedulerConfig {
  enabled: boolean;
  intervalSeconds: number;
  sendHour: number;
}

const DEFAULTS: SchedulerConfig = {
  enabled: true,
  intervalSeconds: 3600,
  sendHour: 7,
};

export function loadDigestSchedulerConfig(): SchedulerConfig {
  return {
    enabled: readBool("notifications.digest_auto_enabled", "NOTIFICATIONS_DIGEST_AUTO_ENABLED", DEFAULTS.enabled),
    intervalSeconds: readPositiveInt(
      "notifications.digest_interval_seconds",
      "NOTIFICATIONS_DIGEST_INTERVAL_SECONDS",
      DEFAULTS.intervalSeconds,
    ),
    sendHour: readIntInRange("notifications.digest_send_hour", "NOTIFICATIONS_DIGEST_SEND_HOUR", DEFAULTS.sendHour, 0, 23),
  };
}

interface SeguimientoConfig {
  /** Independent kill switch for the watchlist pass (default true). */
  enabled: boolean;
  /** Fallback window (hours) for a profile that has never had a seguimiento run yet (default 24). */
  lookbackHours: number;
}

export function loadSeguimientoConfig(): SeguimientoConfig {
  return {
    enabled: readBool(
      "notifications.seguimiento_auto_enabled",
      "NOTIFICATIONS_SEGUIMIENTO_AUTO_ENABLED",
      true,
    ),
    lookbackHours: readPositiveInt(
      "notifications.seguimiento_lookback_hours",
      "NOTIFICATIONS_SEGUIMIENTO_LOOKBACK_HOURS",
      24,
    ),
  };
}

/** True when `a` and `b` fall on the same calendar day in the server's local timezone. */
function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Is a profile due for a digest right now? Pure — the single source of truth
 * for the cadence rule, tested in isolation.
 *   - `off` is never due.
 *   - Nothing is sent before `sendHour` (local) — a digest that lands at 3am
 *     is useless; wait for the configured morning hour.
 *   - `daily`: due at most once per calendar day (not again today once sent).
 *   - `weekly`: due once ≥7 days have elapsed since the last send.
 *   - A never-sent profile (`lastSentAt === null`) is due as soon as it is
 *     past `sendHour`.
 */
export function isDigestDue(
  cadence: DigestCadence,
  lastSentAt: string | null,
  now: Date,
  sendHour: number,
): boolean {
  if (cadence === "off") return false;
  if (now.getHours() < sendHour) return false;
  if (lastSentAt === null) return true;

  const last = new Date(lastSentAt);
  if (Number.isNaN(last.getTime())) return true; // unparseable watermark — treat as never sent

  if (cadence === "daily") {
    return !sameLocalDay(last, now);
  }
  // weekly
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return now.getTime() - last.getTime() >= sevenDaysMs;
}

export interface DigestPassResult {
  /** Active profiles inspected. */
  profiles: number;
  /** Profiles that were due this pass. */
  due: number;
  /** Digests that actually sent an email. */
  sent: number;
  /** Due profiles with an empty digest (watermark advanced, no email). */
  empty: number;
  /** Due profiles whose email was a no-op (SMTP not configured / no recipient / send failure). */
  noop: number;
  /** Profiles that threw during build/send (isolated — the pass continued). */
  errors: number;
}

/**
 * Run one digest pass: build + (maybe) send + record for every due profile.
 * Each profile is isolated in its own try/catch so one failure never aborts
 * the rest of the pass. Injectable clock for deterministic tests.
 */
export async function runDigestPass(opts: { now?: Date } = {}): Promise<DigestPassResult> {
  const now = opts.now ?? new Date();
  const cfg = loadDigestSchedulerConfig();
  const result: DigestPassResult = { profiles: 0, due: 0, sent: 0, empty: 0, noop: 0, errors: 0 };

  const profiles = await listDigestProfiles();
  result.profiles = profiles.length;

  for (const profile of profiles) {
    if (!isDigestDue(profile.cadence, profile.lastSentAt, now, cfg.sendHour)) continue;
    result.due += 1;
    try {
      const content = await buildDigestForProfile({ id: profile.id, name: profile.name });
      const count = digestItemCount(content);
      if (isDigestEmpty(content)) {
        // EC-2: nothing new — advance the watermark, send nothing.
        await recordDigestRun(profile.id, count, false, "digest");
        result.empty += 1;
        continue;
      }
      const send = await sendDigestEmail(content, { to: profile.email });
      await recordDigestRun(profile.id, count, send.sent, "digest");
      if (send.sent) result.sent += 1;
      else result.noop += 1;
    } catch (err) {
      console.error(`[digest:scheduler] failed for profile ${profile.id} (${profile.name}):`, err);
      result.errors += 1;
    }
  }
  return result;
}

// ─── Independent "En seguimiento" watchlist pass (#428, plan #415 §3.5) ─────

export interface SeguimientoPassResult {
  /** Active profiles inspected. */
  profiles: number;
  /** Profiles that carried at least one tracked drop / status change this pass. */
  withChanges: number;
  /** Alerts that actually sent an email. */
  sent: number;
  /** Profiles whose watermark advanced with nothing to report (no email). */
  empty: number;
  /** Profiles with changes whose email was a no-op (SMTP not configured / no recipient / send failure). */
  noop: number;
  /** Profiles that threw during build/send (isolated — the pass continued). */
  errors: number;
}

/**
 * One "En seguimiento" watchlist pass — checks ONLY tracked (accept)
 * properties for price DROPS + sold/withdrawn status changes and sends its own
 * small alert. Gated INDEPENDENTLY of `digest_cadence`: it runs on every tick
 * (worst-case latency ~1h, which is effectively instant for a purchase
 * decision) and keeps its own `digest_run` watermark (kind='seguimiento'), so a
 * drop alerts at most once and never collides with the cadenced digest.
 *
 * Advances the watermark on EVERY processed profile — including the empty case
 * — exactly like the cadenced pass, so re-running a tick (or a second process)
 * can't re-alert the same drop. Injectable clock for deterministic tests.
 */
export async function runSeguimientoPass(opts: { now?: Date } = {}): Promise<SeguimientoPassResult> {
  const now = opts.now ?? new Date();
  const cfg = loadSeguimientoConfig();
  const band = readPriceChangeBand();
  const result: SeguimientoPassResult = { profiles: 0, withChanges: 0, sent: 0, empty: 0, noop: 0, errors: 0 };

  const profiles = await listDigestProfiles();
  result.profiles = profiles.length;

  for (const profile of profiles) {
    // Anchor on this profile's own last seguimiento run; a never-run profile
    // falls back to `now - lookbackHours`. Independent of digest_cadence — a
    // profile with `digest_cadence='off'` is STILL watched (owner explicitly
    // tracked those properties).
    const anchor =
      profile.lastSeguimientoAt ??
      new Date(now.getTime() - cfg.lookbackHours * 60 * 60 * 1000).toISOString();
    try {
      const [drops, statusChanges] = await Promise.all([
        loadSeguimientoPriceDrops(profile.id, anchor, band, 25),
        loadSeguimientoStatusChanges(profile.id, anchor, 25),
      ]);
      const count = drops.length + statusChanges.length;
      if (count === 0) {
        // Nothing tracked moved — advance the watermark, send nothing.
        await recordDigestRun(profile.id, 0, false, "seguimiento");
        result.empty += 1;
        continue;
      }
      result.withChanges += 1;
      // Reuse the digest email path (inert until SMTP is configured — D-025's
      // no-op). Only the seguimiento + status sections carry content.
      const content: DigestContent = {
        profileId: profile.id,
        profileName: profile.name,
        since: anchor,
        generatedAt: now.toISOString(),
        seguimientoDrops: drops,
        newCandidates: [],
        priceDrops: [],
        statusChanges,
        relistedLower: [],
      };
      const send = await sendDigestEmail(content, { to: profile.email });
      await recordDigestRun(profile.id, count, send.sent, "seguimiento");
      if (send.sent) result.sent += 1;
      else result.noop += 1;
    } catch (err) {
      console.error(`[seguimiento:scheduler] failed for profile ${profile.id} (${profile.name}):`, err);
      result.errors += 1;
    }
  }
  return result;
}

// ─── Interval loop (mirrors lib/ai-assessment/scheduler.ts) ─────────────────

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** Run one tick. Never throws — a failure is logged and the loop survives. */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const r = await runDigestPass();
    if (r.due > 0) {
      console.info(
        `[digest:scheduler] tick: profiles=${r.profiles} due=${r.due} sent=${r.sent} empty=${r.empty} noop=${r.noop} errors=${r.errors}`,
      );
    }
    // #428: the independent "En seguimiento" watchlist pass runs on the SAME
    // tick but is gated by its own kill switch and its own watermark — a
    // failure here is isolated and never aborts the digest pass above.
    if (loadSeguimientoConfig().enabled) {
      try {
        const s = await runSeguimientoPass();
        if (s.withChanges > 0) {
          console.info(
            `[seguimiento:scheduler] tick: profiles=${s.profiles} withChanges=${s.withChanges} sent=${s.sent} empty=${s.empty} noop=${s.noop} errors=${s.errors}`,
          );
        }
      } catch (err) {
        console.error("[seguimiento:scheduler] pass failed:", err);
      }
    }
  } catch (err) {
    console.error("[digest:scheduler] tick failed:", err);
  } finally {
    ticking = false;
  }
}

/**
 * Start the digest scheduler. Idempotent: a second call is a no-op. Returns
 * without starting when disabled by config. The interval is `unref()`'d so it
 * never keeps the Node process alive on its own.
 */
export function startDigestScheduler(): void {
  if (started) return;
  started = true;

  const cfg = loadDigestSchedulerConfig();
  if (!cfg.enabled) {
    console.info("[digest:scheduler] disabled via notifications.digest_auto_enabled — not starting.");
    return;
  }

  console.info(
    `[digest:scheduler] starting: intervalSeconds=${cfg.intervalSeconds} sendHour=${cfg.sendHour}`,
  );
  timer = setInterval(() => {
    void tick();
  }, cfg.intervalSeconds * 1000);
  timer.unref?.();
}

/** Test-only: stop the loop and reset the singleton guards. */
export function stopDigestScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  ticking = false;
}
