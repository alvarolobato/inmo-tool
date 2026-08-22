/**
 * Queue depth + trend — the SQL half (issue #640, part of #636).
 *
 * Read-only. One `Promise.all` of plain aggregates over the queue tables
 * themselves: every queue here already carries an entry AND an exit timestamp,
 * so "how deep is it, and is it draining?" is pure SQL — **no snapshot table,
 * no new instrumentation** (the issue's own framing). See `lib/queues.ts` for
 * the trend model and the honesty rules; this file only fills it in.
 *
 * ## What is deliberately NOT here
 *
 * The owner's standing complaint on #636 is "solo has añadido, no has
 * eliminado nada… quiero que unifiques". Estado is the cross-cutting glance;
 * the per-source detail already lives on `/admin/fuentes/<name>` (#642 P1,
 * PR #676), which since that PR carries a per-source queue-depth chip of its
 * own. So this module returns ONE global depth per queue plus a link to the
 * surface that owns the breakdown — never a per-portal table, which would be
 * a second copy of the Fuentes list. The single exception is the capture
 * tile's `note`/`href`, which names the dominant portal when exactly one has
 * pending rows: that is a pointer INTO Fuentes (one tap to the failing
 * source, #642 EC-4), not a copy of it.
 *
 * Likewise absent: dedup phase timing (`pair_eval_ms` and friends are not
 * instrumented at all — that is #646, unbuilt, and inventing a number here
 * would be exactly the "looked measured, wasn't" failure this repo hit twice
 * this week), and the run-level counters flagged in #640's comment
 * (`verification_alarm`, `skipped_unchanged_count`) — those are per-source run
 * outcomes, not queues; they belong to #642 P2's Estado-chips task.
 */

import { query } from "@/lib/db";
import {
  DISABLED_SOURCES_CTE,
  assessmentEligibleClause,
  parkGuardParams,
  pendingClause,
  selectionFlowValues,
  ASSESSMENT_SELECTION_FLOWS,
} from "@/lib/ai-assessment/eligibility";
import { STALE_PROFILES_SQL, SWEEP_IN_PROGRESS_SQL } from "@/lib/db/data-health";
import {
  QUEUE_WINDOW_HOURS,
  deriveTrend,
  drainEtaHours,
  sortQueues,
  type QueueSeverity,
  type QueueTile,
  type QueuesResponse,
} from "@/lib/queues";

/** Coerce a pg count (number | numeric-string | null) to a number, 0 on null. */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Age in hours of a pg timestamp, or null when absent. */
function ageHours(v: unknown, now: number): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 3_600_000);
}

/** "hace 3 h" / "hace 12 d" / "nunca" — the same shape lib/source-health uses. */
function agoText(h: number | null): string {
  if (h === null) return "nunca";
  if (h < 1) return `hace ${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `hace ${Math.round(h)} h`;
  return `hace ${Math.round(h / 24)} d`;
}

/**
 * A queue that is drained by a poll loop rather than by a human is expected to
 * sit at ~0: `run_capture_poll_loop` and the manual-trigger poll both tick
 * every 10s, so a row waiting longer than this means the CONSUMER is down, not
 * that the queue is busy. D-162 makes the same point in the opposite
 * direction — never read that ~5s wait as portal slowness.
 */
const POLLED_QUEUE_STUCK_MINUTES = 15;

/**
 * Dedup-pass thresholds. The pass is scheduler-driven after each connector
 * sweep (~hourly), so 12h with no success is unambiguously broken (#614: 12
 * orphan-guard kills in 7d with the last success 20h+ old, and nothing
 * surfaced it).
 */
const DEDUP_SUCCESS_ALARM_HOURS = 12;
const DEDUP_SUCCESS_WARN_HOURS = 6;

export async function getQueues(): Promise<QueuesResponse> {
  const w = QUEUE_WINDOW_HOURS;

  // Assessment backlog: built from the SCHEDULER's OWN predicate fragments
  // (lib/ai-assessment/eligibility.ts), never a re-derivation — #330 is the
  // incident where the cost panel's looser rule disagreed with what the
  // scheduler actually assesses, and #640's constraints call this out by name.
  const flows = selectionFlowValues(1);
  const guard = parkGuardParams(1 + flows.params.length);
  const backlogSql = `WITH ${DISABLED_SOURCES_CTE},
       eligible AS (
         SELECT p.id, p.created_at
           FROM property p
          WHERE ${assessmentEligibleClause("p")}
       ),
       pending AS (
         SELECT e.id, e.created_at
           FROM eligible e
          WHERE ${pendingClause("e", flows.valuesSql, guard.maxFailuresParam, guard.decayDaysParam)}
       )
       SELECT (SELECT COUNT(*) FROM pending)          AS depth,
              (SELECT MIN(created_at) FROM pending)   AS oldest`;
  const backlogParams = [...flows.params, ...guard.params];

  const selectionTypes = ASSESSMENT_SELECTION_FLOWS.map((f) => f.type);

  const [
    worklistRes,
    worklistPortalRes,
    mergeRes,
    dedupPassRes,
    captureRes,
    triggerRes,
    backlogRes,
    assessedRes,
    staleRes,
    sweepRes,
  ] = await Promise.all([
    // 1. Capture worklist — the owner's own hand-drained queue (D-156).
    //    `inflow` counts newly-seeded rows PLUS rows requeued back into
    //    `pending`, excluding rows that were BOTH created and requeued inside
    //    the window so nothing is double-counted. `outflow` is any row that
    //    left `pending` in the window (captured / skipped / stale / failed).
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')                       AS depth,
         COUNT(*) FILTER (WHERE created_at > NOW() - make_interval(hours => $1)) AS created_in,
         COUNT(*) FILTER (WHERE requeued_at > NOW() - make_interval(hours => $1)
                            AND created_at <= NOW() - make_interval(hours => $1)) AS requeued_in,
         COUNT(*) FILTER (WHERE status <> 'pending'
                            AND updated_at > NOW() - make_interval(hours => $1)) AS left_queue,
         MIN(created_at) FILTER (WHERE status = 'pending')                AS oldest
         FROM capture_worklist`,
      [w],
    ),

    // 2. Which portal owns the pending rows. Two rows are enough to answer
    //    "is this one portal's backlog or everyone's?" — the full per-portal
    //    breakdown stays on /admin/fuentes (PR #676), never duplicated here.
    query(
      `SELECT source_portal, COUNT(*) AS n
         FROM capture_worklist
        WHERE status = 'pending'
        GROUP BY source_portal
        ORDER BY n DESC, source_portal
        LIMIT 2`,
    ),

    // 3. Dedup REVIEW backlog. D-024: a `pending` row is re-evaluated every
    //    run but keeps its original created_at, so entry/exit stay honest.
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')                        AS depth,
         COUNT(*) FILTER (WHERE created_at > NOW() - make_interval(hours => $1))  AS inflow,
         COUNT(*) FILTER (WHERE resolved_at > NOW() - make_interval(hours => $1)) AS outflow,
         MIN(created_at) FILTER (WHERE status = 'pending')                 AS oldest
         FROM suggested_merge`,
      [w],
    ),

    // 4. Dedup PASS state — not a depth at all, a liveness signal. An
    //    orphan kill is D-036's age-based reconciliation writing status
    //    'failed' with an `error_msg` that starts 'orphaned:'
    //    (orchestrator._reconcile_orphaned_dedup_runs); matching on that
    //    prefix is how #614's silent stall becomes visible.
    query(
      `SELECT
         MAX(finished_at) FILTER (WHERE status = 'success')                AS last_success,
         COUNT(*) FILTER (WHERE status = 'running')                        AS running,
         MIN(started_at) FILTER (WHERE status = 'running')                 AS running_since,
         COUNT(*) FILTER (WHERE status = 'failed'
                            AND error_msg LIKE 'orphaned:%'
                            AND started_at > NOW() - INTERVAL '7 days')    AS orphan_7d,
         COUNT(*) FILTER (WHERE status = 'failed'
                            AND started_at > NOW() - INTERVAL '7 days')    AS failed_7d,
         COUNT(*)                                                          AS total
         FROM dedup_runs`,
    ),

    // 5. Extension captures awaiting the ETL poll loop.
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')                          AS depth,
         COUNT(*) FILTER (WHERE created_at > NOW() - make_interval(hours => $1))   AS inflow,
         COUNT(*) FILTER (WHERE processed_at > NOW() - make_interval(hours => $1)) AS outflow,
         MIN(created_at) FILTER (WHERE status = 'pending')                   AS oldest
         FROM extension_capture`,
      [w],
    ),

    // 6. Manual triggers ("Ejecutar ahora"). A row leaves `pending` when the
    //    poll loop claims it and stamps picked_up_at (etl/manual_trigger.py).
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')                            AS depth,
         COUNT(*) FILTER (WHERE requested_at > NOW() - make_interval(hours => $1))  AS inflow,
         COUNT(*) FILTER (WHERE picked_up_at > NOW() - make_interval(hours => $1))  AS outflow,
         MIN(requested_at) FILTER (WHERE status = 'pending')                   AS oldest
         FROM etl_manual_trigger`,
      [w],
    ),

    // 7. AI-assessment backlog, on the scheduler's own eligibility predicate.
    query(backlogSql, backlogParams),

    // 8. Assessment OUTflow: distinct properties that received a verdict for
    //    a SELECTION flow in the window (`generated_at`, the same column
    //    lib/db/llm-health.ts counts throughput on). There is no matching
    //    INflow timestamp anywhere — nothing stamps "this property became
    //    profile-matched" — so the tile reports `inflow24h: null` and the
    //    trend degrades to `working` rather than claiming a direction.
    query(
      `SELECT COUNT(DISTINCT property_id) AS assessed
         FROM ai_assessment
        WHERE generated_at > NOW() - make_interval(hours => $1)
          AND assessment_type = ANY($2)`,
      [w, selectionTypes],
    ),

    // 9. Profiles whose materialization is behind the newest listing data —
    //    /etl/salud's "Perfiles sin re-materializar" section, which #642's
    //    disposition table sends to Estado. Same SQL as the page, imported
    //    from lib/db/data-health.ts rather than restated.
    query(STALE_PROFILES_SQL),
    query(SWEEP_IN_PROGRESS_SQL),
  ]);

  const now = Date.now();
  const tiles: QueueTile[] = [];

  // ── Captura (capture_worklist) ────────────────────────────────────────────
  {
    const r = worklistRes.rows[0] ?? [];
    const depth = num(r[0]);
    const inflow = num(r[1]) + num(r[2]);
    const outflow = num(r[3]);
    const oldest = ageHours(r[4], now);
    const trend = deriveTrend(depth, inflow, outflow);
    const portals = worklistPortalRes.rows.map((row) => String(row[0]));
    const single = depth > 0 && portals.length === 1 ? portals[0] : null;
    tiles.push({
      key: "captura",
      label: "Captura pendiente",
      depth,
      headline: null,
      inflow24h: inflow,
      outflow24h: outflow,
      oldestAgeHours: oldest,
      trend,
      // NEVER `alarm`. This queue is drained by the owner, by hand, at his own
      // pace — the exact case #638's addendum protects: "a bursty,
      // operator-paced source must never read as failure from elapsed time
      // alone". A backlog that is growing or frozen is worth an amber nudge;
      // a deep backlog that is draining is just work in progress.
      severity: trend === "growing" || trend === "stalled" ? "warn" : "ok",
      note: single ?? (depth > 0 ? `${portals.length}+ portales` : null),
      unmeasured: null,
      href: single ? `/admin/fuentes/${encodeURIComponent(single)}` : "/admin/fuentes",
      etaHours: drainEtaHours(depth, outflow),
    });
  }

  // ── Revisión de dedup (suggested_merge) ───────────────────────────────────
  {
    const r = mergeRes.rows[0] ?? [];
    const depth = num(r[0]);
    const inflow = num(r[1]);
    const outflow = num(r[2]);
    const oldest = ageHours(r[3], now);
    const trend = deriveTrend(depth, inflow, outflow);
    tiles.push({
      key: "dedup_review",
      label: "Revisión de dedup",
      depth,
      headline: null,
      inflow24h: inflow,
      outflow24h: outflow,
      oldestAgeHours: oldest,
      trend,
      // Also owner-paced (he confirms/rejects pairs by hand), so same rule as
      // captura: amber at worst, never red.
      severity: trend === "growing" || trend === "stalled" ? "warn" : "ok",
      note: null,
      unmeasured: null,
      href: "/admin/dedup",
      etaHours: drainEtaHours(depth, outflow),
    });
  }

  // ── Pase de dedup (dedup_runs) ────────────────────────────────────────────
  {
    const r = dedupPassRes.rows[0] ?? [];
    const lastSuccessH = ageHours(r[0], now);
    const running = num(r[1]);
    const runningSinceH = ageHours(r[2], now);
    const orphan7d = num(r[3]);
    const failed7d = num(r[4]);
    // Zero rows means the pass has never been ATTEMPTED — a fresh install, not
    // a stall. D-069 (green unless genuinely broken) applies: report "sin
    // ejecuciones" and stay neutral rather than opening on a red tile nobody
    // can act on. Once even one run exists, "no success in 12h" is real.
    const everRan = num(r[5]) > 0;

    let severity: QueueSeverity = "ok";
    if (!everRan) severity = "ok";
    else if (lastSuccessH === null || lastSuccessH > DEDUP_SUCCESS_ALARM_HOURS) severity = "alarm";
    else if (lastSuccessH > DEDUP_SUCCESS_WARN_HOURS || orphan7d > 0) severity = "warn";

    const noteParts: string[] = [];
    if (running > 0) noteParts.push(`en curso ${agoText(runningSinceH)}`);
    if (orphan7d > 0)
      noteParts.push(`${orphan7d} ${orphan7d === 1 ? "muerto" : "muertos"}/7 d`);
    else if (failed7d > 0)
      noteParts.push(`${failed7d} ${failed7d === 1 ? "fallo" : "fallos"}/7 d`);

    tiles.push({
      key: "dedup_pass",
      label: "Pase de dedup",
      // Not a queue depth at all: the number that matters is how long since
      // the pass last SUCCEEDED, so `depth` stays null and `headline` carries
      // the age. #614's stall was invisible precisely because no surface
      // showed this.
      depth: null,
      headline: everRan ? `último OK ${agoText(lastSuccessH)}` : "sin ejecuciones",
      inflow24h: null,
      outflow24h: null,
      oldestAgeHours: lastSuccessH,
      trend: "unknown",
      severity,
      note: noteParts.length > 0 ? noteParts.join(" · ") : null,
      unmeasured: null,
      href: null,
      etaHours: null,
    });
  }

  // ── Evaluación IA (ai_assessment backlog) ─────────────────────────────────
  {
    const depth = num(backlogRes.rows[0]?.[0]);
    const oldest = ageHours(backlogRes.rows[0]?.[1], now);
    const outflow = num(assessedRes.rows[0]?.[0]);
    // inflow is genuinely unmeasurable — see query 8's comment.
    const trend = deriveTrend(depth, null, outflow);
    tiles.push({
      key: "evaluacion_ia",
      label: "Evaluación IA",
      depth,
      headline: null,
      inflow24h: null,
      outflow24h: outflow,
      oldestAgeHours: oldest,
      trend,
      // A backlog with zero throughput is the D-104 park / budget-stop /
      // open-breaker case, and it is invisible everywhere else today.
      severity: trend === "stalled" ? "warn" : "ok",
      // No note: the trend line already renders the −N throughput, and the
      // ETA next to it is what turns that into an answer.
      note: null,
      unmeasured: null,
      href: "/admin/llm",
      etaHours: drainEtaHours(depth, outflow),
    });
  }

  // ── Capturas sin procesar (extension_capture) ─────────────────────────────
  {
    const r = captureRes.rows[0] ?? [];
    const depth = num(r[0]);
    const inflow = num(r[1]);
    const outflow = num(r[2]);
    const oldest = ageHours(r[3], now);
    const stuck = oldest !== null && oldest * 60 > POLLED_QUEUE_STUCK_MINUTES;
    tiles.push({
      key: "capturas_sin_procesar",
      label: "Capturas sin procesar",
      depth,
      headline: null,
      inflow24h: inflow,
      outflow24h: outflow,
      oldestAgeHours: oldest,
      trend: deriveTrend(depth, inflow, outflow),
      // Depth alone says nothing here: the poll loop ticks every 10s, so a
      // non-zero depth is normal in-flight work (D-162). AGE is the signal —
      // anything older than a few minutes means the ETL consumer is down.
      severity: stuck ? "alarm" : "ok",
      note: stuck ? "el ETL no las procesa" : null,
      unmeasured: null,
      href: "/admin/fuentes",
      etaHours: null,
    });
  }

  // ── Triggers pendientes (etl_manual_trigger) ──────────────────────────────
  {
    const r = triggerRes.rows[0] ?? [];
    const depth = num(r[0]);
    const inflow = num(r[1]);
    const outflow = num(r[2]);
    const oldest = ageHours(r[3], now);
    const stuck = oldest !== null && oldest * 60 > POLLED_QUEUE_STUCK_MINUTES;
    tiles.push({
      key: "triggers",
      label: "Triggers pendientes",
      depth,
      headline: null,
      inflow24h: inflow,
      outflow24h: outflow,
      oldestAgeHours: oldest,
      trend: deriveTrend(depth, inflow, outflow),
      // Same shape as the capture queue above: polled, so age not depth.
      severity: stuck ? "alarm" : "ok",
      note: stuck ? "el ETL no los recoge" : null,
      unmeasured: null,
      href: "/admin/fuentes",
      etaHours: null,
    });
  }

  // ── Perfiles por re-materializar ──────────────────────────────────────────
  {
    const sweeping = sweepRes.rows[0]?.[0] === true || sweepRes.rows[0]?.[0] === "t";
    const depth = sweeping ? null : staleRes.rows.length;
    const oldest = sweeping ? null : ageHours(staleRes.rows[0]?.[2], now);
    tiles.push({
      key: "perfiles_materializar",
      label: "Perfiles por re-materializar",
      depth,
      headline: null,
      inflow24h: null,
      // The reconciler re-materializes on its own schedule and stamps
      // `search_profile.last_materialized_at`, but a profile that was never
      // stale never appears here, so a "left the queue" count is not
      // derivable from this query. Left unmeasured rather than guessed.
      outflow24h: null,
      oldestAgeHours: oldest,
      // deriveTrend with both flows unmeasured: `empty` at zero, `unknown`
      // otherwise — never a direction this query cannot support.
      trend: deriveTrend(depth, null, null),
      severity: !sweeping && (depth ?? 0) > 0 ? "warn" : "ok",
      note: null,
      // #285: mid-sweep, last_seen_at outruns last_materialized_at for nearly
      // every profile, so the check is not evaluable — say that, don't show 0.
      unmeasured: sweeping ? "sweep en curso" : null,
      href: "/profiles",
      etaHours: null,
    });
  }

  return {
    queues: sortQueues(tiles),
    generatedAt: new Date(now).toISOString(),
    ok: true,
  };
}
