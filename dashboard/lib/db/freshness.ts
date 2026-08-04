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
  /** ISO timestamp of the latest status='ok' run, or null if never. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the latest run of ANY status, or null if never run. */
  lastRunAt: string | null;
  /** Status of the latest run of any status, or null if never run. */
  lastRunStatus: string | null;
  /** True when enabled AND (never succeeded OR last success past threshold). */
  isStale: boolean;
}

export interface DataHealthResponse {
  /** One entry per registered connector (both enabled and disabled). */
  connectors: ConnectorFreshness[];
  /** True when any ENABLED connector is stale. */
  overallStale: boolean;
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
  last_success_at: Date | string | null;
  last_run_at: Date | string | null;
  last_run_status: string | null;
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
    s.last_success_at,
    la.last_run_at,
    la.last_run_status
  FROM connector_registry g
  LEFT JOIN connector_config c ON c.connector_name = g.connector_name
  LEFT JOIN LATERAL (
    SELECT COALESCE(r.finished_at, r.started_at) AS last_success_at
      FROM connector_run_results r
     WHERE r.connector_name = g.connector_name
       AND r.status = 'ok'
     ORDER BY r.run_id DESC
     LIMIT 1
  ) s ON true
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
 * `connector_config` + `connector_run_results`. Throws on any DB error
 * (including 42P01 when the tables are missing) — callers decide how to
 * degrade.
 *
 * @param opts.nowMs   Injectable clock for testing (defaults to Date.now()).
 * @param opts.thresholdHours Override the staleness threshold in hours.
 */
export async function getConnectorFreshness(opts?: {
  nowMs?: number;
  thresholdHours?: number;
}): Promise<DataHealthResponse> {
  const nowMs = opts?.nowMs ?? Date.now();
  const thresholdMs = (opts?.thresholdHours ?? staleThresholdHours()) * 3600 * 1000;

  const rows = await sql<FreshnessRow>(FRESHNESS_QUERY);

  const connectors: ConnectorFreshness[] = rows.map((row) => {
    const lastSuccessAt = toIso(row.last_success_at);
    const enabled = row.enabled === true;
    let isStale = false;
    if (enabled) {
      if (lastSuccessAt === null) {
        isStale = true;
      } else {
        isStale = nowMs - new Date(lastSuccessAt).getTime() > thresholdMs;
      }
    }
    return {
      connector: row.connector,
      enabled,
      lastSuccessAt,
      lastRunAt: toIso(row.last_run_at),
      lastRunStatus: row.last_run_status,
      isStale,
    };
  });

  const enabledConnectors = connectors.filter((c) => c.enabled);
  const overallStale = enabledConnectors.some((c) => c.isStale);

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
