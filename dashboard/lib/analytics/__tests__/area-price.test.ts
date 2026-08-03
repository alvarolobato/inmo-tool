/**
 * Real-Postgres integration tests for issue #32's area-price comparison.
 *
 * This project's own testing-standard history (see PR body / AGENTS.md's
 * "eight times this session a check that appeared to pass was not running"
 * note) is exactly why this is a real-DB round-trip, not a mocked query
 * assertion: `computeAreaPriceComparison` is one hand-built multi-CTE SQL
 * statement (percentile_cont, a correlated Haversine filter, a scalar
 * MIN(current_price) subquery per side) — a shape that's easy to get
 * subtly wrong (wrong join, wrong NULL handling, off-by-one in the median)
 * in a way no amount of TypeScript-level testing would catch.
 *
 * Same skip-cleanly-without-a-DB pattern as
 * lib/filtering/__tests__/materialize.integration.test.ts.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { computeAreaPriceComparison, MIN_SAMPLE_SIZE } from "../area-price";

// Deliberately NOT the shared MADRID_SOL/ATOCHA points used by
// materialize.integration.test.ts / candidates.integration.test.ts /
// property-detail.integration.test.ts. Under the per-run isolated database
// (issue #159), vitest still runs test FILES concurrently against that one
// shared database — those other files' own fixtures are safe from each
// other because they assert containment of specific IDs, but this file
// asserts exact `sample_size` counts within a radius, which IS sensitive to
// any concurrent writer inserting a same-type property near the query
// centre. Reproduced directly while writing this suite: `npm test` run
// alone was 6/6 green, but as part of the full suite it intermittently
// failed 2 tests with an inflated sample_size (a materialize.integration
// property landing inside this file's default 1km radius around Madrid Sol
// at the same moment). Fixed by moving this file's fixtures to a distinct,
// clearly-dedicated coordinate (Gijón) far outside every other test file's
// query radius, rather than chasing the flake with retries.
const TEST_CENTER: [number, number] = [43.3619, -5.8494];

async function withRealDb(fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

// See materialize.integration.test.ts for why this must be a plain boolean
// evaluated at collection time (describe.runIf needs it, not a function).
const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[area-price.test] no reachable Postgres (POSTGRES_DSN unset or DB down) - skipping real-DB tests.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("computeAreaPriceComparison — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdPropertyIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
      }
    });
  });

  async function insertProperty(
    pool: Pool,
    overrides: Partial<{ m2_built: number; property_type: string; lat: number; lon: number }> = {},
  ): Promise<number> {
    const row = {
      lat: TEST_CENTER[0],
      lon: TEST_CENTER[1],
      property_type: "piso",
      m2_built: 100,
      ...overrides,
    };
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built) VALUES ($1, $2, $3, $4) RETURNING id`,
      [row.lat, row.lon, row.property_type, row.m2_built],
    );
    const id = result.rows[0].id;
    createdPropertyIds.push(id);
    return id;
  }

  async function insertListing(
    pool: Pool,
    propertyId: number,
    overrides: Partial<{ source: string; status: string; current_price: number }> = {},
  ): Promise<void> {
    const row = {
      source: "fotocasa",
      status: "active",
      current_price: 300000,
      ...overrides,
    };
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price)
       VALUES ($1, $2, $3, $4, $5)`,
      [propertyId, row.source, `area-price-test-${Math.random().toString(36).slice(2)}`, row.status, row.current_price],
    );
  }

  it("computes median price-per-m2 and correct percentage delta", async () => {
    await withRealDb(async (pool) => {
      // Target: 100 m2, 300,000 EUR -> 3,000 EUR/m2.
      const targetId = await insertProperty(pool, { m2_built: 100 });
      await insertListing(pool, targetId, { current_price: 300000 });

      // 5 comps (>= MIN_SAMPLE_SIZE), price/m2 = 1500, 2000, 2400, 2600, 9000
      // (each 100 m2 for a clean per-m2 figure). DELIBERATELY asymmetric
      // (one big outlier at 9000) so median (2400, the middle value) and
      // mean ((1500+2000+2400+2600+9000)/5 = 3500) are clearly different —
      // a symmetric fixture would pass even if the implementation used
      // AVG() instead of PERCENTILE_CONT(0.5), silently defeating the
      // entire "median, not mean, to reduce outlier sensitivity" design
      // goal from issue #32's Technical approach #1. Confirmed by mutation
      // (swapping PERCENTILE_CONT for AVG locally): this exact assertion
      // fails (2400 expected vs. 3500 actual) — see PR body.
      const comps = [150000, 200000, 240000, 260000, 900000];
      for (const price of comps) {
        const id = await insertProperty(pool, { m2_built: 100 });
        await insertListing(pool, id, { current_price: price });
      }

      const result = await computeAreaPriceComparison(targetId);
      expect(result).not.toBeNull();
      expect(result!.sample_size).toBe(5);
      expect(result!.area_avg_price_per_m2).toBeCloseTo(2400, 6); // median, not the 3500 mean
      expect(result!.property_price_per_m2).toBeCloseTo(3000, 6);
      // (3000 - 2400) / 2400 = 0.25 -> target is 25% above the area median.
      expect(result!.pct_vs_average).toBeCloseTo(0.25, 6);
    });
  });

  it("insufficient sample size yields no comparison", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 100 });
      await insertListing(pool, targetId, { current_price: 300000 });

      // Only 3 comps — below MIN_SAMPLE_SIZE (5). A real, distinguishable
      // number here (not just "less than 5") proves the gate isn't
      // hardcoded to a specific test fixture size.
      expect(MIN_SAMPLE_SIZE).toBeGreaterThan(3);
      for (const price of [200000, 220000, 240000]) {
        const id = await insertProperty(pool, { m2_built: 100 });
        await insertListing(pool, id, { current_price: price });
      }

      const result = await computeAreaPriceComparison(targetId);
      expect(result).not.toBeNull();
      expect(result!.sample_size).toBe(3);
      // Explicit "insufficient data", not a noisy 3-listing average.
      expect(result!.area_avg_price_per_m2).toBeNull();
      expect(result!.pct_vs_average).toBeNull();
      // The target's own price/m2 is still known and reported — only the
      // comparison is withheld, not everything.
      expect(result!.property_price_per_m2).toBeCloseTo(3000, 6);
    });
  });

  it("duplicate listings for the same property do not double-count in the average", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 100 });
      await insertListing(pool, targetId, { current_price: 300000 });

      // 4 single-listing comps...
      for (const price of [200000, 220000, 260000, 280000]) {
        const id = await insertProperty(pool, { m2_built: 100 });
        await insertListing(pool, id, { current_price: price });
      }
      // ...plus ONE deduplicated property (task 2.2's shape: one property,
      // two listings from different sites at different prices) — this must
      // count as exactly one comparable using its cheaper active listing
      // (scope-query.ts's own MIN(current_price) convention), never two.
      const dedupedId = await insertProperty(pool, { m2_built: 100 });
      await insertListing(pool, dedupedId, { source: "fotocasa", current_price: 240000 });
      await insertListing(pool, dedupedId, { source: "milanuncios", current_price: 250000 });

      const result = await computeAreaPriceComparison(targetId);
      expect(result).not.toBeNull();
      // 4 single-listing comps + 1 deduplicated comp = 5, NOT 6.
      expect(result!.sample_size).toBe(5);
      // Median uses the deduplicated property's cheaper (240,000 -> 2400/m2)
      // listing, matching the same 5-value median (2000,2200,2400,2600,2800)
      // as the first test.
      expect(result!.area_avg_price_per_m2).toBeCloseTo(2400, 6);
    });
  });

  it("excludes non-active listings from both the target's own price/m2 and the comparison set", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 100 });
      await insertListing(pool, targetId, { current_price: 300000, status: "active" });

      for (const price of [200000, 220000, 240000, 260000, 280000]) {
        const id = await insertProperty(pool, { m2_built: 100 });
        await insertListing(pool, id, { current_price: price, status: "active" });
      }
      // A withdrawn-only property must not enter the comparison set at all.
      const withdrawnId = await insertProperty(pool, { m2_built: 100 });
      await insertListing(pool, withdrawnId, { current_price: 50000, status: "withdrawn" });

      const result = await computeAreaPriceComparison(targetId);
      expect(result!.sample_size).toBe(5); // the withdrawn property is excluded, not a 6th comp
    });
  });

  it("returns null when the target property itself lacks lat/lon (nothing to compare geographically)", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 100 });
      await pool.query("UPDATE property SET lat = NULL, lon = NULL WHERE id = $1", [targetId]);
      await insertListing(pool, targetId, { current_price: 300000 });

      const result = await computeAreaPriceComparison(targetId);
      expect(result).toBeNull();
    });
  });

  it("only compares against properties of the same property_type", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 100, property_type: "piso" });
      await insertListing(pool, targetId, { current_price: 300000 });

      // 5 same-type comps (valid sample)...
      for (const price of [200000, 220000, 240000, 260000, 280000]) {
        const id = await insertProperty(pool, { m2_built: 100, property_type: "piso" });
        await insertListing(pool, id, { current_price: price });
      }
      // ...plus a differently-typed property that must NOT be pulled in,
      // even though it's geographically identical and would otherwise
      // change the median.
      const chaletId = await insertProperty(pool, { m2_built: 100, property_type: "chalet" });
      await insertListing(pool, chaletId, { current_price: 900000 }); // would badly skew the median if counted

      const result = await computeAreaPriceComparison(targetId);
      expect(result!.sample_size).toBe(5);
      expect(result!.area_avg_price_per_m2).toBeCloseTo(2400, 6);
    });
  });
});
