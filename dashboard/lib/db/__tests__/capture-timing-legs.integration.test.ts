/**
 * Real-Postgres integration test for the three per-listing capture timing legs
 * (issue #700, D-162) as `getDataHealth()` actually aggregates them.
 *
 * Two things need a real database to be provable at all:
 *
 *   1. **The SQL runs.** The legs are three `percentile_cont(... ) WITHIN GROUP
 *      (...) FILTER (...)` expressions in a hand-written query; a mocked `sql`
 *      cannot tell whether Postgres accepts them, and no other test in the repo
 *      executes this query.
 *   2. **D-162 rule 2 holds on the derived leg.** Queue wait is the only leg
 *      that is COMPUTED rather than stored: `(processed_at - created_at) -
 *      processing_ms`. A row whose `processing_ms` is NULL ("not measured" — a
 *      capture written before the column existed) must be EXCLUDED, not
 *      COALESCEd to 0, because coercing it bills that row's ENTIRE
 *      created→processed delta as queue idle. Reviewing PR #695 caught exactly
 *      that coercion in the first draft, and nothing failed.
 *
 * Every fixture uses a synthetic host that `hostToPortal` cannot map to a real
 * CAPTURE_PORTALS entry, so the portal row under assertion is this test's own
 * and can never fold in real capture data when POSTGRES_DSN happens to point
 * at the shared local demo database. Rows are deleted by their own captured
 * ids, never by a `WHERE url LIKE` sweep.
 *
 * Skips cleanly when no database is reachable; REQUIRE_DB=1 makes that a hard
 * failure (AGENTS.md / etl/tests/conftest.py's contract).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { getDataHealth } from "../data-health";

// Not a real portal host: hostToPortal falls through to the bare host, so this
// test's portal row is uniquely its own.
const HOST = "zzz-test-timing.example.com";
const PORTAL = HOST;

const REQUIRE_DB = process.env.REQUIRE_DB === "1";

const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    if (REQUIRE_DB) {
      throw new Error(
        "REQUIRE_DB=1 but Postgres is unreachable for capture-timing-legs.integration.test.ts: " +
          String(err),
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[capture-timing-legs.integration.test] no reachable Postgres — skipping. " +
        "Set POSTGRES_DSN to run it.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const seededIds: number[] = [];

async function withRealDb<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool(buildPgPoolConfig({ max: 3 }));
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** One extension_capture row, aged into the 7d window, id remembered for cleanup. */
async function seedCapture(
  pool: Pool,
  opts: {
    status: string;
    ageMs: number; // created_at, relative to now
    deltaMs: number | null; // processed_at - created_at; null → still pending
    processingMs: number | null;
    renderWaitMs: number | null;
  },
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO extension_capture
        (url, status, created_at, processed_at, processing_ms, render_wait_ms)
     VALUES ($1, $2,
             NOW() - ($3::double precision * interval '1 millisecond'),
             CASE WHEN $4::double precision IS NULL THEN NULL
                  ELSE NOW() - (($3::double precision - $4::double precision)
                                * interval '1 millisecond') END,
             $5, $6)
     RETURNING id`,
    [
      `https://${HOST}/es/detail/${Math.random().toString(36).slice(2)}`,
      opts.status,
      opts.ageMs,
      opts.deltaMs,
      opts.processingMs,
      opts.renderWaitMs,
    ],
  );
  seededIds.push(rows[0].id);
  return rows[0].id;
}

async function portalRow() {
  const health = await getDataHealth();
  const row = health.portals.find((p) => p.portal === PORTAL);
  expect(row, `no portal row for ${PORTAL}`).toBeDefined();
  return row!;
}

afterEach(async () => {
  if (!dbAvailable || seededIds.length === 0) return;
  await withRealDb(async (pool) => {
    await pool.query("DELETE FROM extension_capture WHERE id = ANY($1::bigint[])", [seededIds]);
  });
  seededIds.length = 0;
});

describe.skipIf(!dbAvailable)("per-listing capture timing legs (issue #700, D-162)", () => {
  it("reports the three legs apart, and never sums them into one number", async () => {
    await withRealDb(async (pool) => {
      // A slow-rendering portal: 19.5s in the browser, ~5s idle in the poll
      // queue, 210ms of real server work. The whole point of the split is that
      // only the first of those three is the portal's fault.
      for (let i = 0; i < 3; i++) {
        await seedCapture(pool, {
          status: "done",
          ageMs: 60_000 + i * 1_000,
          deltaMs: 6_120,
          processingMs: 210,
          renderWaitMs: 19_500,
        });
      }
    });

    const row = await portalRow();
    expect(row.median_render_wait_ms_7d).toBe(19_500);
    expect(row.median_processing_ms_7d).toBe(210);
    // Queue wait is DERIVED: delta (6120) − processing (210).
    expect(row.median_queue_wait_ms_7d).toBeCloseTo(5_910, -1);
  });

  it("EXCLUDES a row whose processing_ms was never measured, rather than COALESCEing it to 0", async () => {
    // The mutation this pins (and the bug the PR #695 review caught): swap the
    // FILTER's `processing_ms IS NOT NULL` for `COALESCE(processing_ms, 0)`
    // and the unmeasured row below contributes its FULL 30s delta as queue
    // idle, dragging the median from 5,910 to 30,000 — a leg that is supposed
    // to be constant-by-construction suddenly "varies by portal", which is
    // precisely the misreading D-162 exists to prevent.
    await withRealDb(async (pool) => {
      for (let i = 0; i < 3; i++) {
        await seedCapture(pool, {
          status: "done",
          ageMs: 60_000 + i * 1_000,
          deltaMs: 6_120,
          processingMs: 210,
          renderWaitMs: 1_000,
        });
      }
      // Three pre-migration rows: processed, but processing_ms unknown.
      for (let i = 0; i < 3; i++) {
        await seedCapture(pool, {
          status: "done",
          ageMs: 70_000 + i * 1_000,
          deltaMs: 30_000,
          processingMs: null,
          renderWaitMs: null,
        });
      }
    });

    const row = await portalRow();
    expect(row.median_queue_wait_ms_7d).toBeCloseTo(5_910, -1);
    expect(row.median_queue_wait_ms_7d!).toBeLessThan(10_000);
  });

  it("returns null — never 0 — for a portal with no measured sample at all", async () => {
    await withRealDb(async (pool) => {
      await seedCapture(pool, {
        status: "pending",
        ageMs: 30_000,
        deltaMs: null,
        processingMs: null,
        renderWaitMs: null,
      });
    });

    const row = await portalRow();
    expect(row.pending_count).toBe(1);
    expect(row.median_render_wait_ms_7d).toBeNull();
    expect(row.median_queue_wait_ms_7d).toBeNull();
    expect(row.median_processing_ms_7d).toBeNull();
  });

  it("counts FAILED captures too — a portal cannot look fast by breaking", async () => {
    // D-162 rule 4. A failure still cost the owner its render wait and its
    // processing time; excluding failures makes a portal look best exactly
    // when it is breaking most.
    await withRealDb(async (pool) => {
      await seedCapture(pool, {
        status: "failed",
        ageMs: 60_000,
        deltaMs: 4_000,
        processingMs: 300,
        renderWaitMs: 18_000,
      });
    });

    const row = await portalRow();
    expect(row.done_7d).toBe(0);
    expect(row.failed_7d).toBe(1);
    expect(row.median_render_wait_ms_7d).toBe(18_000);
    expect(row.median_processing_ms_7d).toBe(300);
  });
});
