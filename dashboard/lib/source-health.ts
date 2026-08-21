/**
 * Estado board — pure status derivation (issue #638, part of #636).
 *
 * The problem this exists to fix: every inherited monitoring surface equates
 * "healthy" with "the last run returned status='ok'" — and that lies. Fotocasa
 * reported `ok` (with a soft-block notice, D-047) on four consecutive runs
 * while ingesting zero listings for ~40 hours; every current surface showed
 * it green. Browser-captured portals (idealista, the owner's primary) never
 * produce a `connector_run` at all, so a run-centric view is structurally
 * blind to them.
 *
 * The fix: derive health from the `listing` table — the one ledger both
 * ingest paths (crawl + capture) actually write — and demote run/capture
 * records to error-signal INPUT, never the headline. This module is the pure
 * half of that: given per-source facts (already aggregated by
 * `lib/db/source-health.ts`), derive one of four statuses. No DB access here
 * — server-only aggregation lives in `lib/db/source-health.ts`.
 *
 * Status enum, worst-of, one vocabulary for both ingest paths:
 *   - fresco:    not due — recent data activity within the source's window.
 *   - pendiente: due, but no error signal — "your move, go capture/nothing
 *                broke yet". The ONLY status a captured source can reach from
 *                time alone (owner's #636 addendum safety constraint below).
 *   - atascado:  past 2x the due window (crawl), OR soft-blocked with no new
 *                data (crawl), OR a capture source with SOME recent capture
 *                failures / a long-stale extension heartbeat.
 *   - fallando:  a classified fatal run failure or circuit_open (crawl), or a
 *                capture source whose recent captures mostly fail.
 *
 * Owner's #636-addendum safety constraint (the design's spine): "A listing's
 * status changes only with evidence of absence; elapsed time only nominates
 * candidates for verification." Applied here as: a captured source PAST its
 * due window, with no error signal, is `pendiente` (amber, actionable —
 * "tu acción: capturar"), NEVER `atascado`/`fallando` from time alone. Capture
 * is owner-paced and bursty (measured: 2,175 captures on one day, zero on
 * several others) — a time-triggered red status on that shape would report
 * the owner's calendar as portal failure. Reaching atascado/fallando for a
 * capture source REQUIRES an error signal: failed captures (7d) or a stale
 * extension_heartbeat (or, in future, #634's block detection).
 */

export type SourceKind = "crawl" | "capture";

export type SourceStatus = "fresco" | "pendiente" | "atascado" | "fallando";

/** Worst-of ordering — higher rank sorts first (problems first). */
export const SOURCE_STATUS_RANK: Record<SourceStatus, number> = {
  fresco: 0,
  pendiente: 1,
  atascado: 2,
  fallando: 3,
};

export const SOURCE_STATUS_LABEL: Record<SourceStatus, string> = {
  fresco: "Fresco",
  pendiente: "Pendiente de captura",
  atascado: "Atascado",
  fallando: "Fallando",
};

/** A classified fatal crawl-run outcome — D-079's status column. */
const FATAL_RUN_STATUSES = new Set(["failed", "circuit_open"]);

/** D-079 failure_classification value that must never read as green (D-047). */
const SOFT_BLOCK_CLASSIFICATION = "soft_block";

/** A capture source whose 7d fail rate is at/above this is `fallando`, not
 * merely `atascado` — "majority of recent attempts are failing". */
export const CAPTURE_FALLANDO_FAILURE_RATE = 0.5;

/**
 * How stale the (single, dashboard-wide) extension heartbeat must be before
 * it counts as an ERROR signal for a due capture source. Deliberately much
 * longer than `LINKED_WINDOW_MS` (lib/extension-status.ts, 10 minutes — "is
 * the extension open right now") and longer than the measured burst gaps
 * (up to ~9 days idle between real capture sessions): this is "the capture
 * tooling looks abandoned/broken", not "the owner hasn't captured today".
 */
export const CAPTURE_HEARTBEAT_STALE_DAYS = 30;

export interface SourceHealthDerivationInput {
  kind: SourceKind;
  /** Effective due-window in hours (connector_config.freshness_interval_hours,
   * else etl.default_freshness_interval_hours / the capture staleness config —
   * resolved by the caller, this module reads only the final number). */
  freshnessIntervalHours: number;
  /** ISO timestamp of the last real data activity for this source (ground
   * truth: MAX(GREATEST(listing.last_seen_at, last_fetched_at, first_seen_at))
   * over `listing.source`), or null if this source has never ingested a row. */
  lastActivityAt: string | null;
  nowMs: number;
  // ── crawl error signal (D-079) — ignored for kind: "capture" ──
  latestRunStatus: string | null;
  latestRunFailureClassification: string | null;
  // ── capture error signal — ignored for kind: "crawl" ──
  captureFailed7d: number;
  captureTotal7d: number;
  /** True when the extension hasn't been seen (any portal) in
   * CAPTURE_HEARTBEAT_STALE_DAYS or longer (or never). */
  heartbeatStale: boolean;
}

export interface SourceHealthDerivation {
  status: SourceStatus;
  /** Hours since last activity, or null when there has never been any. */
  ageHours: number | null;
  due: boolean;
  pastDoubleWindow: boolean;
  /** captureFailed7d / captureTotal7d, or null when captureTotal7d is 0
   * (nothing to compute a rate from — distinct from a 0% rate). */
  captureFailureRate7d: number | null;
  /** Short machine-readable reason code — feeds the row's chip/tooltip. */
  reason:
    | "fresh"
    | "due"
    | "pendiente_de_captura"
    | "stale_2x_window"
    | "soft_block_stale"
    | "run_failed"
    | "circuit_open"
    | "capture_failure_rate"
    | "capture_partial_failures"
    | "heartbeat_stale";
}

function ageHoursSince(lastActivityAt: string | null, nowMs: number): number | null {
  if (lastActivityAt === null) return null;
  const ms = nowMs - new Date(lastActivityAt).getTime();
  return ms / (60 * 60 * 1000);
}

/**
 * Derive one source's status from its facts. Pure — no clock reads (nowMs is
 * an input), no DB, unit-tested directly.
 */
export function deriveSourceStatus(
  input: SourceHealthDerivationInput,
): SourceHealthDerivation {
  const ageHours = ageHoursSince(input.lastActivityAt, input.nowMs);
  // Never having ingested anything is unambiguously due (and past-double) —
  // same "never succeeded is stale, not silently fresh" posture as D-125.
  const due = ageHours === null || ageHours >= input.freshnessIntervalHours;
  const pastDoubleWindow =
    ageHours === null || ageHours >= 2 * input.freshnessIntervalHours;

  if (input.kind === "crawl") {
    if (
      input.latestRunStatus !== null &&
      FATAL_RUN_STATUSES.has(input.latestRunStatus)
    ) {
      return {
        status: "fallando",
        ageHours,
        due,
        pastDoubleWindow,
        captureFailureRate7d: null,
        reason: input.latestRunStatus === "circuit_open" ? "circuit_open" : "run_failed",
      };
    }
    const softBlocked =
      input.latestRunFailureClassification === SOFT_BLOCK_CLASSIFICATION;
    // "atascado (past 2x due window OR soft-blocked with no data)" — the
    // fotocasa case: an ok-status run that is quietly not moving the needle.
    if (pastDoubleWindow || (softBlocked && due)) {
      return {
        status: "atascado",
        ageHours,
        due,
        pastDoubleWindow,
        captureFailureRate7d: null,
        reason: softBlocked ? "soft_block_stale" : "stale_2x_window",
      };
    }
    if (due) {
      return {
        status: "pendiente",
        ageHours,
        due,
        pastDoubleWindow,
        captureFailureRate7d: null,
        reason: "due",
      };
    }
    return {
      status: "fresco",
      ageHours,
      due,
      pastDoubleWindow,
      captureFailureRate7d: null,
      reason: "fresh",
    };
  }

  // kind === "capture" — time alone NEVER produces atascado/fallando (the
  // owner's #636-addendum safety constraint). Error signals are checked
  // first and unconditionally on `due` — a burst of failures right now is
  // real regardless of whether the source also happens to be inside its
  // window.
  const captureFailureRate7d =
    input.captureTotal7d > 0 ? input.captureFailed7d / input.captureTotal7d : null;

  if (
    captureFailureRate7d !== null &&
    captureFailureRate7d >= CAPTURE_FALLANDO_FAILURE_RATE
  ) {
    return {
      status: "fallando",
      ageHours,
      due,
      pastDoubleWindow,
      captureFailureRate7d,
      reason: "capture_failure_rate",
    };
  }
  if (captureFailureRate7d !== null && captureFailureRate7d > 0) {
    return {
      status: "atascado",
      ageHours,
      due,
      pastDoubleWindow,
      captureFailureRate7d,
      reason: "capture_partial_failures",
    };
  }
  if (due && input.heartbeatStale) {
    return {
      status: "atascado",
      ageHours,
      due,
      pastDoubleWindow,
      captureFailureRate7d,
      reason: "heartbeat_stale",
    };
  }
  if (due) {
    return {
      status: "pendiente",
      ageHours,
      due,
      pastDoubleWindow,
      captureFailureRate7d,
      reason: "pendiente_de_captura",
    };
  }
  return {
    status: "fresco",
    ageHours,
    due,
    pastDoubleWindow,
    captureFailureRate7d,
    reason: "fresh",
  };
}

/** Worst-of a list of statuses (higher SOURCE_STATUS_RANK wins), or null for
 * an empty list — "nothing in scope", never silently "fresco". */
export function worstOfStatuses(statuses: SourceStatus[]): SourceStatus | null {
  if (statuses.length === 0) return null;
  return statuses.reduce((worst, s) =>
    SOURCE_STATUS_RANK[s] > SOURCE_STATUS_RANK[worst] ? s : worst,
  );
}

/**
 * Sort key for the Estado board: problems first (worst status first), then
 * oldest activity first within the same status, then by source name for a
 * stable order. Disabled sources are the caller's job to filter out /
 * collapse — this only ranks the in-scope rows it's given.
 */
export function compareSourceRows<T extends { status: SourceStatus; ageHours: number | null; source: string }>(
  a: T,
  b: T,
): number {
  const rankDiff = SOURCE_STATUS_RANK[b.status] - SOURCE_STATUS_RANK[a.status];
  if (rankDiff !== 0) return rankDiff;
  const aAge = a.ageHours ?? Number.POSITIVE_INFINITY;
  const bAge = b.ageHours ?? Number.POSITIVE_INFINITY;
  if (aAge !== bAge) return bAge - aAge;
  return a.source.localeCompare(b.source);
}

/**
 * Format an age in hours as a compact Spanish "hace …" string — the ONE
 * definition shared by the Estado board (`app/admin/page.tsx`) and the
 * TopBar pill (`components/FreshnessContext.tsx`). Issue #638 review: each
 * surface previously carried its own copy, and they disagreed at real
 * scale — altamira read "hace 12d" on the board and "hace 279h" on the pill
 * for the exact same underlying age. D-144's whole argument is that these
 * two surfaces read the same rollup and therefore cannot disagree; a
 * duplicated formatter defeats that even when the underlying number is
 * identical. `null` (never any activity) reads as "nunca" — a fact, not an
 * invented "0m"/"0h".
 */
export function formatSourceAge(ageHours: number | null): string {
  if (ageHours === null) return "nunca";
  if (ageHours < 1) return `hace ${Math.max(1, Math.round(ageHours * 60))}m`;
  if (ageHours < 48) return `hace ${Math.round(ageHours)}h`;
  return `hace ${Math.round(ageHours / 24)}d`;
}
