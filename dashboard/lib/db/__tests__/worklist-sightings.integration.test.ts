/**
 * Real-Postgres integration test for issue #639's review C1 (BLOCKER):
 * `addWorklistUrls` (lib/db/worklist.ts) is the ACTUAL production sighting
 * path — the D-088 results-page walk (browser-extension/background.js
 * `renderAndHarvest`) POSTs harvested detail URLs straight to
 * `POST /api/etl/worklist { via: 'derived' }`, and never touches
 * `POST /api/extension/capture` at all. A unit test mocking `sql()` cannot
 * prove the real UPDATE lands on `listing.last_seen_at`; only a real query
 * does — mirrors etl/tests/test_capture.py's
 * TestListingPageSightingsBumpLastSeen, which proves the SAME thing for the
 * (real, but non-production-path) etl/capture.py side.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { addWorklistUrls } from "@/lib/db/worklist";

const EXTERNAL_IDS = ["6390011", "6390022", "6390099"];

async function withRealDb<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[worklist-sightings.integration.test] no reachable Postgres " +
        "(POSTGRES_DSN unset or DB down) - skipping real-DB tests.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

async function cleanup(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM capture_worklist WHERE source_portal = 'idealista' AND url LIKE '%/inmueble/639%'`,
  );
  const rows = await pool.query<{ property_id: number }>(
    `SELECT property_id FROM listing WHERE source = 'idealista' AND external_id = ANY($1)`,
    [EXTERNAL_IDS],
  );
  await pool.query(`DELETE FROM listing WHERE source = 'idealista' AND external_id = ANY($1)`, [
    EXTERNAL_IDS,
  ]);
  const propertyIds = rows.rows.map((r) => r.property_id);
  if (propertyIds.length > 0) {
    await pool.query(`DELETE FROM property WHERE id = ANY($1)`, [propertyIds]);
  }
}

async function seedListing(
  pool: Pool,
  externalId: string,
  ageInterval: string,
): Promise<void> {
  const property = await pool.query<{ id: number }>(
    `INSERT INTO property DEFAULT VALUES RETURNING id`,
  );
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, last_seen_at, last_fetched_at)
       VALUES ($1, 'idealista', $2, NOW() - $3::interval, NOW() - $3::interval)`,
    [property.rows[0].id, externalId, ageInterval],
  );
}

async function fetchListing(
  pool: Pool,
  externalId: string,
): Promise<{ status: string; lastSeenAt: Date; lastFetchedAt: Date }> {
  const rows = await pool.query<{
    status: string;
    last_seen_at: Date;
    last_fetched_at: Date;
  }>(`SELECT status, last_seen_at, last_fetched_at FROM listing WHERE source = 'idealista' AND external_id = $1`, [
    externalId,
  ]);
  const row = rows.rows[0];
  return { status: row.status, lastSeenAt: row.last_seen_at, lastFetchedAt: row.last_fetched_at };
}

describe.runIf(dbAvailable)("addWorklistUrls sighting write — real Postgres (issue #639 C1)", () => {
  afterEach(async () => {
    await withRealDb(cleanup);
  });

  it("a derived-via batch bumps last_seen_at for an already-known listing it enumerates", async () => {
    await withRealDb(async (pool) => {
      await cleanup(pool);
      await seedListing(pool, "6390011", "10 days");

      await addWorklistUrls(
        [
          "https://www.idealista.com/inmueble/6390011/",
          "https://www.idealista.com/inmueble/6390022/",
        ],
        "derived",
      );

      const before = await fetchListing(pool, "6390011");
      const now = (await pool.query<{ now: Date }>("SELECT NOW() as now")).rows[0].now;
      const ageSeconds = (now.getTime() - before.lastSeenAt.getTime()) / 1000;
      expect(ageSeconds).toBeLessThan(30);
    });
  });

  it("does not touch status or last_fetched_at (sighting != verification)", async () => {
    await withRealDb(async (pool) => {
      await cleanup(pool);
      await seedListing(pool, "6390011", "10 days");
      const before = await fetchListing(pool, "6390011");

      await addWorklistUrls(["https://www.idealista.com/inmueble/6390011/"], "derived");

      const after = await fetchListing(pool, "6390011");
      expect(after.status).toBe(before.status);
      expect(after.lastFetchedAt.getTime()).toBe(before.lastFetchedAt.getTime());
    });
  });

  it("a listing NOT in this batch is left untouched", async () => {
    await withRealDb(async (pool) => {
      await cleanup(pool);
      await seedListing(pool, "6390099", "10 days");

      // Batch enumerates 6390011/6390022 only — 6390099 never appears.
      await addWorklistUrls(
        [
          "https://www.idealista.com/inmueble/6390011/",
          "https://www.idealista.com/inmueble/6390022/",
        ],
        "derived",
      );

      const untouched = await fetchListing(pool, "6390099");
      const now = (await pool.query<{ now: Date }>("SELECT NOW() as now")).rows[0].now;
      const ageSeconds = (now.getTime() - untouched.lastSeenAt.getTime()) / 1000;
      expect(ageSeconds).toBeGreaterThan(9 * 24 * 3600);
    });
  });

  it("a manually-pasted (via='manual') batch does NOT record a sighting", async () => {
    // Scoped narrowly per the review's own guidance ('via=derived' is the
    // enumeration path); a manual paste is an operator action, not an
    // enumeration, and must not silently start bumping last_seen_at too.
    await withRealDb(async (pool) => {
      await cleanup(pool);
      await seedListing(pool, "6390011", "10 days");

      await addWorklistUrls(["https://www.idealista.com/inmueble/6390011/"], "manual");

      const still = await fetchListing(pool, "6390011");
      const now = (await pool.query<{ now: Date }>("SELECT NOW() as now")).rows[0].now;
      const ageSeconds = (now.getTime() - still.lastSeenAt.getTime()) / 1000;
      expect(ageSeconds).toBeGreaterThan(9 * 24 * 3600);
    });
  });

  it("a fresher last_seen_at is never dragged backwards by a stale re-enumeration", async () => {
    await withRealDb(async (pool) => {
      await cleanup(pool);
      // Seeded FRESH (1 minute old) — newer than "now" would be if some bug
      // computed a backdated timestamp for the sighting write.
      await seedListing(pool, "6390011", "1 minute");
      const before = await fetchListing(pool, "6390011");

      await addWorklistUrls(["https://www.idealista.com/inmueble/6390011/"], "derived");

      const after = await fetchListing(pool, "6390011");
      expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before.lastSeenAt.getTime());
    });
  });

  it("a batch with no known listings is a clean no-op, not an error", async () => {
    await withRealDb(async (pool) => {
      await cleanup(pool);
      // No listing seeded at all — must not throw.
      await expect(
        addWorklistUrls(["https://www.idealista.com/inmueble/6390011/"], "derived"),
      ).resolves.not.toThrow();
    });
  });
});
