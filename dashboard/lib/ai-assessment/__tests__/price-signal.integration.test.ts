/**
 * Zone-median price signal — real-Postgres integration test (#184).
 *
 * `buildAreaPriceSignal` is a thin wrapper around `lib/analytics/area-price
 * .ts`'s `computeAreaPriceComparison` (#32), which is one hand-built
 * multi-CTE SQL statement (percentile_cont, a correlated Haversine filter).
 * A mocked test can assert `price-signal.ts`'s OWN bucketing/silence logic
 * (see price-signal.test.ts) but cannot judge whether what
 * `computeAreaPriceComparison` actually RETURNS for the insufficient-sample
 * case is what `buildAreaPriceSignal` is built to handle — that needs a real
 * round trip against the real SQL, which is what this file is for.
 *
 * Deliberately at a coordinate no other integration test uses (see
 * area-price.test.ts's own header for why: vitest runs test files
 * concurrently against ONE shared per-run database, and this file's
 * `sample_size` assertions are sensitive to any concurrent writer inserting
 * a same-type property nearby).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { MIN_SAMPLE_SIZE } from "@/lib/analytics/area-price";
import { buildAreaPriceSignal } from "../price-signal";

// Valencia city centre — distinct from materialize.integration.test.ts's
// Madrid Sol/Atocha and area-price.test.ts's own Gijón fixture.
const TEST_CENTER: [number, number] = [39.4699, -0.3763];

async function withRealDb(fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

const REQUIRE_DB = process.env.REQUIRE_DB === "1";

const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    if (REQUIRE_DB) {
      throw new Error(
        "REQUIRE_DB=1 but Postgres is unreachable for price-signal.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[price-signal.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("buildAreaPriceSignal — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdPropertyIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdPropertyIds.length === 0) return;
      await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [
        createdPropertyIds,
      ]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
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

  async function insertListing(pool: Pool, propertyId: number, currentPrice: number): Promise<void> {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price)
       VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3)`,
      [propertyId, `price-signal-test-${Math.random().toString(36).slice(2)}`, currentPrice],
    );
  }

  it(
    "renders NOTHING when there are fewer than MIN_SAMPLE_SIZE comparables — the exact case " +
      "#184 requirement 2 exists to prevent from becoming a fabricated claim",
    async () => {
      await withRealDb(async (pool) => {
        // Target priced FAR below what the (insufficient) comps would suggest —
        // if buildAreaPriceSignal ever ignored the sample-size gate, this is
        // the fixture that would catch it (it would very obviously render).
        const targetId = await insertProperty(pool, { m2_built: 100 });
        await insertListing(pool, targetId, 100000); // 1000 EUR/m2

        // Only 3 comps — below MIN_SAMPLE_SIZE (5).
        expect(MIN_SAMPLE_SIZE).toBeGreaterThan(3);
        for (const price of [400000, 420000, 440000]) {
          const id = await insertProperty(pool, { m2_built: 100 });
          await insertListing(pool, id, price);
        }

        const signal = await buildAreaPriceSignal(targetId);
        expect(signal).toBeUndefined();
      });
    },
  );

  it("renders a bucketed below-market signal when comparables are sufficient and the property is cheap", async () => {
    await withRealDb(async (pool) => {
      // Target: 100 m2, 200,000 EUR -> 2000 EUR/m2.
      const targetId = await insertProperty(pool, { m2_built: 100 });
      await insertListing(pool, targetId, 200000);

      // 5 comps at 4000 EUR/m2 (400,000 / 100m2) -> median 4000. Target is
      // (2000-4000)/4000 = -0.5 -> 50% below median -> band "50-60".
      for (const price of [400000, 400000, 400000, 400000, 400000]) {
        const id = await insertProperty(pool, { m2_built: 100 });
        await insertListing(pool, id, price);
      }

      const signal = await buildAreaPriceSignal(targetId);
      expect(signal).toBeDefined();
      expect(signal).toContain("por debajo");
      expect(signal).toContain("50-60");
      // 5 comps -> sample tier "5-9" (MIN_SAMPLE_SIZE=5, so [5, 2*5) = [5,10)).
      expect(signal).toContain("5-9");
      // The exact count must NOT appear verbatim — only the bucket.
      expect(signal).not.toMatch(/\b5 comparables\b/);
    });
  });

  it("renders NOTHING when the property is priced AT OR ABOVE the zone median (not a distress signal)", async () => {
    await withRealDb(async (pool) => {
      // Target priced ABOVE the comps.
      const targetId = await insertProperty(pool, { m2_built: 100 });
      await insertListing(pool, targetId, 500000); // 5000 EUR/m2

      for (const price of [200000, 210000, 220000, 230000, 240000]) {
        const id = await insertProperty(pool, { m2_built: 100 });
        await insertListing(pool, id, price);
      }

      const signal = await buildAreaPriceSignal(targetId);
      expect(signal).toBeUndefined();
    });
  });

  it("renders NOTHING when the target property has no active priced listing (no comparison possible)", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 100 });
      // No listing inserted for the target at all.

      for (const price of [200000, 210000, 220000, 230000, 240000]) {
        const id = await insertProperty(pool, { m2_built: 100 });
        await insertListing(pool, id, price);
      }

      const signal = await buildAreaPriceSignal(targetId);
      expect(signal).toBeUndefined();
    });
  });
});
