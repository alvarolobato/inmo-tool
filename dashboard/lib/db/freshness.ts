/**
 * Connector-pipeline freshness (issue #241; corrected for capture-only
 * portals in issue #586) — server-only (imports lib/db-write, the `pg`
 * client). Never import from a client component.
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
 * Issue #586 — what green now asserts: "no in-scope source is due", where
 * in-scope is every crawl connector with `connector_config.enabled = true`
 * PLUS every capture-only portal (`supports_discovery = false` AND
 * `capture_enabled = true`, e.g. Idealista, D-055). Green is deliberately
 * NOT "something arrived recently" — those are different claims, and the
 * bug this fixes is the code making the weaker one while the dot displayed
 * the stronger one. Before this fix, Idealista's `enabled` stayed false BY
 * DESIGN (its automated crawl is WAF-blocked, D-019-class) and the whole
 * surface only ever read `connector_config.enabled`, so a capture-only
 * portal could go silent forever and the dot would stay green — it was
 * structurally impossible for the dot to reflect capture staleness at all,
 * not merely mistuned. See D-125.
 *
 * Definition of "fresh" for THIS pipeline:
 *   - For a crawl connector, the unit is the connector's freshness CYCLE
 *     (`connector_freshness_state`, issue #295/D-050): `lastSuccessAt` is
 *     when the last full cycle completed; `lastRunAt`/`lastRunStatus` is the
 *     latest run of ANY status (`connector_run_results`), so a currently
 *     failing/blocked connector — e.g. milanuncios soft-blocked — shows its
 *     real state, not just its last good one.
 *   - For a capture-only portal, there is no crawl cycle at all (it never
 *     runs `discover()`) — freshness instead comes from `extension_capture`:
 *     `lastSuccessAt` is the latest `status = 'done'` row's `created_at` for
 *     that connector (a launched-but-FAILED capture must not read as fresh —
 *     only 'done' counts, never the `capture_task_run` launch ledger). The
 *     window is `connector_config.freshness_interval_hours` when set, else
 *     the Captura staleness config (`capture.staleness_days[_<portal>]`,
 *     issue #289) × 24 — the SAME `deriveFreshnessState()` state machine as
 *     crawl connectors (issue #295/D-050), never a second one, just fed a
 *     different pair of (lastFreshAt, defaultIntervalHours) and no cycle
 *     ("refreshing"/"stuck" are meaningless for a discrete capture event —
 *     cycleStartedAt is always null, so a capture-only portal can only ever
 *     read "fresh" or "due").
 *   - A connector/portal is STALE when it is IN SCOPE (see above) AND due or
 *     stuck. "Never succeeded" (or never captured) is deliberately stale,
 *     not silently fresh — that is the exact class of false-negative the old
 *     watermark bug, and this one, both produced. An OUT-of-scope
 *     connector (crawl-disabled with no capture fallback) is reported but
 *     never counted as stale — its silence is intentional, not a failure.
 *   - Fail dark, never green: when the in-scope set is empty (nothing
 *     registered, or a genuinely fresh install) OR the query itself fails,
 *     the response is `overallUnknown: true` — never a silent "nothing due".
 *     `overallStale`/`overallRefreshing` stay `false` alongside it (there is
 *     nothing to assert either way), so a consumer that only checks
 *     `overallStale` never mis-reads "unknown" as "fine".
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
  freshnessCycleStuckAfterHours,
  isCaptureOnlyForFreshness,
  resolveConnectorFreshnessState,
} from "@/lib/db/connectors";
import type { ConnectorFreshnessKind } from "@/lib/connectors-schema";
import { getStalenessConfig } from "@/lib/captura-staleness-config";

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
  /** Operator enable state (connector_config.enabled, default true) — the
   * CRAWL flag only. A capture-only portal (Idealista) reports `enabled:
   * false` here even when it counts toward the in-scope set below — this
   * field's meaning is unchanged from before issue #586, see `inScope`. */
  enabled: boolean;
  /**
   * True when this connector counts toward `overallStale`/`overallRefreshing`
   * / `stalestConnector` (issue #586): `enabled` OR (`supports_discovery ===
   * false` AND `capture_enabled`). A crawl connector that's simply turned off
   * (supports_discovery=true, enabled=false) is reported but out of scope —
   * same posture the old `enabled`-only filter had for it. */
  inScope: boolean;
  /**
   * ISO timestamp the connector was last FRESH. For a crawl connector this is
   * `connector_freshness_state.last_fresh_at` — when its last full refresh
   * cycle completed (issue #295, D-050). For a capture-only portal (issue
   * #586) this is the latest `extension_capture` row with `status = 'done'`
   * for this connector — a launched-but-failed capture never counts. Named
   * `lastSuccessAt` for backward compatibility with the TopBar pill /
   * `/api/ready` consumers. null when it has never completed a cycle (or
   * never had a successful capture). */
  lastSuccessAt: string | null;
  /** ISO timestamp of the latest CRAWL run of ANY status, or null if never
   * run — always null for a capture-only portal (it never runs discover()). */
  lastRunAt: string | null;
  /** Status of the latest crawl run of any status, or null if never run —
   * always null for a capture-only portal. */
  lastRunStatus: string | null;
  /**
   * Freshness state, from the SAME `deriveFreshnessState()` machine for both
   * crawl and capture-only connectors (issue #295/D-050, extended #586):
   * "fresh" / "refreshing" / "stuck" / "due". A capture-only portal has no
   * cycle concept, so it can only ever be "fresh" or "due" — "refreshing"/
   * "stuck" apply to crawl connectors only. `isStale` collapses this to a
   * boolean, but the TopBar can render "refreshing" distinctly from a flat
   * "stale". */
  state: ConnectorFreshnessKind;
  /**
   * True when `inScope` AND due-or-stuck. A connector mid-cycle-and-not-stuck
   * is NOT stale — it is actively refreshing (state="refreshing"). A
   * connector out of scope is never stale — its silence is intentional. */
  isStale: boolean;
}

export interface DataHealthResponse {
  /** One entry per registered connector, in-scope or not (see `inScope`). */
  connectors: ConnectorFreshness[];
  /** True when any IN-SCOPE connector/portal is stale (due or stuck). Stays
   * `false` when `overallUnknown` is true — there is nothing to assert. */
  overallStale: boolean;
  /**
   * True when any IN-SCOPE connector is mid-cycle and not stuck (state=
   * "refreshing") — a distinct signal from stale, so the pill can show
   * "refreshing" rather than a flat "stale" (issue #295, D-050). */
  overallRefreshing: boolean;
  /**
   * Issue #586 — fail dark, never green: true when the freshness surface
   * cannot make an honest "nothing due" claim, either because the query
   * itself failed (see `data-health/route.ts`'s catch branch) or because the
   * in-scope set is empty (nothing registered, e.g. a fresh install). A
   * consumer MUST treat `overallUnknown: true` as "unknown", never as
   * `overallStale: false` meaning "fine".
   */
  overallUnknown: boolean;
  /**
   * Drives the TopBar headline age and names the most-overdue source in the
   * tooltip. null when nothing is in scope (see `overallUnknown`). Among
   * STALE connectors, a measurable regression (was fresh, went stale) is
   * always named ahead of one that has literally never succeeded — a
   * never-succeeded entry that permanently owns the headline is the
   * alarm-fatigue mirror of #586's original bug (issue #586, review finding
   * B2 on PR #590). When nothing is stale, this is simply the oldest
   * still-fresh success (for the "al día · hace Xh" age display).
   */
  stalestConnector: {
    connector: string;
    lastSuccessAt: string | null;
    lastRunStatus: string | null;
  } | null;
  /**
   * Newest success timestamp across in-scope connectors/portals — "the data
   * is at least this fresh". null when no in-scope connector has ever
   * succeeded.
   */
  freshestSuccessAt: string | null;
}

interface FreshnessRow {
  connector: string;
  enabled: boolean;
  supports_discovery: boolean;
  capture_enabled: boolean;
  freshness_interval_hours: number | string | null;
  last_fresh_at: Date | string | null;
  cycle_started_at: Date | string | null;
  cycle_target_scope_count: number | string | null;
  covered_scope_count: number | string | null;
  last_run_at: Date | string | null;
  last_run_status: string | null;
  last_capture_done_at: Date | string | null;
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
 * One row per registered connector, each carrying its latest successful crawl
 * run, its latest crawl run of any status, AND (issue #586) its latest 'done'
 * extension_capture — the capture-only portals' equivalent of a successful
 * run. LEFT JOIN LATERAL / LEFT JOIN keeps a connector that has never run (or
 * never succeeded, or never been captured) in the result with NULLs, so it
 * can be flagged stale rather than silently dropped.
 *
 * The `cap` subquery is one extra GROUP BY per poll (2-minute cadence,
 * FreshnessContext.tsx). Measured against a synthetic 300k-row
 * extension_capture (~100x the current live count): a plain
 * `WHERE status='done' GROUP BY connector_name` costs ~20ms via a parallel
 * seq scan — a supporting partial index on (connector_name, created_at) WHERE
 * status='done' was tried and made no difference, because there are only a
 * handful of distinct connector_name values (low-cardinality GROUP BY over a
 * wide scan doesn't benefit from an index the way a high-cardinality one
 * would). No index added; revisit if extension_capture ever grows into the
 * millions of rows.
 */
const FRESHNESS_QUERY = `
  SELECT
    g.connector_name AS connector,
    COALESCE(c.enabled, true) AS enabled,
    g.supports_discovery,
    COALESCE(c.capture_enabled, true) AS capture_enabled,
    c.freshness_interval_hours,
    f.last_fresh_at,
    f.cycle_started_at,
    f.cycle_target_scope_count,
    -- Scopes (re)discovered since the current cycle started; 0 when idle.
    COALESCE(cov.covered_count, 0) AS covered_scope_count,
    la.last_run_at,
    la.last_run_status,
    cap.last_capture_done_at
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
  LEFT JOIN (
    SELECT connector_name, MAX(created_at) AS last_capture_done_at
      FROM extension_capture
     WHERE status = 'done'
     GROUP BY connector_name
  ) cap ON cap.connector_name = g.connector_name
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
  // Captura staleness config (issue #289) — read once per call, not once per
  // row. Its own loader already degrades to hardcoded defaults on failure
  // (see captura-staleness-config.ts), so this never throws.
  const stalenessConfig = getStalenessConfig();

  const rows = await sql<FreshnessRow>(FRESHNESS_QUERY);

  const connectors: ConnectorFreshness[] = rows.map((row) => {
    const enabled = row.enabled === true;
    const captureEnabled = row.capture_enabled === true;
    // Issue #586/D-125: SAME predicate `listConnectors()` uses (`lib/db/
    // connectors.ts`) — not raw `supports_discovery=false`, which would also
    // catch a hypothetical future non-discovery connector that isn't
    // extension-capturable and permanently strand it "due" (Opus review, PR
    // #590).
    const captureOnly = isCaptureOnlyForFreshness(row.connector, row.supports_discovery);
    // In-scope predicate — a crawl connector counts when enabled; a
    // capture-only portal counts when capture processing is enabled,
    // REGARDLESS of its (by-design-false) crawl `enabled` flag.
    const inScope = enabled || (captureOnly && captureEnabled);

    // Issue #586/D-125: the SAME helper `listConnectors()` calls for the
    // /admin/fuentes pill — one definition, so the two surfaces cannot
    // structurally diverge on what "due" means.
    const f = resolveConnectorFreshnessState({
      connectorName: row.connector,
      supportsDiscovery: row.supports_discovery,
      freshnessIntervalHoursRaw: row.freshness_interval_hours,
      lastFreshAt: row.last_fresh_at,
      cycleStartedAt: row.cycle_started_at,
      targetScopeCount: numOrNull(row.cycle_target_scope_count),
      coveredScopeCount: numOrNull(row.covered_scope_count),
      lastCaptureDoneAt: row.last_capture_done_at,
      defaultIntervalHours,
      stalenessConfig,
      stuckAfterHours,
      nowMs,
    });
    // Stale = in scope AND (due or stuck). "refreshing" is a live cycle, not
    // stale; "fresh" is obviously not stale. An out-of-scope connector is
    // never counted as stale — its silence is intentional (issue #241
    // precedent, extended to capture-only portals by #586).
    const isStale = inScope && (f.kind === "due" || f.kind === "stuck");
    return {
      connector: row.connector,
      enabled,
      inScope,
      lastSuccessAt: f.lastFreshAt,
      lastRunAt: captureOnly ? null : toIso(row.last_run_at),
      lastRunStatus: captureOnly ? null : row.last_run_status,
      state: f.kind,
      isStale,
    };
  });

  const inScopeConnectors = connectors.filter((c) => c.inScope);
  // Issue #586 — fail dark, never green: nothing in scope means there is
  // nothing to honestly assert "is/isn't due" about (empty registry, or
  // every connector genuinely turned off with no capture fallback). This is
  // DISTINCT from "everything in scope is fresh" (a real, green claim).
  const overallUnknown = inScopeConnectors.length === 0;
  const overallStale = !overallUnknown && inScopeConnectors.some((c) => c.isStale);
  const overallRefreshing =
    !overallUnknown && inScopeConnectors.some((c) => c.state === "refreshing");

  // Stalest = the connector/portal the headline names (issue #586, review
  // finding B2 on PR #590). Two passes, deliberately NOT "null sorts oldest
  // of all" (the pre-B2 rule): a "never succeeded/captured" entry (hipoges,
  // say — capture_enabled but the owner has simply never used the extension
  // on it) is real due-ness for `overallStale`/`isStale`, but naming it as
  // THE headline permanently buries a genuine regression that DOES have a
  // measurable age (altamira going stale 11 days in) behind an entry that
  // will never clear on its own — the exact alarm-fatigue mirror of #586's
  // original "always green" bug, just inverted to "always the wrong name".
  //   1. Prefer the oldest MEASURABLE age among STALE connectors — an entry
  //      that regressed from a working state is the actionable one.
  //   2. Only when no stale connector has a measurable age (every stale one
  //      has literally never succeeded) fall back to naming one of those —
  //      still real, still worth surfacing, just lowest priority.
  //   3. Nothing stale at all → show the oldest still-FRESH success, for the
  //      "Datos al día · hace Xh" age display (unchanged from before B2).
  let stalest: ConnectorFreshness | null = null;
  const staleWithAge = inScopeConnectors.filter((c) => c.isStale && c.lastSuccessAt !== null);
  const staleNeverSucceeded = inScopeConnectors.filter(
    (c) => c.isStale && c.lastSuccessAt === null,
  );
  if (staleWithAge.length > 0) {
    for (const c of staleWithAge) {
      if (
        stalest === null ||
        new Date(c.lastSuccessAt!).getTime() < new Date(stalest.lastSuccessAt!).getTime()
      ) {
        stalest = c;
      }
    }
  } else if (staleNeverSucceeded.length > 0) {
    // Deterministic: FRESHNESS_QUERY orders by connector_name, so this is
    // always the same connector for a given data set, not query-plan luck.
    stalest = staleNeverSucceeded[0];
  } else {
    for (const c of inScopeConnectors) {
      if (c.lastSuccessAt === null) continue; // can't happen — null is always stale.
      if (
        stalest === null ||
        new Date(c.lastSuccessAt).getTime() < new Date(stalest.lastSuccessAt!).getTime()
      ) {
        stalest = c;
      }
    }
  }

  let freshestSuccessAt: string | null = null;
  for (const c of inScopeConnectors) {
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
    overallUnknown,
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
