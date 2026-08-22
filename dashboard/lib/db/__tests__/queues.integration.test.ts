/**
 * Real-Postgres integration test for the Estado queue band (issue #640).
 *
 * A mocked `query` proves nothing here: what needs proving is that hand-written
 * aggregates over six different queue tables actually run and actually count
 * the right rows — including the two subtleties this surface exists for:
 *
 *   1. **A requeue is an ARRIVAL** (D-156). `capture_worklist` rows come back
 *      to `pending` via `requeued_at`, and a trend that only counted
 *      `created_at` would report a re-capture cohort as free.
 *   2. **A stalled dedup PASS is red** (EC-2). #614's stall — 12 orphan-guard
 *      kills in 7d with the last success 20h+ old — was invisible on every
 *      surface. It is a `dedup_runs` row at status 'failed' whose `error_msg`
 *      starts 'orphaned:' (orchestrator._reconcile_orphaned_dedup_runs); this
 *      pins the prefix match and the 12h red threshold together.
 *
 * ## How these assertions survive a shared database
 *
 * `getQueues()` returns GLOBAL depths, so a test that asserted absolute
 * numbers would pass on `npm test`'s throwaway per-run database (issue #159)
 * and fail the moment someone pointed POSTGRES_DSN at the local demo stack.
 * Every count assertion here is therefore a **delta** against a baseline read
 * taken before seeding. The two assertions that cannot be expressed as a delta
 * (the dedup pass is a MAX over the whole table; "young pending capture is
 * still green" is falsified by any pre-existing old row) are individually
 * gated on the precondition they need, with a warn, rather than silently
 * asserting something the data cannot support.
 *
 * Skips cleanly when no database is reachable; REQUIRE_DB=1 makes that a hard
 * failure (AGENTS.md / etl/tests/conftest.py's contract).
 */
import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { getQueues } from "../queues";
import type { QueueTile } from "@/lib/queues";

const PREFIX = "zzz_test_queues_";
const REQUIRE_DB = process.env.REQUIRE_DB === "1";

const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    if (REQUIRE_DB) {
      throw new Error(
        "REQUIRE_DB=1 but Postgres is unreachable for queues.integration.test.ts: " + String(err),
      );
    }
    // eslint-disable-next-line no-console
    console.warn("[queues.integration.test] no reachable Postgres — skipping.");
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const created = {
  worklist: [] as number[],
  merges: [] as number[],
  listings: [] as number[],
  properties: [] as number[],
  dedupRuns: [] as number[],
  captures: [] as number[],
  connectorRuns: [] as number[],
};

let pool: Pool | null = null;
function db(): Pool {
  if (!pool) pool = new Pool(buildPgPoolConfig({ max: 4 }));
  return pool;
}

afterAll(async () => {
  if (!dbAvailable || !pool) return;
  const p = db();
  // Delete by the ids THIS test created — never a `WHERE ... LIKE` sweep,
  // which would also hit real rows on the shared demo database.
  if (created.merges.length)
    await p.query("DELETE FROM suggested_merge WHERE id = ANY($1)", [created.merges]);
  if (created.worklist.length)
    await p.query("DELETE FROM capture_worklist WHERE id = ANY($1)", [created.worklist]);
  if (created.captures.length)
    await p.query("DELETE FROM extension_capture WHERE id = ANY($1)", [created.captures]);
  if (created.dedupRuns.length)
    await p.query("DELETE FROM dedup_runs WHERE id = ANY($1)", [created.dedupRuns]);
  if (created.connectorRuns.length)
    await p.query("DELETE FROM connector_runs WHERE id = ANY($1)", [created.connectorRuns]);
  if (created.listings.length)
    await p.query("DELETE FROM listing WHERE id = ANY($1)", [created.listings]);
  if (created.properties.length)
    await p.query("DELETE FROM property WHERE id = ANY($1)", [created.properties]);
  await p.end();
  pool = null;
});

function tile(queues: QueueTile[], key: string): QueueTile {
  const t = queues.find((q) => q.key === key);
  if (!t) throw new Error(`no queue tile '${key}' in [${queues.map((q) => q.key).join(", ")}]`);
  return t;
}

let seq = 0;
function tag(): string {
  return `${PREFIX}${Date.now()}_${seq++}`;
}

async function seedWorklistRow(opts: {
  status: string;
  createdAgoHours: number;
  updatedAgoHours?: number;
  requeuedAgoHours?: number;
}): Promise<void> {
  const t = tag();
  const { rows } = await db().query(
    `INSERT INTO capture_worklist
        (url, match_key, source_portal, status, created_at, updated_at, requeued_at)
     VALUES ($1, $2, $3, $4,
             NOW() - make_interval(mins => $5),
             NOW() - make_interval(mins => $6),
             CASE WHEN $7::int IS NULL THEN NULL
                  ELSE NOW() - make_interval(mins => $7::int) END)
     RETURNING id`,
    [
      `https://example.invalid/${t}`,
      t,
      `${PREFIX}portal`,
      opts.status,
      Math.round(opts.createdAgoHours * 60),
      Math.round((opts.updatedAgoHours ?? opts.createdAgoHours) * 60),
      opts.requeuedAgoHours === undefined ? null : Math.round(opts.requeuedAgoHours * 60),
    ],
  );
  created.worklist.push(Number(rows[0].id));
}

async function seedListing(): Promise<number> {
  const t = tag();
  const prop = await db().query(
    `INSERT INTO property (address, property_type, m2_built) VALUES ($1, 'piso', 70) RETURNING id`,
    [`Calle ${t}`],
  );
  const propertyId = Number(prop.rows[0].id);
  created.properties.push(propertyId);
  const lst = await db().query(
    `INSERT INTO listing (property_id, source, external_id, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [propertyId, `${PREFIX}src`, t],
  );
  const listingId = Number(lst.rows[0].id);
  created.listings.push(listingId);
  return listingId;
}

async function seedMerge(opts: {
  a: number;
  b: number;
  status: string;
  createdAgoHours: number;
  resolvedAgoHours?: number;
}): Promise<void> {
  const { rows } = await db().query(
    `INSERT INTO suggested_merge
        (listing_id_a, listing_id_b, match_basis, status, created_at, resolved_at)
     VALUES ($1, $2, 'fuzzy', $3,
             NOW() - make_interval(mins => $4),
             CASE WHEN $5::int IS NULL THEN NULL
                  ELSE NOW() - make_interval(mins => $5::int) END)
     RETURNING id`,
    [
      Math.min(opts.a, opts.b),
      Math.max(opts.a, opts.b),
      opts.status,
      Math.round(opts.createdAgoHours * 60),
      opts.resolvedAgoHours === undefined ? null : Math.round(opts.resolvedAgoHours * 60),
    ],
  );
  created.merges.push(Number(rows[0].id));
}

describe.skipIf(!dbAvailable)("getQueues", () => {
  it("counts depth, 24h in/out and oldest age for the capture and dedup-review queues", async () => {
    const before = await getQueues();
    expect(before.ok).toBe(true);
    // The full band, so a tile silently disappearing is a test failure.
    expect(before.queues.map((q) => q.key).sort()).toEqual([
      "captura",
      "capturas_sin_procesar",
      "dedup_pass",
      "dedup_review",
      "evaluacion_ia",
      "perfiles_materializar",
      "triggers",
    ]);

    // Capture worklist: +3 arrivals still waiting, +1 old one still waiting,
    // and 2 that left `pending` inside the window.
    await seedWorklistRow({ status: "pending", createdAgoHours: 1 });
    await seedWorklistRow({ status: "pending", createdAgoHours: 2 });
    await seedWorklistRow({ status: "pending", createdAgoHours: 3 });
    await seedWorklistRow({ status: "pending", createdAgoHours: 40 });
    await seedWorklistRow({ status: "captured", createdAgoHours: 40, updatedAgoHours: 2 });
    await seedWorklistRow({ status: "skipped", createdAgoHours: 40, updatedAgoHours: 3 });
    // Left the queue, but OUTSIDE the window — must not count as outflow.
    await seedWorklistRow({ status: "captured", createdAgoHours: 90, updatedAgoHours: 80 });

    // Dedup review: +2 arrivals waiting, +1 old one waiting, 3 resolved inside
    // the window (one of which also arrived inside it).
    const l = await Promise.all([
      seedListing(),
      seedListing(),
      seedListing(),
      seedListing(),
      seedListing(),
      seedListing(),
      seedListing(),
    ]);
    await seedMerge({ a: l[0], b: l[1], status: "pending", createdAgoHours: 1 });
    await seedMerge({ a: l[0], b: l[2], status: "pending", createdAgoHours: 2 });
    await seedMerge({ a: l[0], b: l[3], status: "pending", createdAgoHours: 50 });
    await seedMerge({ a: l[0], b: l[4], status: "confirmed", createdAgoHours: 3, resolvedAgoHours: 1 });
    await seedMerge({ a: l[0], b: l[5], status: "rejected", createdAgoHours: 50, resolvedAgoHours: 2 });
    await seedMerge({ a: l[0], b: l[6], status: "rejected", createdAgoHours: 60, resolvedAgoHours: 5 });

    const after = await getQueues();

    const cBefore = tile(before.queues, "captura");
    const cAfter = tile(after.queues, "captura");
    expect(cAfter.depth! - cBefore.depth!).toBe(4);
    expect(cAfter.inflow24h! - cBefore.inflow24h!).toBe(3);
    expect(cAfter.outflow24h! - cBefore.outflow24h!).toBe(2);
    expect(cAfter.oldestAgeHours).toBeGreaterThanOrEqual(39);

    const dBefore = tile(before.queues, "dedup_review");
    const dAfter = tile(after.queues, "dedup_review");
    expect(dAfter.depth! - dBefore.depth!).toBe(3);
    expect(dAfter.inflow24h! - dBefore.inflow24h!).toBe(3); // 2 pending + 1 confirmed
    expect(dAfter.outflow24h! - dBefore.outflow24h!).toBe(3);
    expect(dAfter.oldestAgeHours).toBeGreaterThanOrEqual(49);
    expect(dAfter.href).toBe("/admin/dedup");
  });

  it("counts a requeued row as an arrival, not just a newly seeded one (D-156)", async () => {
    const before = await getQueues();
    // Created long ago, requeued INSIDE the window → one arrival.
    await seedWorklistRow({ status: "pending", createdAgoHours: 100, requeuedAgoHours: 1 });
    // Created AND requeued inside the window → still exactly one arrival, not two.
    await seedWorklistRow({ status: "pending", createdAgoHours: 2, requeuedAgoHours: 1 });
    // Requeued, but outside the window → no arrival.
    await seedWorklistRow({ status: "pending", createdAgoHours: 100, requeuedAgoHours: 80 });
    const after = await getQueues();
    const b = tile(before.queues, "captura");
    const a = tile(after.queues, "captura");
    expect(a.inflow24h! - b.inflow24h!).toBe(2);
    expect(a.depth! - b.depth!).toBe(3);
  });

  it("stalled dedup pass flags red", async () => {
    const recent = await db().query(
      `SELECT MAX(finished_at) AS ts FROM dedup_runs
        WHERE status = 'success' AND finished_at > NOW() - INTERVAL '12 hours'`,
    );
    if (recent.rows[0]?.ts) {
      // Not assertable: `last_success` is a MAX over the whole table, so a
      // genuinely-healthy database (someone pointing this at the live demo
      // stack) cannot be seeded into the stalled state. Say so, don't fake it.
      // eslint-disable-next-line no-console
      console.warn(
        "[queues.integration.test] a dedup pass succeeded within 12h — " +
          "cannot seed a stalled pass; skipping the red-threshold assertion.",
      );
      return;
    }

    const ok = await db().query(
      `INSERT INTO dedup_runs (trigger, status, started_at, finished_at)
       VALUES ('zzz_test', 'success', NOW() - INTERVAL '21 hours', NOW() - INTERVAL '20 hours')
       RETURNING id`,
    );
    created.dedupRuns.push(Number(ok.rows[0].id));
    for (let i = 0; i < 2; i++) {
      const orphan = await db().query(
        `INSERT INTO dedup_runs (trigger, status, started_at, finished_at, error_msg)
         VALUES ('zzz_test', 'failed', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days',
                 'orphaned: still ''running'' after 7200s (max dedup runtime)')
         RETURNING id`,
      );
      created.dedupRuns.push(Number(orphan.rows[0].id));
    }

    const t = tile((await getQueues()).queues, "dedup_pass");
    expect(t.severity).toBe("alarm");
    // Not a count — the useful number is how long since the pass last worked.
    expect(t.depth).toBeNull();
    expect(t.headline).toMatch(/último OK hace \d+ h/);
    expect(t.note).toBe("2 muertos/7 d");
    expect(t.oldestAgeHours).toBeGreaterThanOrEqual(19);
  });

  it("flags an unprocessed extension capture by AGE, not by depth (D-162)", async () => {
    const before = tile((await getQueues()).queues, "capturas_sin_procesar");

    const young = await db().query(
      `INSERT INTO extension_capture (url, status, created_at)
       VALUES ($1, 'pending', NOW() - INTERVAL '2 minutes') RETURNING id`,
      [`https://example.invalid/${tag()}`],
    );
    created.captures.push(Number(young.rows[0].id));
    const withYoung = tile((await getQueues()).queues, "capturas_sin_procesar");
    expect(withYoung.depth! - before.depth!).toBe(1);
    if (before.severity === "ok") {
      // The poll loop ticks every 10s, so a fresh pending row is normal
      // in-flight work — depth alone must not raise anything.
      expect(withYoung.severity).toBe("ok");
    }

    const old = await db().query(
      `INSERT INTO extension_capture (url, status, created_at)
       VALUES ($1, 'pending', NOW() - INTERVAL '3 hours') RETURNING id`,
      [`https://example.invalid/${tag()}`],
    );
    created.captures.push(Number(old.rows[0].id));
    const withOld = tile((await getQueues()).queues, "capturas_sin_procesar");
    expect(withOld.severity).toBe("alarm");
    expect(withOld.note).toBe("el ETL no las procesa");
  });

  it("reports profiles-to-rematerialize as not evaluable while a sweep runs (#285)", async () => {
    const run = await db().query(
      `INSERT INTO connector_runs (trigger, status) VALUES ('zzz_test', 'running') RETURNING id`,
    );
    created.connectorRuns.push(Number(run.rows[0].id));

    const t = tile((await getQueues()).queues, "perfiles_materializar");
    // Mid-sweep the staleness check floods with false positives, so the tile
    // must show the reason — never a confident 0, and never a count.
    expect(t.depth).toBeNull();
    expect(t.unmeasured).toBe("sweep en curso");
    expect(t.trend).toBe("unknown");
    expect(t.severity).toBe("ok");
  });

  it("reports the assessment backlog with an unmeasured inflow", async () => {
    // The value here is that the composed eligibility SQL (imported verbatim
    // from the scheduler's own lib/ai-assessment/eligibility.ts fragments)
    // parses and runs against a real Postgres at all — a shape a mocked query
    // can never check.
    const t = tile((await getQueues()).queues, "evaluacion_ia");
    expect(t.depth).not.toBeNull();
    expect(t.inflow24h).toBeNull(); // nothing stamps "entered the backlog"
    expect(t.outflow24h).not.toBeNull();
    expect(t.href).toBe("/admin/llm");
    expect(["empty", "stalled", "working"]).toContain(t.trend);
  });
});
