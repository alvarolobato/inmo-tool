/**
 * Connector-pipeline freshness (issue #241) — server-only (imports
 * lib/db-write, the `pg` client). Never import from a client component.
 *
 * Why this file exists: the freshness/health surface used to query the
 * PowerShop-era `etl_watermarks` table, which the current connector
 * orchestrator NEVER writes (`set_watermark` is dead — called only from
 * tests; the live pipeline in `etl/orchestrator.py` records
 * `connector_runs`/`connector_run_results` instead). Reading a permanently
 * empty table made `/api/data-health` + `/api/ready` degrade to a silent
 * "200 + nothing", so the TopBar freshness pill never told the owner
 * anything true. This module derives freshness from the tables the real
 * pipeline actually writes.
 *
 * Definition of "fresh" for THIS pipeline:
 *   - The unit is the connector, not a mirror table. The scheduler
 *     (`etl/orchestrator.py run_scheduler_loop`) runs every registered
 *     connector on an hourly sweep; a `connector_run_results` row with
 *     status='ok' is a successful contact with a site.
 *   - Per connector we report `lastSuccessAt` (latest status='ok' run) and
 *     `lastRunAt`/`lastRunStatus` (latest run of any status, so a currently
 *     failing/blocked connector — e.g. milanuncios soft-blocked — shows its
 *     real state, not just its last good one).
 *   - `enabled` comes from `connector_config` (default true when no row,
 *     matching listConnectors() and the ETL's own default). A disabled
 *     connector (e.g. idealista) is reported but is NEVER counted as stale
 *     and never drives the headline — its silence is intentional, not a
 *     failure.
 *   - A connector is STALE when it is enabled AND its last successful run
 *     is missing entirely, or older than the staleness threshold. "Never
 *     succeeded" is deliberately stale, not silently fresh — that is the
 *     exact class of false-negative the old watermark bug produced.
 *
 * The threshold is generous on purpose: the hourly sweep is fair-scheduled
 * across scopes (D-030), so a single connector can legitimately go several
 * hours between successful runs. A full day with no successful run is a
 * genuine problem worth flagging, hence the 24h default
 * (`FRESHNESS_STALE_THRESHOLD_HOURS` overrides).
 */

import { sql } from "@/lib/db-write";
import {
  defaultFreshnessIntervalHours,
  deriveFreshnessState,
  freshnessCycleStuckAfterHours,
} from "@/lib/db/connectors";
import type { ConnectorFreshnessKind } from "@/lib/connectors-schema";

export const DEFAULT_STALE_THRESHOLD_HOURS = 24;

export function staleThresholdHours(): number {
  const raw = process.env.FRESHNESS_STALE_THRESHOLD_HOURS;
  if (raw === undefined || raw === "") return DEFAULT_STALE_THRESHOLD_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_THRESHOLD_HOURS;
}

/** Postgres error code for "relation does not exist" (undefined_table). */
export const UNDEFINED_TABLE = "42P01";

export interface ConnectorFreshness {
  /** Connector name (connector_registry.connector_name). */
  connector: string;
  /** Operator enable state (connector_config.enabled, default true). */
  enabled: boolean;
  /**
   * ISO timestamp the connector was last FRESH — `connector_freshness_state.
   * last_fresh_at`, i.e. when its last full refresh cycle completed (issue
   * #295, D-050). Named `lastSuccessAt` for backward compatibility with the
   * TopBar pill / `/api/ready` consumers, but the source is now the freshness
   * cadence, not "any ok run within 24h". null when it has never completed a
   * cycle. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the latest run of ANY status, or null if never run. */
  lastRunAt: string | null;
  /** Status of the latest run of any status, or null if never run. */
  lastRunStatus: string | null;
  /**
   * Freshness cadence state (issue #295, D-050): "fresh" / "refreshing" /
   * "stuck" / "due". `isStale` collapses this to a boolean, but the TopBar can
   * render "refreshing" distinctly from a flat "stale". */
  state: ConnectorFreshnessKind;
  /**
   * True when enabled AND due-or-stuck. A connector mid-cycle-and-not-stuck is
   * NOT stale — it is actively refreshing (state="refreshing"). */
  isStale: boolean;
}

export interface DataHealthResponse {
  /** One entry per registered connector (both enabled and disabled). */
  connectors: ConnectorFreshness[];
  /** True when any ENABLED connector is stale (due or stuck). */
  overallStale: boolean;
  /**
   * True when any ENABLED connector is mid-cycle and not stuck (state=
   * "refreshing") — a distinct signal from stale, so the pill can show
   * "refreshing" rather than a flat "stale" (issue #295, D-050). */
  overallRefreshing: boolean;
  /**
   * The enabled connector whose last successful run is oldest (a
   * never-succeeded connector sorts oldest). Drives the TopBar headline
   * age. null when no connector is enabled.
   */
  stalestConnector: {
    connector: string;
    lastSuccessAt: string | null;
    lastRunStatus: string | null;
  } | null;
  /**
   * Newest successful-run timestamp across enabled connectors — "the data
   * is at least this fresh". null when no enabled connector has ever
   * succeeded.
   */
  freshestSuccessAt: string | null;
}

interface FreshnessRow {
  connector: string;
  enabled: boolean;
  freshness_interval_hours: number | string | null;
  last_fresh_at: Date | string | null;
  cycle_started_at: Date | string | null;
  cycle_target_scope_count: number | string | null;
  covered_scope_count: number | string | null;
  last_run_at: Date | string | null;
  last_run_status: string | null;
}

function numOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  // pg normally hands back a Date for TIMESTAMPTZ; tolerate a string too.
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/**
 * One row per registered connector, each carrying its latest successful run
 * and its latest run of any status. LEFT JOIN LATERAL keeps a connector that
 * has never run (or never succeeded) in the result with NULLs, so it can be
 * flagged stale rather than silently dropped.
 */
const FRESHNESS_QUERY = `
  SELECT
    g.connector_name AS connector,
    COALESCE(c.enabled, true) AS enabled,
    c.freshness_interval_hours,
    f.last_fresh_at,
    f.cycle_started_at,
    f.cycle_target_scope_count,
    -- Scopes (re)discovered since the current cycle started; 0 when idle.
    COALESCE(cov.covered_count, 0) AS covered_scope_count,
    la.last_run_at,
    la.last_run_status
  FROM connector_registry g
  LEFT JOIN connector_config c ON c.connector_name = g.connector_name
  LEFT JOIN connector_freshness_state f ON f.connector_name = g.connector_name
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS covered_count
      FROM connector_scope_state s
     WHERE s.connector_name = g.connector_name
       AND f.cycle_started_at IS NOT NULL
       AND s.last_discovered_at >= f.cycle_started_at
  ) cov ON true
  LEFT JOIN LATERAL (
    SELECT r.status AS last_run_status,
           COALESCE(r.finished_at, r.started_at) AS last_run_at
      FROM connector_run_results r
     WHERE r.connector_name = g.connector_name
     ORDER BY r.run_id DESC
     LIMIT 1
  ) la ON true
  WHERE g.registered = true
  ORDER BY g.connector_name
`;

/**
 * Compute per-connector freshness from `connector_registry` +
 * `connector_config` + `connector_freshness_state` (issue #295, D-050). A
 * connector is stale when it is DUE or STUCK; a connector mid-cycle-not-stuck is
 * "refreshing", NOT stale. There is no fallback to the old "any ok run within
 * 24h" heuristic — a connector with no `connector_freshness_state` row simply
 * has `last_fresh_at = NULL` = due = stale, same as any never-fresh connector.
 * Throws on any DB error (including 42P01 when the tables are missing) — callers
 * decide how to degrade.
 *
 * @param opts.nowMs   Injectable clock for testing (defaults to Date.now()).
 * @param opts.thresholdHours Override the default freshness interval (hours) —
 *   applies only to connectors with no per-connector override.
 */
export async function getConnectorFreshness(opts?: {
  nowMs?: number;
  thresholdHours?: number;
}): Promise<DataHealthResponse> {
  const nowMs = opts?.nowMs ?? Date.now();
  const defaultIntervalHours = opts?.thresholdHours ?? defaultFreshnessIntervalHours();
  const stuckAfterHours = freshnessCycleStuckAfterHours();

  const rows = await sql<FreshnessRow>(FRESHNESS_QUERY);

  const connectors: ConnectorFreshness[] = rows.map((row) => {
    const enabled = row.enabled === true;
    const f = deriveFreshnessState({
      intervalHoursOverrideRaw: row.freshness_interval_hours,
      lastFreshAt: row.last_fresh_at,
      cycleStartedAt: row.cycle_started_at,
      targetScopeCount: numOrNull(row.cycle_target_scope_count),
      coveredScopeCount: numOrNull(row.covered_scope_count),
      defaultIntervalHours,
      stuckAfterHours,
      nowMs,
    });
    // Stale = enabled AND (due or stuck). "refreshing" is a live cycle, not
    // stale; "fresh" is obviously not stale. A disabled connector is never
    // counted as stale — its silence is intentional (issue #241 precedent).
    const isStale = enabled && (f.kind === "due" || f.kind === "stuck");
    return {
      connector: row.connector,
      enabled,
      lastSuccessAt: f.lastFreshAt,
      lastRunAt: toIso(row.last_run_at),
      lastRunStatus: row.last_run_status,
      state: f.kind,
      isStale,
    };
  });

  const enabledConnectors = connectors.filter((c) => c.enabled);
  const overallStale = enabledConnectors.some((c) => c.isStale);
  const overallRefreshing = enabledConnectors.some((c) => c.state === "refreshing");

  // Stalest = oldest last-success among ENABLED connectors; a
  // never-succeeded connector (null) sorts as the oldest of all.
  let stalest: ConnectorFreshness | null = null;
  for (const c of enabledConnectors) {
    if (stalest === null) {
      stalest = c;
      continue;
    }
    const a = c.lastSuccessAt;
    const b = stalest.lastSuccessAt;
    if (a === null) {
      // null is the most stale; keep the first null we saw.
      if (b !== null) stalest = c;
    } else if (b !== null && new Date(a).getTime() < new Date(b).getTime()) {
      stalest = c;
    }
  }

  let freshestSuccessAt: string | null = null;
  for (const c of enabledConnectors) {
    if (c.lastSuccessAt === null) continue;
    if (
      freshestSuccessAt === null ||
      new Date(c.lastSuccessAt).getTime() > new Date(freshestSuccessAt).getTime()
    ) {
      freshestSuccessAt = c.lastSuccessAt;
    }
  }

  return {
    connectors,
    overallStale,
    overallRefreshing,
    stalestConnector: stalest
      ? {
          connector: stalest.connector,
          lastSuccessAt: stalest.lastSuccessAt,
          lastRunStatus: stalest.lastRunStatus,
        }
      : null,
    freshestSuccessAt,
  };
}
