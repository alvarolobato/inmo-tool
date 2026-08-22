/**
 * Real-Postgres integration test for the unified ingest chronology
 * (issue #644, `lib/db/activity.ts`).
 *
 * A real database is the only thing that can prove this module: the whole
 * point of it is ONE `UNION ALL` across eight tables with two window-function
 * rollups (capture sessions, status-change runs) and Madrid-local day
 * bucketing. A mocked `sql()` would assert the string we wrote, not the
 * merge order, not the session split, and not the DST-safe day boundary —
 * i.e. it would test nothing that can actually break.
 *
 * Skips cleanly when no Postgres is reachable; `REQUIRE_DB=1` makes that a
 * hard failure (AGENTS.md / etl/tests/conftest.py's contract, issue #160).
 * The skip is a real `describe.skipIf`, NOT an `if (!dbAvailable) return;`
 * inside each `it()` — Vitest counts an empty body as a PASS, so that idiom
 * reports this file green while asserting nothing, which is precisely the
 * silent-skip regression #160 exists to stop. Under `npm test` the harness
 * points these at a throwaway per-run database (issue #159), so the seeded
 * rows can never collide with anything.
 *
 * Fixed calendar day: **2026-03-05**, deliberately in CET (UTC+1) rather
 * than "today", so the Madrid-local window is a stable, hand-checkable
 * `[2026-03-04T23:00Z, 2026-03-05T23:00Z)` and the day-boundary assertion
 * means something.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { getActivityEvents, getPreviousActivityDay } from "@/lib/db/activity";
import type { ActivityEvent } from "@/lib/activity";

const DAY = "2026-03-05";
const NEXT = "2026-03-06";
const WINDOW = { fromDay: DAY, toDayExclusive: NEXT };

/** Marker every seeded row carries so cleanup can find it. */
const TAG = "e2e644";

let pool: Pool;

const REQUIRE_DB = process.env.REQUIRE_DB === "1";

/**
 * Probed at module scope (not in `beforeAll`) because `describe.skipIf` is
 * evaluated at collection time, before any hook has run.
 */
const dbAvailable = await (async () => {
  const probe = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await probe.query("SELECT 1");
    return true;
  } catch (err) {
    if (REQUIRE_DB) {
      throw new Error(
        "REQUIRE_DB=1 but Postgres is unreachable for activity.integration.test.ts: " +
          String(err),
      );
    }
    // eslint-disable-next-line no-console
    console.warn("[activity.integration.test] no reachable Postgres — skipping.");
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
})();
const seededListingIds: number[] = [];
const seededPropertyIds: number[] = [];

async function seed(): Promise<void> {
  // ── crawl: one sweep with two connector outcomes ────────────────────
  const run = await pool.query<{ id: number }>(
    `INSERT INTO connector_runs (trigger, started_at, finished_at, duration_ms, status,
                                 connectors_ok, connectors_failed, total_connectors)
     VALUES ('scheduler', '2026-03-05T08:00:00Z', '2026-03-05T09:00:00Z', 3600000,
             'success', 2, 0, 2)
     RETURNING id`,
  );
  const runId = run.rows[0].id;
  await pool.query(
    `INSERT INTO connector_run_results
       (run_id, connector_name, started_at, finished_at, status,
        discovered_count, fetched_count, error_count, skipped_unchanged_count,
        verified_count, verified_gone_count, verification_alarm, fetch_ms_total)
     VALUES
       ($1, '${TAG}_fotocasa', '2026-03-05T08:00:00Z', '2026-03-05T08:30:00Z', 'ok',
        179, 10, 0, 169, 10, 4, NULL, 4038),
       ($1, '${TAG}_habitaclia', '2026-03-05T08:30:00Z', '2026-03-05T09:00:00Z', 'ok',
        15, 4, 11, 0, 0, 0, NULL, 0),
       ($1, '${TAG}_pisos', '2026-03-05T08:45:00Z', '2026-03-05T08:50:00Z', 'ok',
        66, 50, 0, 16, 10, 0, 'ratio 8/10 >= 80%', 0)`,
    [runId],
  );

  // ── sweep: a run that recorded NO per-connector outcome (D-009 guard) ─
  await pool.query(
    `INSERT INTO connector_runs (trigger, started_at, finished_at, duration_ms, status,
                                 connectors_ok, connectors_failed, connectors_skipped,
                                 total_connectors)
     VALUES ('scheduler', '2026-03-05T07:00:00Z', '2026-03-05T07:00:00Z', 3,
             'success', 0, 0, 0, 0)`,
  );

  // ── captura: 15 rows inside one 30-min-gap session, then a 31-minute
  //    gap, then 2 more (a second session). Plus one row past Madrid
  //    midnight, which must NOT join the last session of this day.
  const capValues: string[] = [];
  for (let i = 0; i < 15; i++) {
    // 10:00Z + i*5min → 70 minutes of continuous activity, every gap 5 min.
    const ts = new Date(Date.UTC(2026, 2, 5, 10, i * 5, 0)).toISOString();
    capValues.push(`('https://x/${TAG}/a${i}', '${TAG}_idealista', 'done', '${ts}', 1500, 200)`);
  }
  // Last of the first session is 11:10Z. +31 min = 11:41Z opens a new one.
  capValues.push(`('https://x/${TAG}/b0', '${TAG}_idealista', 'done', '2026-03-05T11:41:00Z', 1500, 200)`);
  capValues.push(`('https://x/${TAG}/b1', '${TAG}_idealista', 'failed', '2026-03-05T11:45:00Z', NULL, NULL)`);
  // 23:30Z is 00:30 the NEXT day in Madrid (CET) — outside this window.
  capValues.push(`('https://x/${TAG}/c0', '${TAG}_idealista', 'done', '2026-03-05T23:30:00Z', 1500, 200)`);
  await pool.query(
    `INSERT INTO extension_capture (url, connector_name, status, created_at, render_wait_ms, processing_ms)
     VALUES ${capValues.join(",")}`,
  );

  // ── recola: a re-capture batch (D-156) ──────────────────────────────
  await pool.query(
    `INSERT INTO capture_worklist (url, match_key, source_portal, status, added_via,
                                   requeued_at, requeue_reason)
     VALUES
       ('https://x/${TAG}/r0', '${TAG}:r0', '${TAG}_idealista', 'pending', 'derived',
        '2026-03-05T06:00:00Z', 'Parser fix #678'),
       ('https://x/${TAG}/r1', '${TAG}:r1', '${TAG}_idealista', 'pending', 'derived',
        '2026-03-05T06:00:00Z', 'Parser fix #678')`,
  );

  // ── dedup ────────────────────────────────────────────────────────────
  await pool.query(
    `INSERT INTO dedup_runs (trigger, started_at, finished_at, duration_ms, status,
                             pairs_compared, merged, suggested, conflicts)
     VALUES ('scheduler', '2026-03-05T12:00:00Z', '2026-03-05T12:30:00Z', 1800000,
             'success', 1000, 3, 5, 1)`,
  );

  // ── manual trigger ───────────────────────────────────────────────────
  await pool.query(
    `INSERT INTO etl_manual_trigger (requested_at, status, finished_at, triggered_by)
     VALUES ('2026-03-05T13:00:00Z', 'done', '2026-03-05T13:05:00Z', '${TAG}')`,
  );

  // ── estado: two withdrawals (one with evidence) + one resurrection ───
  for (let i = 0; i < 2; i++) {
    const prop = await pool.query<{ id: number }>(`INSERT INTO property DEFAULT VALUES RETURNING id`);
    seededPropertyIds.push(prop.rows[0].id);
    const listing = await pool.query<{ id: number }>(
      `INSERT INTO listing (property_id, source, external_id)
       VALUES ($1, '${TAG}_fotocasa', $2) RETURNING id`,
      [prop.rows[0].id, `${TAG}-${i}`],
    );
    seededListingIds.push(listing.rows[0].id);
  }
  await pool.query(
    `INSERT INTO listing_status_event (listing_id, observed_at, status, evidence)
     VALUES ($1, '2026-03-05T14:00:00Z', 'withdrawn', 'HTTP 404'),
            ($2, '2026-03-05T14:05:00Z', 'withdrawn', NULL),
            -- The resurrection: an 'active' event AFTER a non-active one on
            -- the same listing. A first-sighting 'active' (which this is not)
            -- must stay out of the feed entirely.
            ($1, '2026-03-05T15:00:00Z', 'active', NULL),
            -- A pure first sighting on the OTHER listing's timeline would be
            -- noise; seed one earlier than its withdrawal to prove it is
            -- excluded rather than merely absent.
            ($2, '2026-03-05T13:30:00Z', 'active', NULL)`,
    [seededListingIds[0], seededListingIds[1]],
  );

  // ── bloqueo: a capture block episode (#637) ─────────────────────────
  await pool.query(
    `INSERT INTO extension_block_episode (portal, signature, detected_at)
     VALUES ('${TAG}_idealista', 'datadome', '2026-03-05T16:00:00Z')`,
  );
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM extension_block_episode WHERE portal LIKE '${TAG}%'`);
  await pool.query(`DELETE FROM capture_worklist WHERE match_key LIKE '${TAG}%'`);
  await pool.query(`DELETE FROM extension_capture WHERE url LIKE 'https://x/${TAG}/%'`);
  await pool.query(`DELETE FROM etl_manual_trigger WHERE triggered_by = '${TAG}'`);
  if (seededListingIds.length) {
    await pool.query(`DELETE FROM listing_status_event WHERE listing_id = ANY($1)`, [seededListingIds]);
    await pool.query(`DELETE FROM listing WHERE id = ANY($1)`, [seededListingIds]);
  }
  if (seededPropertyIds.length) {
    await pool.query(`DELETE FROM property WHERE id = ANY($1)`, [seededPropertyIds]);
  }
  await pool.query(
    `DELETE FROM connector_runs WHERE started_at >= '2026-03-05T00:00:00Z'
        AND started_at < '2026-03-06T00:00:00Z'`,
  );
  await pool.query(
    `DELETE FROM dedup_runs WHERE started_at >= '2026-03-05T00:00:00Z'
        AND started_at < '2026-03-06T00:00:00Z'`,
  );
}

beforeAll(async () => {
  if (!dbAvailable) return;
  pool = new Pool(buildPgPoolConfig({ max: 2 }));
  await cleanup();
  await seed();
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool?.end().catch(() => {});
});

function only(events: ActivityEvent[], kind: string): ActivityEvent[] {
  return events.filter((e) => e.kind === kind);
}

describe.skipIf(!dbAvailable)("getActivityEvents — the merged ingest ledger", () => {
  it("merged timeline: crawl, capture, dedup and manual events come back in one time-ordered stream (EC-1)", async () => {
    const { events, truncated } = await getActivityEvents(WINDOW);
    expect(truncated).toBe(false);

    // Ordering is the DATABASE's, and it is strictly newest-first.
    const times = events.map((e) => e.t);
    expect([...times].sort().reverse()).toEqual(times);

    // All four kinds the issue names are present, from four different tables.
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has("crawl")).toBe(true);
    expect(kinds.has("captura")).toBe(true);
    expect(kinds.has("dedup")).toBe(true);
    expect(kinds.has("manual")).toBe(true);

    // The crawl row carries the counts that matter, straight off
    // connector_run_results — including the D-157 verification pair.
    const fotocasa = events.find((e) => e.kind === "crawl" && e.source === `${TAG}_fotocasa`);
    expect(fotocasa).toBeDefined();
    expect(fotocasa!.counts).toMatchObject({
      discovered: 179,
      fetched: 10,
      unchanged: 169,
      verified: 10,
      gone: 4,
      fetchMsTotal: 4038,
    });
    expect(fotocasa!.status).toBe("ok");
    expect(fotocasa!.detailHref).toMatch(/^\/etl\/\d+$/);

    // The mass-withdrawal guard fired on pisos: status='ok',
    // verified_gone_count=0 — indistinguishable from a clean run in the
    // stored columns. The feed must NOT report it as ok.
    const pisos = events.find((e) => e.kind === "crawl" && e.source === `${TAG}_pisos`);
    expect(pisos!.codes).toEqual(["ratio 8/10 >= 80%"]);
    expect(pisos!.status).toBe("aviso");

    // D-162 rule 2: a 0 in the timing column means "not measured" and must
    // arrive as null, never as a 0 that reads "instant".
    // No failure and no suppressed withdrawal — the code strip is empty, not
    // a `[null]` the client has to defend against.
    expect(fotocasa!.codes).toEqual([]);

    const habitaclia = events.find((e) => e.kind === "crawl" && e.source === `${TAG}_habitaclia`);
    expect(habitaclia!.counts.fetchMsTotal).toBeNull();
    // ...and so must a 0 verification count, which means "did not verify".
    expect(habitaclia!.counts.verified).toBeNull();

    // Pinned by their own seeded values rather than by position: vitest runs
    // test FILES in parallel against the one throwaway database, so "the
    // first dedup row in the window" is not a stable identity.
    const dedup = only(events, "dedup").find((e) => e.counts.pairs === 1000);
    expect(dedup).toBeDefined();
    expect(dedup!.counts).toMatchObject({ pairs: 1000, merged: 3, suggested: 5, conflicts: 1 });

    const manual = only(events, "manual").find((e) => e.note === TAG);
    expect(manual).toBeDefined();
    expect(manual!.status).toBe("ok");
    expect(manual!.counts.durationMs).toBe(300000);
  });

  it("session grouping: 15 captures within 30-min gaps collapse into one row; a 31-min gap splits a second (EC-2)", async () => {
    const { events } = await getActivityEvents(WINDOW);
    const sessions = only(events, "captura").filter((e) => e.source === `${TAG}_idealista`);

    // Exactly two sessions in this Madrid day. The 23:30Z capture is
    // 00:30 the NEXT Madrid day and must not appear at all.
    expect(sessions.length).toBe(2);

    const [second, first] = sessions; // newest-first
    expect(first.rolledUp).toBe(15);
    expect(first.counts.total).toBe(15);
    expect(first.counts.done).toBe(15);
    expect(first.t).toBe("2026-03-05T10:00:00.000Z");
    expect(first.tEnd).toBe("2026-03-05T11:10:00.000Z");
    // #695/D-162: the render-wait median is only claimed for rows that
    // carry one, and `timed` is its honest denominator.
    expect(first.counts.timed).toBe(15);
    expect(first.counts.renderWaitMsP50).toBe(1500);

    expect(second.rolledUp).toBe(2);
    expect(second.t).toBe("2026-03-05T11:41:00.000Z");
    expect(second.counts.failed).toBe(1);
    expect(second.counts.anomalous).toBe(1);
    // One row of two carries timing; the median is over that row only.
    expect(second.counts.timed).toBe(1);
    // A partly-failed session is an aviso, never a flat "error".
    expect(second.status).toBe("aviso");
  });

  it("the 23:30Z capture lands on the NEXT Madrid day, not this one", async () => {
    const { events } = await getActivityEvents({ fromDay: NEXT, toDayExclusive: "2026-03-07" });
    const sessions = only(events, "captura").filter((e) => e.source === `${TAG}_idealista`);
    expect(sessions.length).toBe(1);
    expect(sessions[0].t).toBe("2026-03-05T23:30:00.000Z");
  });

  it("a sweep gets a row of its own ONLY when it recorded no per-connector outcome", async () => {
    const { events } = await getActivityEvents(WINDOW);
    const sweeps = only(events, "sweep");
    // The 08:00 run has two result rows, so its connectors speak for it and
    // it must NOT appear as a sweep; the 07:00 run recorded none, and is the
    // "¿por qué esta pasada no produjo nada?" case that must not be invisible.
    expect(sweeps.map((e) => e.t)).toContain("2026-03-05T07:00:00.000Z");
    expect(sweeps.map((e) => e.t)).not.toContain("2026-03-05T08:00:00.000Z");
    const guarded = sweeps.find((e) => e.t === "2026-03-05T07:00:00.000Z")!;
    expect(guarded.counts.connectors).toBe(0);
    expect(guarded.counts.durationMs).toBe(3);
    expect(guarded.source).toBeNull();
  });

  it("status changes group per source and transition, count their evidence, and exclude first sightings", async () => {
    const { events } = await getActivityEvents(WINDOW);
    const estado = only(events, "estado").filter((e) => e.source === `${TAG}_fotocasa`);

    const withdrawn = estado.find((e) => e.note === "withdrawn");
    expect(withdrawn).toBeDefined();
    expect(withdrawn!.rolledUp).toBe(2);
    // D-157: one of the two cites evidence, the other does not — and the
    // feed says so rather than implying both were verified.
    expect(withdrawn!.counts).toMatchObject({ rows: 2, withEvidence: 1 });

    // The 'active' event that FOLLOWS a withdrawal is a resurrection and is
    // kept; the one that precedes any non-active event is a first sighting
    // and is dropped, so there is exactly one reactivated row.
    const reactivated = estado.filter((e) => e.note === "reactivated");
    expect(reactivated.length).toBe(1);
    expect(reactivated[0].counts.rows).toBe(1);
  });

  it("re-capture batches and block episodes are in the same stream", async () => {
    const { events } = await getActivityEvents(WINDOW);

    const recola = only(events, "recola").filter((e) => e.source === `${TAG}_idealista`);
    expect(recola.length).toBe(1);
    expect(recola[0].counts.rows).toBe(2);
    expect(recola[0].codes).toEqual(["Parser fix #678"]);

    // #637's episode history — the section #642 P2's disposition table would
    // otherwise have deleted along with /etl/salud without naming it.
    const bloqueo = only(events, "bloqueo").filter((e) => e.source === `${TAG}_idealista`);
    expect(bloqueo.length).toBe(1);
    expect(bloqueo[0].status).toBe("error");
    expect(bloqueo[0].codes).toEqual(["datadome"]);
  });

  it("getPreviousActivityDay finds the newest day strictly before the window", async () => {
    // Everything seeded is on 2026-03-05 (Madrid), so from 2026-03-06 the
    // previous day with activity is 2026-03-05 itself.
    const prev = await getPreviousActivityDay(NEXT);
    expect(prev).toBe(DAY);
  });
});
