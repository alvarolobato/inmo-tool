/**
 * Estado board — server-side aggregation (issue #638, part of #636).
 *
 * Ground truth is the `listing` table (`source`, `first_seen_at`,
 * `last_seen_at`, `last_fetched_at`) — the one ledger both the crawl path
 * (etl/orchestrator.py) and the capture path (etl/capture.py) actually
 * write. `connector_run_results` / `extension_capture` / `extension_heartbeat`
 * feed the Errores signal only — they explain a problem, they never define
 * "healthy" on their own (see lib/source-health.ts's header for why that
 * inversion is exactly the bug this replaces).
 *
 * "Data activity" for one listing is
 * `GREATEST(last_seen_at, last_fetched_at, first_seen_at)` — the same triple
 * used by lib/db/data-health.ts's stale-profile check, reused here rather
 * than inventing a second "what counts as activity" definition.
 *
 * `last_seen_at` accuracy for captured portals depends on issue #639 (a
 * captured RESULTS page must bump `last_seen_at` for every already-known
 * listing it lists — in flight as of this writing). This module reads
 * whatever `last_seen_at` the DB has; it does not duplicate #639's write
 * path. Once #639 lands, Frescura for capture sources gets more accurate for
 * free — no change needed here.
 *
 * Server-only (imports lib/db-write's `pg` client) — never import from a
 * client component; lib/source-health.ts holds the pure, client-safe types
 * and derivation.
 */

import { sql } from "@/lib/db-write";
import {
  defaultFreshnessIntervalHours,
  isCaptureOnlyForFreshness,
  resolveFreshnessInterval,
} from "@/lib/db/connectors";
import { getStalenessConfig } from "@/lib/captura-staleness-config";
import { resolveStalenessDays } from "@/lib/captura-tasks";
import { getExtensionStatus } from "@/lib/db/extension-status";
import {
  deriveSourceStatus,
  worstOfStatuses,
  compareSourceRows,
  CAPTURE_HEARTBEAT_STALE_DAYS,
  type SourceHealthDerivation,
  type SourceKind,
  type SourceStatus,
} from "@/lib/source-health";

export interface SourceHealthRow extends SourceHealthDerivation {
  source: string;
  kind: SourceKind;
  status: SourceStatus;
  /** D-055: this source is operator-disabled (crawl `enabled=false`, or
   * capture `capture_enabled=false`) — excluded from the rollup and rendered
   * collapsed at the bottom, never as a failure. */
  disabled: boolean;
  freshnessIntervalHours: number;
  lastActivityAt: string | null;
  /** Genuinely NEW listings (first_seen_at) in the trailing 24h — never
   * re-sightings (issue #638 review S2: a GREATEST-based count here read
   * "+3886" for cimenta2 on a day it ingested zero new listings, because a
   * full re-sweep touches last_seen_at/last_fetched_at on its whole
   * existing catalogue). This is Volumen's headline number; keep it
   * first_seen_at-only if this ever changes again. */
  new24h: number;
  /** 7 daily buckets, OLDEST first (6 days ago) .. newest last (today) —
   * "tocados" (GREATEST(last_seen_at, last_fetched_at, first_seen_at)) per
   * day, deliberately NOT the same "nuevos" definition as new24h above —
   * this is the sparkline's own, looser signal (#636's metric table
   * reserves nuevos/tocados for the sparkline specifically). Never caption
   * this as "nuevos" in the UI. */
  sparkline7d: number[];
  latestRunStatus: string | null;
  latestRunFailureClassification: string | null;
  captureFailed7d: number;
  captureTotal7d: number;
  /** #636 addendum point 4 — last complete observation pass: the crawl
   * cycle-close timestamp (D-050) for a crawl source, or null for a capture
   * source (rendered "—" client-side — a complete-enumeration ledger is
   * issue #645, not yet built). */
  ultimaPasadaCompletaAt: string | null;
}

export interface SourceHealthResponse {
  sources: SourceHealthRow[];
  /** Worst-of status across every NON-disabled source, or null when there
   * are no in-scope sources at all (fail dark, never silently "fresco"). */
  rollupStatus: SourceStatus | null;
  generatedAt: string;
  /**
   * Issue #638 review: `sources: []` alone is AMBIGUOUS — it's the shape of
   * BOTH a genuinely empty registry AND a degraded response after a query
   * failure (`GET /api/etl/source-health`'s catch branch), and the two are
   * not the same claim. `ok: true` here means this really is a successful
   * read of `connector_registry` (possibly, honestly, of zero rows); the
   * route sets `false` only in its catch branch. A client must check this
   * BEFORE reading anything into an empty `sources` array — e.g. never
   * render "no sources registered" when `ok` is false, that would assert a
   * specific fact about a state that is actually unknown.
   */
  ok: boolean;
}

interface MetaRow {
  connector: string;
  supports_discovery: boolean;
  enabled: boolean;
  capture_enabled: boolean;
  freshness_interval_hours: number | string | null;
  latest_run_status: string | null;
  latest_run_failure_classification: string | null;
  capture_failed_7d: number | string | null;
  capture_total_7d: number | string | null;
  last_fresh_at: Date | string | null;
}

interface ListingActivityRow {
  source: string;
  last_activity_at: Date | string | null;
  new_24h: number | string;
  d6: number | string;
  d5: number | string;
  d4: number | string;
  d3: number | string;
  d2: number | string;
  d1: number | string;
  d0: number | string;
}

const META_QUERY = `
  SELECT
    g.connector_name AS connector,
    g.supports_discovery,
    COALESCE(c.enabled, true) AS enabled,
    COALESCE(c.capture_enabled, true) AS capture_enabled,
    c.freshness_interval_hours,
    la.status AS latest_run_status,
    la.failure_classification AS latest_run_failure_classification,
    cap.failed_7d AS capture_failed_7d,
    cap.total_7d AS capture_total_7d,
    f.last_fresh_at
  FROM connector_registry g
  LEFT JOIN connector_config c ON c.connector_name = g.connector_name
  LEFT JOIN connector_freshness_state f ON f.connector_name = g.connector_name
  LEFT JOIN LATERAL (
    SELECT r.status, r.failure_classification
      FROM connector_run_results r
     WHERE r.connector_name = g.connector_name
     ORDER BY r.id DESC
     LIMIT 1
  ) la ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE ec.status = 'failed')              AS failed_7d,
      COUNT(*) FILTER (WHERE ec.status IN ('failed', 'done'))    AS total_7d
      FROM extension_capture ec
     WHERE ec.created_at > NOW() - INTERVAL '7 days'
       AND (
             ec.connector_name = g.connector_name
             -- Issue #638 review (S1): every capture FAILURE written before
             -- the etl/capture.py _mark_failed fix left connector_name NULL
             -- (only the success paths set it) -- e.g. production ids
             -- 3576/3577 (hipoges, 2026-08-19), the exact "50% failure rate"
             -- rows the owner cited in #636's addendum. Fall back to the
             -- URL's host for those so historical failures are still
             -- attributed instead of permanently invisible. Kept in
             -- lockstep with dashboard/lib/worklist.ts CAPTURE_PORTALS --
             -- the same four portals D-069/capture_worklist's cleanup
             -- already has to keep in step; add a portal there, add its
             -- host suffix here too.
             OR (
               ec.connector_name IS NULL
               AND (
                 (g.connector_name = 'idealista' AND ec.url ILIKE '%idealista.com%')
                 OR (g.connector_name = 'aliseda' AND ec.url ILIKE '%alisedainmobiliaria.com%')
                 OR (g.connector_name = 'altamira' AND ec.url ILIKE '%altamirainmuebles.com%')
                 OR (g.connector_name = 'hipoges' AND ec.url ILIKE '%realestate.hipoges.com%')
               )
             )
           )
  ) cap ON true
  WHERE g.registered = true
  ORDER BY g.connector_name
`;

// One row per distinct `listing.source`. `new_24h` is Volumen's headline
// number and MUST mean "nuevos" literally -- first_seen_at only. Issue #638
// review (S2): the first cut filtered on GREATEST(last_seen_at,
// last_fetched_at, first_seen_at) here too, which counts every RE-SIGHTED
// listing as "new" -- measured live, cimenta2 (a full-sweep connector that
// re-touches its whole catalogue every run) read "+3886 en 24h" with ZERO
// actual new listings that day. The 7-day sparkline (d0..d6) stays
// GREATEST-based -- it is deliberately "touched", not "nuevos" (#636's own
// metric table reserves nuevos/tocados for the sparkline; the UI must not
// caption it as new-listings-per-day) -- truncated to its calendar day as 7
// discrete FILTER counts, cheaper and more transparent than a
// generate_series join for a fixed 7-day window, mirroring the plain
// conditional-aggregation style lib/db/data-health.ts already uses for this
// table.
const LISTING_ACTIVITY_QUERY = `
  SELECT
    source,
    MAX(GREATEST(last_seen_at, last_fetched_at, first_seen_at)) AS last_activity_at,
    COUNT(*) FILTER (
      WHERE first_seen_at > NOW() - INTERVAL '24 hours'
    ) AS new_24h,
    COUNT(*) FILTER (WHERE date_trunc('day', GREATEST(last_seen_at, last_fetched_at, first_seen_at))
      = date_trunc('day', NOW()) - INTERVAL '6 days') AS d6,
    COUNT(*) FILTER (WHERE date_trunc('day', GREATEST(last_seen_at, last_fetched_at, first_seen_at))
      = date_trunc('day', NOW()) - INTERVAL '5 days') AS d5,
    COUNT(*) FILTER (WHERE date_trunc('day', GREATEST(last_seen_at, last_fetched_at, first_seen_at))
      = date_trunc('day', NOW()) - INTERVAL '4 days') AS d4,
    COUNT(*) FILTER (WHERE date_trunc('day', GREATEST(last_seen_at, last_fetched_at, first_seen_at))
      = date_trunc('day', NOW()) - INTERVAL '3 days') AS d3,
    COUNT(*) FILTER (WHERE date_trunc('day', GREATEST(last_seen_at, last_fetched_at, first_seen_at))
      = date_trunc('day', NOW()) - INTERVAL '2 days') AS d2,
    COUNT(*) FILTER (WHERE date_trunc('day', GREATEST(last_seen_at, last_fetched_at, first_seen_at))
      = date_trunc('day', NOW()) - INTERVAL '1 day') AS d1,
    COUNT(*) FILTER (WHERE date_trunc('day', GREATEST(last_seen_at, last_fetched_at, first_seen_at))
      = date_trunc('day', NOW())) AS d0
    FROM listing
   GROUP BY source
`;

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function numOrZero(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Aggregate per-source health for the Estado board. Two independent reads
 * (connector metadata/error-signal, listing activity) plus the single-row
 * extension heartbeat, joined in JS by source name — kept as two SQL
 * statements rather than one giant join so each stays readable and testable
 * on its own; `listing` and `connector_registry` have no foreign key between
 * them to join on server-side anyway (matching is purely on the shared
 * `source`/`connector_name` string).
 */
export async function getSourceHealth(opts?: {
  nowMs?: number;
}): Promise<SourceHealthResponse> {
  const nowMs = opts?.nowMs ?? Date.now();
  const defaultIntervalHours = defaultFreshnessIntervalHours();
  const stalenessConfig = getStalenessConfig();

  const [metaRows, activityRows, extensionStatus] = await Promise.all([
    sql<MetaRow>(META_QUERY),
    sql<ListingActivityRow>(LISTING_ACTIVITY_QUERY),
    getExtensionStatus(),
  ]);

  const activityBySource = new Map(activityRows.map((r) => [r.source, r]));

  const heartbeatStale =
    extensionStatus.lastSeenAt === null ||
    nowMs - new Date(extensionStatus.lastSeenAt).getTime() >
      CAPTURE_HEARTBEAT_STALE_DAYS * 24 * 60 * 60 * 1000;

  const sources: SourceHealthRow[] = metaRows.map((meta) => {
    const kind: SourceKind = isCaptureOnlyForFreshness(meta.connector, meta.supports_discovery)
      ? "capture"
      : "crawl";
    const disabled = kind === "crawl" ? meta.enabled !== true : meta.capture_enabled !== true;

    const activity = activityBySource.get(meta.connector);
    const lastActivityAt = activity ? toIso(activity.last_activity_at) : null;
    const new24h = activity ? numOrZero(activity.new_24h) : 0;
    const sparkline7d = activity
      ? [
          numOrZero(activity.d6),
          numOrZero(activity.d5),
          numOrZero(activity.d4),
          numOrZero(activity.d3),
          numOrZero(activity.d2),
          numOrZero(activity.d1),
          numOrZero(activity.d0),
        ]
      : [0, 0, 0, 0, 0, 0, 0];

    const defaultHoursForKind =
      kind === "capture"
        ? resolveStalenessDays(meta.connector, stalenessConfig) * 24
        : defaultIntervalHours;
    const { effectiveIntervalHours } = resolveFreshnessInterval(
      meta.freshness_interval_hours,
      defaultHoursForKind,
    );

    const captureFailed7d = numOrZero(meta.capture_failed_7d);
    const captureTotal7d = numOrZero(meta.capture_total_7d);

    const derivation = deriveSourceStatus({
      kind,
      freshnessIntervalHours: effectiveIntervalHours,
      lastActivityAt,
      nowMs,
      latestRunStatus: kind === "crawl" ? meta.latest_run_status : null,
      latestRunFailureClassification:
        kind === "crawl" ? meta.latest_run_failure_classification : null,
      captureFailed7d: kind === "capture" ? captureFailed7d : 0,
      captureTotal7d: kind === "capture" ? captureTotal7d : 0,
      heartbeatStale: kind === "capture" ? heartbeatStale : false,
    });

    return {
      source: meta.connector,
      kind,
      disabled,
      freshnessIntervalHours: effectiveIntervalHours,
      lastActivityAt,
      new24h,
      sparkline7d,
      latestRunStatus: meta.latest_run_status,
      latestRunFailureClassification: meta.latest_run_failure_classification,
      captureFailed7d,
      captureTotal7d,
      ultimaPasadaCompletaAt: kind === "crawl" ? toIso(meta.last_fresh_at) : null,
      ...derivation,
    };
  });

  // Disabled sources (D-055) render collapsed at the bottom, never mixed in
  // among failures — compareSourceRows ranks only the in-scope rows it's
  // handed (see its own docstring), so the split happens here.
  const active = sources.filter((s) => !s.disabled).sort(compareSourceRows);
  const disabledSources = sources
    .filter((s) => s.disabled)
    .sort((a, b) => a.source.localeCompare(b.source));

  const rollupStatus = worstOfStatuses(active.map((s) => s.status));

  return {
    sources: [...active, ...disabledSources],
    rollupStatus,
    generatedAt: new Date(nowMs).toISOString(),
    ok: true,
  };
}
