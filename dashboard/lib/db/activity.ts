/**
 * Actividad — the unified ingest chronology, server side (issue #644).
 *
 * ONE query. Eight tables that today only ever get read separately, merged
 * into a single chronological ledger by a `UNION ALL` over a normalised
 * column set, with the rollups (capture sessions, requeue batches, status-
 * change runs) computed in SQL at read time. No session table exists and
 * none is introduced — the grouping is derived, so it re-derives correctly
 * when history is re-read.
 *
 * Sources, and what each contributes:
 *
 * | table                     | kind      | rollup                            |
 * |---------------------------|-----------|-----------------------------------|
 * | `connector_run_results`   | `crawl`   | one row per connector per sweep   |
 * | `connector_runs`          | `sweep`   | only sweeps with NO result rows   |
 * | `extension_capture`       | `captura` | session: portal + 30-min gap      |
 * | `capture_worklist`        | `recola`  | batch: portal + reason + stamp    |
 * | `dedup_runs`              | `dedup`   | one row per pass                  |
 * | `etl_manual_trigger`      | `manual`  | one row per trigger               |
 * | `listing_status_event`    | `estado`  | run: source + transition + gap    |
 * | `extension_block_episode` | `bloqueo` | one row per episode               |
 *
 * ── Two deliberate non-obvious choices ───────────────────────────────────
 *
 * 1. **A sweep only gets a row of its own when it produced no per-connector
 *    outcome.** Otherwise its connectors already speak for it and a sweep
 *    row would restate them. That inversion is the point rather than an
 *    optimisation: production run #212 stored `total_connectors = 0,
 *    duration_ms = 3` — the D-009 crash-loop guard declining to sweep — and
 *    under the old run-list that is indistinguishable from a healthy quiet
 *    run. It is the literal "¿por qué esta pasada no produjo nada?" case,
 *    and it is the ONLY case where a sweep has something to say that its
 *    (nonexistent) children cannot.
 *
 * 2. **Disabled sources are NOT filtered out.** `activeSourceClause()` /
 *    `DISABLED_SOURCES_CTE` (lib/db/source-active.ts) exist so a switched-off
 *    portal's listings stop appearing as live candidates. This is a history
 *    feed: what a source did last Tuesday remains true after it is switched
 *    off, and hiding it would silently rewrite the record — including hiding
 *    the very run that made the operator switch it off. So no source
 *    discriminator is applied here, and no fourth copy of it is created.
 *
 * ── Day windows ──────────────────────────────────────────────────────────
 * The window is `[fromDay 00:00, toDayExclusive 00:00)` in **Europe/Madrid**
 * (production Postgres runs in UTC; the owner does not). Sessions are
 * partitioned by Madrid-local day as well as by portal, so a session never
 * straddles a page boundary — see lib/activity.ts's header for why paging by
 * days rather than by a row cursor is a correctness property, not a
 * cosmetic one.
 *
 * Server-only (imports `lib/db-write`'s pool). The client-safe vocabulary,
 * labels, metric chips and rollups live in `lib/activity.ts`.
 */

import { sql } from "@/lib/db-write";
import type { ActivityEvent, ActivityKind, ActivityStatus } from "@/lib/activity";

/** Gap that ends a capture session / a run of status changes. */
export const SESSION_GAP_MINUTES = 30;

/**
 * Hard ceiling on rows returned for one window. Generous by two orders of
 * magnitude against production (a busy day rolls up to ~60 rows), but a
 * ceiling that silently drops the oldest half of a day would be exactly the
 * "looked measured, wasn't" failure this feed exists to avoid — so
 * `getActivityEvents` reports when it bites instead of hiding it.
 */
const MAX_EVENTS = 400;

interface RawRow {
  kind: string;
  source: string | null;
  t: Date;
  t_end: Date | null;
  raw_status: string | null;
  note: string | null;
  codes: string[] | null;
  id: string;
  detail_href: string | null;
  rolled_up: number | string;
  counts: Record<string, number | string | null>;
}

/**
 * The merged ledger for one Madrid-local day window.
 *
 * `$1` = first day (inclusive, `YYYY-MM-DD`), `$2` = day AFTER the last
 * (exclusive). `$3` = the session gap, as a Postgres interval string.
 */
const ACTIVITY_SQL = `
WITH bounds AS (
  SELECT ($1::date)::timestamp AT TIME ZONE 'Europe/Madrid' AS lo,
         ($2::date)::timestamp AT TIME ZONE 'Europe/Madrid' AS hi,
         ($3::text)::interval                               AS gap
),

-- ── crawl: one connector's outcome inside a sweep ───────────────────────
crawl AS (
  SELECT 'crawl'::text                              AS kind,
         rr.connector_name                          AS source,
         COALESCE(rr.started_at, cr.started_at)     AS t,
         rr.finished_at                             AS t_end,
         rr.status                                  AS raw_status,
         NULL::text                                 AS note,
         -- Two short stable codes, either or both possibly absent: the typed
         -- failure kind (D-079) and the mass-withdrawal guard's verdict
         -- (D-157). NEVER error_msg — that is drill-through only (#531).
         ARRAY_REMOVE(ARRAY[rr.failure_classification, rr.verification_alarm], NULL) AS codes,
         'crawl:' || rr.id::text                    AS id,
         '/etl/' || rr.run_id::text                 AS detail_href,
         1::bigint                                  AS rolled_up,
         jsonb_build_object(
           'discovered',   rr.discovered_count,
           'fetched',      rr.fetched_count,
           'unchanged',    NULLIF(rr.skipped_unchanged_count, 0),
           'errors',       rr.error_count,
           'verified',     NULLIF(rr.verified_count, 0),
           'gone',         rr.verified_gone_count,
           -- D-162 rule 2: 0 here means "no timing recorded" (rows written
           -- before #695), not "instant". NULLIF keeps it "—".
           'fetchMsTotal', NULLIF(rr.fetch_ms_total, 0)
         )                                          AS counts
    FROM connector_run_results rr
    JOIN connector_runs cr ON cr.id = rr.run_id
   CROSS JOIN bounds b
   WHERE COALESCE(rr.started_at, cr.started_at) >= b.lo
     AND COALESCE(rr.started_at, cr.started_at) <  b.hi
),

-- ── sweep: ONLY runs that recorded no per-connector outcome ─────────────
sweep AS (
  SELECT 'sweep'                                    AS kind,
         NULL::text                                 AS source,
         cr.started_at                              AS t,
         cr.finished_at                             AS t_end,
         cr.status                                  AS raw_status,
         cr.trigger                                 AS note,
         ARRAY[]::text[]                            AS codes,
         'sweep:' || cr.id::text                    AS id,
         '/etl/' || cr.id::text                     AS detail_href,
         1::bigint                                  AS rolled_up,
         jsonb_build_object(
           'connectors', cr.total_connectors,
           'ok',         cr.connectors_ok,
           'failed',     cr.connectors_failed,
           'skipped',    cr.connectors_skipped,
           'durationMs', cr.duration_ms
         )                                          AS counts
    FROM connector_runs cr
   CROSS JOIN bounds b
   WHERE cr.started_at >= b.lo
     AND cr.started_at <  b.hi
     AND NOT EXISTS (SELECT 1 FROM connector_run_results x WHERE x.run_id = cr.id)
),

-- ── captura: sessions over extension_capture ────────────────────────────
cap_rows AS (
  SELECT c.id, c.connector_name, c.created_at, c.status,
         c.render_wait_ms, c.processing_ms,
         (c.created_at AT TIME ZONE 'Europe/Madrid')::date AS mday
    FROM extension_capture c
   CROSS JOIN bounds b
   WHERE c.created_at >= b.lo AND c.created_at < b.hi
),
cap_marked AS (
  SELECT r.*,
         CASE
           WHEN LAG(r.created_at) OVER w IS NULL                       THEN 1
           WHEN LAG(r.mday)       OVER w IS DISTINCT FROM r.mday       THEN 1
           WHEN r.created_at - LAG(r.created_at) OVER w
                  > (SELECT gap FROM bounds)                           THEN 1
           ELSE 0
         END AS starts_session
    FROM cap_rows r
  WINDOW w AS (PARTITION BY r.connector_name ORDER BY r.created_at, r.id)
),
cap_sessions AS (
  SELECT m.*,
         SUM(m.starts_session) OVER (
           PARTITION BY m.connector_name ORDER BY m.created_at, m.id
           ROWS UNBOUNDED PRECEDING
         ) AS sid
    FROM cap_marked m
),
captura AS (
  SELECT 'captura'                                  AS kind,
         s.connector_name                           AS source,
         MIN(s.created_at)                          AS t,
         MAX(s.created_at)                          AS t_end,
         -- Statuses that carry meaning for the whole session, in one code
         -- the TS side maps to an ActivityStatus. Never prose.
         CASE
           WHEN COUNT(*) FILTER (WHERE s.status = 'pending') > 0 THEN 'pending'
           WHEN COUNT(*) FILTER (WHERE s.status = 'done')    = 0 THEN 'empty'
           WHEN COUNT(*) FILTER (WHERE s.status IN ('failed','blocked')) > 0 THEN 'partial'
           ELSE 'ok'
         END                                        AS raw_status,
         NULL::text                                 AS note,
         ARRAY[]::text[]                            AS codes,
         'captura:' || MIN(s.id)::text              AS id,
         CASE WHEN s.connector_name IS NULL THEN NULL
              ELSE '/admin/fuentes/' || s.connector_name END AS detail_href,
         COUNT(*)                                   AS rolled_up,
         jsonb_build_object(
           'total',     COUNT(*),
           'done',      COUNT(*) FILTER (WHERE s.status = 'done'),
           'failed',    COUNT(*) FILTER (WHERE s.status = 'failed'),
           'blocked',   COUNT(*) FILTER (WHERE s.status = 'blocked'),
           'pending',   COUNT(*) FILTER (WHERE s.status = 'pending'),
           'withdrawn', COUNT(*) FILTER (WHERE s.status = 'withdrawn'),
           'listing',   COUNT(*) FILTER (WHERE s.status = 'listing'),
           -- "Anómalas" = everything that is not a stored advert. Grouped
           -- because the owner's question is "did this session produce
           -- data?", not "which of six terminal states did each row land in"
           -- (that is the drill-down's job).
           'anomalous', COUNT(*) FILTER (WHERE s.status IN ('failed','blocked','withdrawn','listing')),
           -- D-162: the render wait is portal-caused and is the ONLY leg
           -- stored per capture that is not contaminated by the ~5 s poll
           -- idle. "timed" is its real denominator: rows predating #695
           -- carry NULL and must not read as 0.
           'timed',           COUNT(*) FILTER (WHERE s.render_wait_ms IS NOT NULL),
           'renderWaitMsP50', PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY s.render_wait_ms)
                                FILTER (WHERE s.render_wait_ms IS NOT NULL),
           'processingMsP50', PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY s.processing_ms)
                                FILTER (WHERE s.processing_ms IS NOT NULL)
         )                                          AS counts
    FROM cap_sessions s
   GROUP BY s.connector_name, s.sid
),

-- ── recola: one row per re-capture batch (D-156) ────────────────────────
-- A bulk requeue stamps every row it touches with the SAME requeued_at, so
-- the batch is already a group key — no gap heuristic needed.
recola AS (
  SELECT 'recola'                                   AS kind,
         w.source_portal                            AS source,
         w.requeued_at                              AS t,
         NULL::timestamptz                          AS t_end,
         'ok'                                       AS raw_status,
         NULL::text                                 AS note,
         ARRAY_REMOVE(ARRAY[w.requeue_reason], NULL) AS codes,
         'recola:' || MIN(w.id)::text               AS id,
         '/admin/fuentes/' || w.source_portal       AS detail_href,
         COUNT(*)                                   AS rolled_up,
         jsonb_build_object('rows', COUNT(*))       AS counts
    FROM capture_worklist w
   CROSS JOIN bounds b
   WHERE w.requeued_at IS NOT NULL
     AND w.requeued_at >= b.lo AND w.requeued_at < b.hi
   GROUP BY w.source_portal, w.requeued_at, w.requeue_reason
),

-- ── dedup: one row per pass ─────────────────────────────────────────────
dedup AS (
  SELECT 'dedup'                                    AS kind,
         NULL::text                                 AS source,
         d.started_at                               AS t,
         d.finished_at                              AS t_end,
         d.status                                   AS raw_status,
         NULL::text                                 AS note,
         ARRAY[]::text[]                            AS codes,
         'dedup:' || d.id::text                     AS id,
         '/admin/dedup'                             AS detail_href,
         1::bigint                                  AS rolled_up,
         jsonb_build_object(
           'pairs',      d.pairs_compared,
           'merged',     d.merged,
           'suggested',  d.suggested,
           'conflicts',  d.conflicts,
           'autoMerged', d.photo_hash_auto_merged,
           'durationMs', d.duration_ms
         )                                          AS counts
    FROM dedup_runs d
   CROSS JOIN bounds b
   WHERE d.started_at >= b.lo AND d.started_at < b.hi
),

-- ── manual: operator-requested sweeps ───────────────────────────────────
manual AS (
  SELECT 'manual'                                   AS kind,
         m.connector_name                           AS source,
         m.requested_at                             AS t,
         m.finished_at                              AS t_end,
         m.status                                   AS raw_status,
         m.triggered_by                             AS note,
         ARRAY[]::text[]                            AS codes,
         'manual:' || m.id::text                    AS id,
         CASE WHEN m.connector_run_id IS NOT NULL
              THEN '/etl/' || m.connector_run_id::text END AS detail_href,
         1::bigint                                  AS rolled_up,
         jsonb_build_object(
           'durationMs', CASE WHEN m.finished_at IS NOT NULL
                              THEN (EXTRACT(EPOCH FROM (m.finished_at - m.requested_at)) * 1000)::bigint
                         END
         )                                          AS counts
    FROM etl_manual_trigger m
   CROSS JOIN bounds b
   WHERE m.requested_at >= b.lo AND m.requested_at < b.hi
),

-- ── estado: listing status transitions (D-157) ──────────────────────────
-- 'active' events are mostly first sightings — pure ingest volume the crawl
-- and captura rows already report. The exception is a RESURRECTION: an
-- 'active' event on a listing that had previously been non-active. That is
-- a real market event and D-157's explicit-resurrection clause names it, so
-- it is kept and labelled separately rather than swept in with the noise.
est_rows AS (
  SELECT l.source,
         e.observed_at,
         (e.evidence IS NOT NULL) AS has_evidence,
         CASE WHEN e.status <> 'active' THEN e.status ELSE 'reactivated' END AS transition,
         (e.observed_at AT TIME ZONE 'Europe/Madrid')::date AS mday,
         e.id
    FROM listing_status_event e
    JOIN listing l ON l.id = e.listing_id
   CROSS JOIN bounds b
   WHERE e.observed_at >= b.lo AND e.observed_at < b.hi
     AND (
       e.status <> 'active'
       OR EXISTS (
         SELECT 1 FROM listing_status_event p
          WHERE p.listing_id = e.listing_id
            AND p.observed_at < e.observed_at
            AND p.status <> 'active'
       )
     )
),
est_marked AS (
  SELECT r.*,
         CASE
           WHEN LAG(r.observed_at) OVER w IS NULL                  THEN 1
           WHEN LAG(r.mday)        OVER w IS DISTINCT FROM r.mday  THEN 1
           WHEN r.observed_at - LAG(r.observed_at) OVER w
                  > (SELECT gap FROM bounds)                       THEN 1
           ELSE 0
         END AS starts_session
    FROM est_rows r
  WINDOW w AS (PARTITION BY r.source, r.transition ORDER BY r.observed_at, r.id)
),
est_sessions AS (
  SELECT m.*,
         SUM(m.starts_session) OVER (
           PARTITION BY m.source, m.transition ORDER BY m.observed_at, m.id
           ROWS UNBOUNDED PRECEDING
         ) AS sid
    FROM est_marked m
),
estado AS (
  SELECT 'estado'                                   AS kind,
         s.source                                   AS source,
         MIN(s.observed_at)                         AS t,
         MAX(s.observed_at)                         AS t_end,
         'ok'                                       AS raw_status,
         s.transition                               AS note,
         ARRAY[]::text[]                            AS codes,
         'estado:' || MIN(s.id)::text               AS id,
         '/admin/fuentes/' || s.source              AS detail_href,
         COUNT(*)                                   AS rolled_up,
         jsonb_build_object(
           'rows',         COUNT(*),
           'withEvidence', COUNT(*) FILTER (WHERE s.has_evidence)
         )                                          AS counts
    FROM est_sessions s
   GROUP BY s.source, s.transition, s.sid
),

-- ── bloqueo: capture block/challenge episodes (#637) ────────────────────
-- This is the section #642 P2's disposition table would otherwise have
-- deleted along with /etl/salud without naming it. It has a home now.
bloqueo AS (
  SELECT 'bloqueo'                                  AS kind,
         e.portal                                   AS source,
         e.detected_at                              AS t,
         NULL::timestamptz                          AS t_end,
         'blocked'                                  AS raw_status,
         NULL::text                                 AS note,
         ARRAY[e.signature]                         AS codes,
         'bloqueo:' || e.id::text                   AS id,
         '/admin/fuentes/' || e.portal              AS detail_href,
         1::bigint                                  AS rolled_up,
         jsonb_build_object('rows', 1)              AS counts
    FROM extension_block_episode e
   CROSS JOIN bounds b
   WHERE e.detected_at >= b.lo AND e.detected_at < b.hi
)

SELECT * FROM (
  SELECT * FROM crawl
  UNION ALL SELECT * FROM sweep
  UNION ALL SELECT * FROM captura
  UNION ALL SELECT * FROM recola
  UNION ALL SELECT * FROM dedup
  UNION ALL SELECT * FROM manual
  UNION ALL SELECT * FROM estado
  UNION ALL SELECT * FROM bloqueo
) merged
ORDER BY t DESC, id DESC
LIMIT ${MAX_EVENTS + 1}
`;

/**
 * The newest event strictly BEFORE a given Madrid day, as a day key — the
 * "load older" cursor. Returns null only when nothing at all precedes the
 * window, which is what lets the UI say "no hay más actividad" instead of
 * offering a button that loads nothing.
 */
const PREV_DAY_SQL = `
WITH lo AS (SELECT ($1::date)::timestamp AT TIME ZONE 'Europe/Madrid' AS ts),
     t AS (
  SELECT MAX(x) AS newest FROM (
    SELECT MAX(COALESCE(rr.started_at, cr.started_at)) AS x
      FROM connector_run_results rr JOIN connector_runs cr ON cr.id = rr.run_id
     WHERE COALESCE(rr.started_at, cr.started_at) < (SELECT ts FROM lo)
    UNION ALL SELECT MAX(started_at)   FROM connector_runs          WHERE started_at   < (SELECT ts FROM lo)
    UNION ALL SELECT MAX(created_at)   FROM extension_capture       WHERE created_at   < (SELECT ts FROM lo)
    UNION ALL SELECT MAX(requeued_at)  FROM capture_worklist        WHERE requeued_at  < (SELECT ts FROM lo)
    UNION ALL SELECT MAX(started_at)   FROM dedup_runs              WHERE started_at   < (SELECT ts FROM lo)
    UNION ALL SELECT MAX(requested_at) FROM etl_manual_trigger      WHERE requested_at < (SELECT ts FROM lo)
    UNION ALL SELECT MAX(observed_at)  FROM listing_status_event    WHERE observed_at  < (SELECT ts FROM lo)
    UNION ALL SELECT MAX(detected_at)  FROM extension_block_episode WHERE detected_at  < (SELECT ts FROM lo)
  ) u(x)
)
SELECT to_char((newest AT TIME ZONE 'Europe/Madrid')::date, 'YYYY-MM-DD') AS day FROM t
`;

// ─── raw → ActivityEvent ─────────────────────────────────────────────────

/** `bigint` columns arrive as numbers via the driver's int8 parser (#155),
 *  but `jsonb_build_object` renders them as JSON numbers OR strings
 *  depending on width, so normalise defensively. */
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normaliseCounts(raw: RawRow["counts"]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(raw ?? {})) out[k] = num(v);
  return out;
}

/**
 * Per-kind status mapping. Every branch is explicit — an unmapped raw status
 * must not silently become "ok", which would report a state nobody has
 * looked at as healthy.
 */
export function mapStatus(
  kind: ActivityKind,
  raw: string | null,
  finished: boolean,
): ActivityStatus {
  switch (kind) {
    case "crawl":
      if (raw === "failed") return "error";
      if (raw === "circuit_open") return "aviso";
      if (raw === "skipped") return "omitido";
      if (raw === "ok") return finished ? "ok" : "curso";
      return "aviso";
    case "sweep":
      if (raw === "failed") return "error";
      if (raw === "partial") return "aviso";
      if (raw === "running") return "curso";
      if (raw === "success") return "ok";
      return "aviso";
    case "captura":
      if (raw === "pending") return "curso";
      if (raw === "empty") return "error";
      if (raw === "partial") return "aviso";
      return "ok";
    case "dedup":
      if (raw === "failed") return "error";
      if (raw === "running") return "curso";
      if (raw === "success") return "ok";
      return "aviso";
    case "manual":
      if (raw === "failed") return "error";
      if (raw === "done") return "ok";
      return "curso";
    case "bloqueo":
      return "error";
    case "recola":
    case "estado":
      return "ok";
  }
}

function toEvent(r: RawRow): ActivityEvent {
  const kind = r.kind as ActivityKind;
  const codes = r.codes ?? [];
  let status = mapStatus(kind, r.raw_status, r.t_end !== null);
  // A crawl whose mass-withdrawal guard fired stores status='ok' and
  // verified_gone_count=0 — byte-identical to a run where every listing came
  // back alive (init.sql's own note on that column). It is not "ok": ten
  // listings were found gone and deliberately not withdrawn because it looked
  // like our bug. Raise it to `aviso` so the row does not read healthy.
  if (kind === "crawl" && status === "ok" && codes.length > 0) status = "aviso";
  return {
    id: r.id,
    kind,
    source: r.source,
    t: r.t.toISOString(),
    tEnd: r.t_end ? r.t_end.toISOString() : null,
    status,
    counts: normaliseCounts(r.counts),
    note: r.note,
    codes,
    detailHref: r.detail_href,
    rolledUp: num(r.rolled_up) ?? 1,
  };
}

export interface ActivityWindow {
  /** Inclusive, `YYYY-MM-DD` Madrid. */
  fromDay: string;
  /** Exclusive, `YYYY-MM-DD` Madrid. */
  toDayExclusive: string;
}

/**
 * Every ingest event in `[fromDay, toDayExclusive)`, newest first, already
 * rolled up. Ordering is the DATABASE's (`ORDER BY t DESC`), not a client
 * sort — merge order is a property of the query, which is what makes it
 * testable.
 */
export async function getActivityEvents(
  win: ActivityWindow,
): Promise<{ events: ActivityEvent[]; truncated: boolean }> {
  const rows = await sql<RawRow>(ACTIVITY_SQL, [
    win.fromDay,
    win.toDayExclusive,
    `${SESSION_GAP_MINUTES} minutes`,
  ]);
  // The query asks for MAX_EVENTS + 1 precisely so "there was more" is a
  // fact rather than an inference from a full page.
  const truncated = rows.length > MAX_EVENTS;
  return { events: rows.slice(0, MAX_EVENTS).map(toEvent), truncated };
}

/** The `load older` cursor: the newest day with activity strictly before
 *  `fromDay`, or null when there is none. */
export async function getPreviousActivityDay(fromDay: string): Promise<string | null> {
  const rows = await sql<{ day: string | null }>(PREV_DAY_SQL, [fromDay]);
  return rows[0]?.day ?? null;
}
