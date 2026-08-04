/**
 * Real-Postgres integration tests for issue #31's comparable-rental
 * estimator.
 *
 * Same reasoning as area-price.test.ts (its sibling, same shape of query):
 * `estimateRent`/its internal comparable query are hand-built multi-CTE
 * SQL (percentile_cont x3, a size band, a correlated Haversine filter, an
 * operation='rent' EXISTS) — exactly the shape this project's own testing
 * history says a mocked-query test would not have caught (a
 * `normalize()`-only test passes regardless of schema CHECK validity).
 * This is a real INSERT -> estimateRent() -> assert round trip against a
 * real database, not a mock. `estimateRent` was a pure, DB-free function
 * before issue #31 (see git history) — it now runs its own comparable
 * query, same as `computeAreaPriceComparison` already did, hence this
 * file replaces the old pure-unit-test version wholesale rather than
 * keeping both.
 *
 * Every numeric worked example below was computed BY HAND first (see each
 * test's comment) and only then encoded as the fixture — not derived by
 * running the code and copying its output.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import {
  estimateRent,
  MIN_LOW_CONFIDENCE_SAMPLE_SIZE,
  MIN_HIGH_CONFIDENCE_SAMPLE_SIZE,
  MAX_HIGH_CONFIDENCE_RELATIVE_IQR,
  MAX_COMP_AGE_DAYS,
} from "../rent-estimate";

// Granada — deliberately distinct from every other integration test
// file's coordinate cluster (Madrid Sol/Atocha, area-price.test.ts's
// Gijón [43.3619,-5.8494], the investment route test's Zaragoza
// [41.6488,-0.8891], the feedback route test's [40.30,-3.85]). This file
// asserts exact comparable_count values within a radius, the same
// "exact-count assertion over a geographic radius" hazard
// docs/skills/testing-patterns.md's gotcha note warns about — see that
// note for why a shared coordinate would make this file flake under
// vitest's concurrent test-file execution.
const TEST_CENTER: [number, number] = [37.1773, -3.5986];
// Comfortably outside DEFAULT_RADIUS_KM (1.5km) from TEST_CENTER but still
// a real, plausible coordinate — used by the one test that needs a
// "nearby on the map, but not comparable" point.
const OUTSIDE_RADIUS: [number, number] = [37.05, -3.45];

async function withRealDb(fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    await fn(pool);
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
      "[rent-estimate.test] no reachable Postgres (POSTGRES_DSN unset or DB down) - skipping real-DB tests.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("estimateRent — real Postgres", () => {
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
    overrides: Partial<{ m2_built: number | null; property_type: string | null; lat: number | null; lon: number | null }> = {},
  ): Promise<number> {
    const row = {
      lat: TEST_CENTER[0],
      lon: TEST_CENTER[1],
      property_type: "piso",
      m2_built: 80,
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
    overrides: Partial<{
      source: string;
      status: string;
      current_price: number;
      operation: "sale" | "rent";
      /** Days ago (real Date math, not a DB expression) — defaults to 0 (NOW()), so every existing test that doesn't care about recency gets a fresh comp by default and passes MAX_COMP_AGE_DAYS's filter unchanged (must-fix #3, PR #199). */
      last_seen_days_ago: number;
    }> = {},
  ): Promise<void> {
    const row = {
      source: "milanuncios_rental",
      status: "active",
      current_price: 800,
      operation: "rent" as const,
      last_seen_days_ago: 0,
      ...overrides,
    };
    const lastSeenAt = new Date(Date.now() - row.last_seen_days_ago * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, operation, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        propertyId,
        row.source,
        `rent-estimate-test-${Math.random().toString(36).slice(2)}`,
        row.status,
        row.current_price,
        row.operation,
        lastSeenAt,
      ],
    );
  }

  /** A rental comparable at TEST_CENTER, same 'piso' type, given (m2, monthlyRent). */
  async function insertRentComp(pool: Pool, m2: number, monthlyRent: number): Promise<number> {
    const id = await insertProperty(pool, { m2_built: m2 });
    await insertListing(pool, id, { current_price: monthlyRent });
    return id;
  }

  it("gates on no_property_size regardless of whether an assumption is set — needed by BOTH paths", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: null });
      const withAssumption = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: null },
        { rent_assumption: { eur_per_m2_month: 12 } },
      );
      expect(withAssumption.method).toBe("no_property_size");
      expect(withAssumption.estimated_monthly_rent).toBeNull();

      const withoutAssumption = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: null },
        {},
      );
      expect(withoutAssumption.method).toBe("no_property_size");
    });
  });

  it("returns no_property_location (distinct from insufficient_data) when the property has no coordinates and no assumption is set", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      const result = await estimateRent({ id: targetId, lat: null, lon: null, property_type: null, m2_built: 80 }, {});
      expect(result.method).toBe("no_property_location");
      expect(result.method).not.toBe("insufficient_data");
      expect(result.market_comparable).toBeNull();
    });
  });

  it("returns insufficient_data (not a fabricated number) below MIN_LOW_CONFIDENCE_SAMPLE_SIZE comps", async () => {
    await withRealDb(async (pool) => {
      expect(MIN_LOW_CONFIDENCE_SAMPLE_SIZE).toBe(3);
      const targetId = await insertProperty(pool, { m2_built: 80 });
      // Only 2 comps — below the gate.
      await insertRentComp(pool, 80, 800);
      await insertRentComp(pool, 80, 820);

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      expect(result.method).toBe("insufficient_data");
      expect(result.estimated_monthly_rent).toBeNull();
      expect(result.confidence).toBeNull();
      expect(result.market_comparable!.comparable_count).toBe(2);
    });
  });

  // WORKED EXAMPLE 1 (hand-computed): 3 comps, all 80m2 (no size-band
  // effect), rents 720/800/880 -> EUR/m2/month 9,10,11. Sorted [9,10,11].
  // PERCENTILE_CONT(0.5), n=3: index=(n-1)*0.5=1 -> value at sorted[1]=10.
  // Median = 10 EUR/m2/month. 3 is >= MIN_LOW_CONFIDENCE_SAMPLE_SIZE (3)
  // but < MIN_HIGH_CONFIDENCE_SAMPLE_SIZE (8) -> "low" regardless of
  // dispersion (the count gate alone decides usable-vs-not; dispersion can
  // only ever demote high->low, per rent-estimate.ts's own docstring).
  // estimated_monthly_rent = 10 * target's own 80 m2 = 800.
  it("WORKED EXAMPLE: 3 comps -> market_comparable_low, median EUR/m2/month = 10, estimate = 800", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      await insertRentComp(pool, 80, 720);
      await insertRentComp(pool, 80, 800);
      await insertRentComp(pool, 80, 880);

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      expect(result.method).toBe("market_comparable_low");
      expect(result.confidence).toBe("low");
      expect(result.comparable_count).toBe(3);
      expect(result.eur_per_m2_month_used).toBeCloseTo(10, 6);
      expect(result.estimated_monthly_rent).toBeCloseTo(800, 6);
      expect(result.assumption_monthly_rent).toBeNull();
      expect(result.disagreement_pct).toBeNull();
    });
  });

  // WORKED EXAMPLE 2 (hand-computed): 8 comps (>= MIN_HIGH_CONFIDENCE_
  // SAMPLE_SIZE), EUR/m2/month values [10.0, 9.0, 11.0, 11.0, 10.0, 11.0,
  // 9.5, 9.5] via (m2, rent) pairs (80,800) (80,720) (100,1100) (60,660)
  // (90,900) (70,770) (80,760) (100,950). Sorted: [9.0, 9.5, 9.5, 10.0,
  // 10.0, 11.0, 11.0, 11.0].
  //   median: n=8, idx=(n-1)*0.5=3.5 -> interpolate sorted[3]=10.0 and
  //   sorted[4]=10.0 -> 10.0.
  //   p25: idx=(n-1)*0.25=1.75 -> interpolate sorted[1]=9.5, sorted[2]=9.5
  //   -> 9.5.
  //   p75: idx=(n-1)*0.75=5.25 -> interpolate sorted[5]=11.0, sorted[6]=11.0
  //   -> 11.0.
  //   relative IQR = (11.0-9.5)/10.0 = 0.15 <= MAX_HIGH_CONFIDENCE_RELATIVE_
  //   IQR (0.6) -> "high".
  // Mean, for comparison (mutation guard — a PERCENTILE_CONT->AVG mutation
  // must fail this test, VERIFIED live: reverting to AVG(eur_per_m2_month)
  // makes exactly this test fail with 10.125 where 10 was expected, every
  // other test in this file still green — see PR body): (9+9.5+9.5+10+10+
  // 11+11+11)/8 = 81/8 = 10.125, DISTINGUISHABLE from the median (10.0) —
  // an AVG-based implementation would compute eur_per_m2_month_used =
  // 10.125 and estimated_monthly_rent = 810, both asserted against below
  // as the WRONG values.
  // Target m2_built = 80 -> estimated_monthly_rent = 10.0 * 80 = 800.
  it("WORKED EXAMPLE: 8 comps with tight dispersion -> market_comparable_high, median = 10 (not the 10.125 mean)", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      const comps: Array<[number, number]> = [
        [80, 800],
        [80, 720],
        [100, 1100],
        [60, 660],
        [90, 900],
        [70, 770],
        [80, 760],
        [100, 950],
      ];
      for (const [m2, rent] of comps) {
        await insertRentComp(pool, m2, rent);
      }

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      expect(result.method).toBe("market_comparable_high");
      expect(result.confidence).toBe("high");
      expect(result.comparable_count).toBe(8);
      expect(result.eur_per_m2_month_used).toBeCloseTo(10, 6); // median, NOT the 10.125 mean
      expect(result.eur_per_m2_month_used).not.toBeCloseTo(10.125, 6);
      expect(result.estimated_monthly_rent).toBeCloseTo(800, 6);
      expect(result.estimated_monthly_rent).not.toBeCloseTo(810, 6); // the mean-based wrong answer
    });
  });

  // WORKED EXAMPLE 3 (hand-computed dispersion downgrade): 8 comps (meets
  // the HIGH count gate) but split into two widely-separated clusters —
  // EUR/m2/month [5,5,5,5,15,15,15,15] via (80,400) x4 and (80,1200) x4.
  // Sorted: [5,5,5,5,15,15,15,15].
  //   median: idx=3.5 -> interpolate sorted[3]=5, sorted[4]=15 -> 10.0.
  //   p25: idx=1.75 -> interpolate sorted[1]=5, sorted[2]=5 -> 5.0.
  //   p75: idx=5.25 -> interpolate sorted[5]=15, sorted[6]=15 -> 15.0.
  //   relative IQR = (15-5)/10 = 1.0, ABOVE MAX_HIGH_CONFIDENCE_RELATIVE_IQR
  //   (0.6) -> demoted to "low" DESPITE meeting the 8-comp count gate.
  // estimated_monthly_rent = 10.0 * 80 = 800 (count/dispersion only affect
  // the confidence LABEL, never the median itself — the same demoted
  // estimate is still returned, just tagged "low").
  it("WORKED EXAMPLE: 8 comps but high dispersion -> demoted to market_comparable_low, not high", async () => {
    await withRealDb(async (pool) => {
      expect(MAX_HIGH_CONFIDENCE_RELATIVE_IQR).toBe(0.6);
      expect(MIN_HIGH_CONFIDENCE_SAMPLE_SIZE).toBe(8);
      const targetId = await insertProperty(pool, { m2_built: 80 });
      for (let i = 0; i < 4; i++) await insertRentComp(pool, 80, 400); // 5 EUR/m2/month
      for (let i = 0; i < 4; i++) await insertRentComp(pool, 80, 1200); // 15 EUR/m2/month

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      expect(result.comparable_count).toBe(8); // meets the count gate...
      expect(result.method).toBe("market_comparable_low"); // ...but dispersion demotes it
      expect(result.confidence).toBe("low");
      expect(result.eur_per_m2_month_used).toBeCloseTo(10, 6);
      expect(result.estimated_monthly_rent).toBeCloseTo(800, 6);
    });
  });

  it("excludes comps outside the size band even when geographically identical and same type", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      // 3 in-band comps (m2 within [80*0.65, 80*1.35] = [52,108]).
      await insertRentComp(pool, 80, 800);
      await insertRentComp(pool, 80, 820);
      await insertRentComp(pool, 80, 780);
      // A comp at 200 m2 (far outside the band) with a rent that would
      // badly skew the median if wrongly included.
      await insertRentComp(pool, 200, 4000); // 20 EUR/m2/month — an outlier if counted

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      expect(result.comparable_count).toBe(3); // the 200m2 comp excluded
      expect(result.eur_per_m2_month_used).toBeCloseTo(10, 6); // median of 9.75/10.0/10.25's neighbourhood, not skewed by 20
    });
  });

  it("excludes comps outside the radius even when same type/size", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      await insertRentComp(pool, 80, 800);
      await insertRentComp(pool, 80, 820);
      await insertRentComp(pool, 80, 780);
      // A same-type/same-size comp, but geographically far away.
      const farId = await insertProperty(pool, { m2_built: 80, lat: OUTSIDE_RADIUS[0], lon: OUTSIDE_RADIUS[1] });
      await insertListing(pool, farId, { current_price: 5000 }); // would badly skew the median if wrongly included

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      expect(result.comparable_count).toBe(3);
    });
  });

  it("excludes sale listings from rent comparables (issue #31 EC-3 cross-contamination guard)", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      await insertRentComp(pool, 80, 800);
      await insertRentComp(pool, 80, 820);
      await insertRentComp(pool, 80, 780);
      // A SALE listing at the identical location/type/size, with a price
      // that (if wrongly divided by m2 as if it were a monthly rent) would
      // be a wildly implausible EUR/m2/month figure — proof this can only
      // pass if the operation='rent' filter is real, not a coincidence of
      // the numbers chosen.
      const saleId = await insertProperty(pool, { m2_built: 80 });
      await insertListing(pool, saleId, { current_price: 250000, operation: "sale" });

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      expect(result.comparable_count).toBe(3); // the sale listing excluded
      expect(result.eur_per_m2_month_used).toBeLessThan(100); // sane rent figure, not a sale-price-derived one
    });
  });

  it("does not count a withdrawn rent listing as a comparable", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      await insertRentComp(pool, 80, 800);
      await insertRentComp(pool, 80, 820);
      await insertRentComp(pool, 80, 780);
      const withdrawnId = await insertProperty(pool, { m2_built: 80 });
      await insertListing(pool, withdrawnId, { current_price: 50, status: "withdrawn" });

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      expect(result.comparable_count).toBe(3);
    });
  });

  // Opus review must-fix #4 (PR #199), the exact scenario the review
  // measured against real Postgres: 8 comps, 4 of them "precio a
  // consultar" (current_price=0, common for rentals) — before the fix,
  // MIN(current_price) still picked 0 as the cheapest "price" for those 4
  // properties and divided 0/m2_built into the median, giving 4.9 instead
  // of the true ~11. After the fix, current_price > 0 excludes the 4
  // zero-priced comps from the aggregate entirely rather than treating
  // Decimal("0") as a real low rent.
  it("Opus review must-fix #4: excludes zero-priced ('precio a consultar') comps from the median instead of treating them as a real €0 rent", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      // 4 real comps, all 80m2, EUR/m2/month = 11 exactly (rent 880).
      for (let i = 0; i < 4; i++) await insertRentComp(pool, 80, 880);
      // 4 "precio a consultar" comps — current_price = 0, same size band.
      for (let i = 0; i < 4; i++) await insertRentComp(pool, 80, 0);

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      // Only the 4 real comps count — the 4 zero-priced ones are excluded
      // entirely, not averaged in as if €0/month were a real observation.
      expect(result.comparable_count).toBe(4);
      expect(result.eur_per_m2_month_used).toBeCloseTo(11, 6);
      expect(result.estimated_monthly_rent).toBeCloseTo(880, 6);
      // The bug this guards against: with all 8 counted, median would be
      // 4.9 (understating rent ~55%, per the review's own live measurement).
      expect(result.eur_per_m2_month_used).not.toBeCloseTo(4.9, 1);
    });
  });

  it("Opus review must-fix #4: an ALL-zero-priced sample never produces a fabricated €0/month estimate — falls back to insufficient_data", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      // 5 comps, all "precio a consultar" — none pass current_price > 0.
      for (let i = 0; i < 5; i++) await insertRentComp(pool, 80, 0);

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      // Zero real comps found (all excluded by current_price > 0) — the
      // count gate alone already produces insufficient_data here; this is
      // the guard rail that stops a 0-priced sample from EVER reaching
      // yield.ts as a fabricated "0,0 %" yield with an "estimado" badge
      // (the exact bug already fixed once via fmtPct(null), reached here
      // by a different route per the review).
      expect(result.method).toBe("insufficient_data");
      expect(result.estimated_monthly_rent).toBeNull();
      expect(result.confidence).toBeNull();
      expect(result.market_comparable!.comparable_count).toBe(0);
    });
  });

  // Opus review must-fix #3 (PR #199): the rental connector never
  // withdraws stale listings (discovers_full_inventory=False), so without
  // a recency bound a rental ad ingested once would stay comp-eligible
  // forever. MAX_COMP_AGE_DAYS bounds this on last_seen_at.
  it("Opus review must-fix #3: excludes a comp whose last_seen_at is older than MAX_COMP_AGE_DAYS", async () => {
    await withRealDb(async (pool) => {
      expect(MAX_COMP_AGE_DAYS).toBe(30);
      const targetId = await insertProperty(pool, { m2_built: 80 });
      await insertRentComp(pool, 80, 800);
      await insertRentComp(pool, 80, 820);
      // A same-type/same-size/same-location comp, but last confirmed
      // present well beyond the recency bound — would badly skew the
      // count/median if wrongly included.
      const staleId = await insertProperty(pool, { m2_built: 80 });
      await insertListing(pool, staleId, { current_price: 5000, last_seen_days_ago: MAX_COMP_AGE_DAYS + 5 });

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      // 2 real comps + the stale one excluded = below the count gate.
      expect(result.method).toBe("insufficient_data");
      expect(result.market_comparable!.comparable_count).toBe(2);
    });
  });

  it("Opus review must-fix #3: surfaces oldest_comp_age_days as the worst-case age among the comps actually used", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      await insertRentComp(pool, 80, 800); // fresh (0 days)
      const midId = await insertProperty(pool, { m2_built: 80 });
      await insertListing(pool, midId, { current_price: 820, last_seen_days_ago: 5 });
      const oldestId = await insertProperty(pool, { m2_built: 80 });
      await insertListing(pool, oldestId, { current_price: 780, last_seen_days_ago: 20 }); // oldest still-valid comp

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      expect(result.market_comparable!.comparable_count).toBe(3);
      // Worst-case bound: the oldest of the 3 comps used was seen ~20 days
      // ago — the surfaced age must reflect that, not the freshest one.
      expect(result.market_comparable!.oldest_comp_age_days).toBeGreaterThanOrEqual(19);
      expect(result.market_comparable!.oldest_comp_age_days).toBeLessThanOrEqual(21);
    });
  });

  // "Also fix" (Opus review, PR #199): the dispersion gate used to only
  // apply to 8+ samples — a 3-7 sample's IQR was computed and discarded,
  // so wildly scattered small samples (the NORMAL case post-#205's
  // fetch_detail() wall — see rent-estimate.ts's module docstring) still
  // rendered a full "low"-confidence yield block. This is the review's own
  // worked example: [5, 10, 30] EUR/m2/month, median 10, relative IQR 1.25
  // (far above MAX_HIGH_CONFIDENCE_RELATIVE_IQR=0.6).
  it('WORKED EXAMPLE (Opus review "Also fix"): a 3-comp sample with extreme dispersion demotes to insufficient_data, not a noisy "low"', async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      // EUR/m2/month via (m2=80): 5, 10, 30 -> rents 400, 800, 2400.
      await insertRentComp(pool, 80, 400);
      await insertRentComp(pool, 80, 800);
      await insertRentComp(pool, 80, 2400);

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      // Count gate alone would have said "low" (3 >= MIN_LOW_CONFIDENCE_
      // SAMPLE_SIZE) — the widened dispersion gate must override that to
      // insufficient_data given how wildly these 3 comps disagree.
      expect(result.method).toBe("insufficient_data");
      expect(result.confidence).toBeNull();
      expect(result.estimated_monthly_rent).toBeNull();
      // The comparable count is still surfaced (not silently dropped) —
      // same convention as every other insufficient_data path.
      expect(result.market_comparable!.comparable_count).toBe(3);
    });
  });

  it('a 3-comp sample with TIGHT dispersion still resolves to "low", not insufficient_data (the widened gate only demotes, never over-demotes a genuinely usable small sample)', async () => {
    await withRealDb(async (pool) => {
      // Reuses WORKED EXAMPLE 1's exact fixture (median 10, relative IQR
      // well under 0.6) to prove the widened gate doesn't regress the
      // ordinary case.
      const targetId = await insertProperty(pool, { m2_built: 80 });
      await insertRentComp(pool, 80, 720);
      await insertRentComp(pool, 80, 800);
      await insertRentComp(pool, 80, 880);

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        {},
      );
      expect(result.method).toBe("market_comparable_low");
      expect(result.confidence).toBe("low");
      expect(result.comparable_count).toBe(3);
    });
  });

  // PRECEDENCE RULE, worked example (hand-computed): profile assumption =
  // 12 EUR/m2/month, target m2_built = 80 -> assumption_monthly_rent =
  // 12*80 = 960. Market comps are WORKED EXAMPLE 2's exact fixture (median
  // 10 EUR/m2/month, 8 comps, high confidence) -> market estimate = 800.
  // disagreement_pct = (960 - 800) / 800 = 0.2 (the assumption reads 20%
  // ABOVE what the market comps say). The PRIMARY figure must still be the
  // assumption (960) — never silently replaced by the measured 800 — but
  // BOTH numbers must be present in the result (rent-estimate.ts's "show
  // both" precedence rule).
  it("PRECEDENCE WORKED EXAMPLE: assumption stays primary even when comparables disagree, but both figures + the disagreement are surfaced", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      const comps: Array<[number, number]> = [
        [80, 800],
        [80, 720],
        [100, 1100],
        [60, 660],
        [90, 900],
        [70, 770],
        [80, 760],
        [100, 950],
      ];
      for (const [m2, rent] of comps) {
        await insertRentComp(pool, m2, rent);
      }

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        { rent_assumption: { eur_per_m2_month: 12 } },
      );

      // PRIMARY: the assumption, unchanged from PR #181's behaviour.
      expect(result.method).toBe("profile_assumption");
      expect(result.confidence).toBe("assumption");
      expect(result.estimated_monthly_rent).toBeCloseTo(960, 6);
      expect(result.assumption_monthly_rent).toBeCloseTo(960, 6);

      // SECONDARY: the market comparable, fully computed and attached —
      // not hidden just because it lost precedence.
      expect(result.market_comparable).not.toBeNull();
      expect(result.market_comparable!.confidence).toBe("high");
      expect(result.market_comparable!.comparable_count).toBe(8);
      expect(result.market_comparable!.estimated_monthly_rent).toBeCloseTo(800, 6);

      // The disagreement is explicit, not something the caller has to
      // re-derive from the two numbers above.
      expect(result.disagreement_pct).toBeCloseTo(0.2, 6);
    });
  });

  it("attaches a null-shaped market_comparable (not a crash) when comps are insufficient AND an assumption is set", async () => {
    await withRealDb(async (pool) => {
      const targetId = await insertProperty(pool, { m2_built: 80 });
      // Only 1 comp — below the gate.
      await insertRentComp(pool, 80, 800);

      const result = await estimateRent(
        { id: targetId, lat: TEST_CENTER[0], lon: TEST_CENTER[1], property_type: "piso", m2_built: 80 },
        { rent_assumption: { eur_per_m2_month: 12 } },
      );
      expect(result.method).toBe("profile_assumption");
      expect(result.market_comparable).not.toBeNull();
      expect(result.market_comparable!.confidence).toBeNull();
      expect(result.market_comparable!.estimated_monthly_rent).toBeNull();
      expect(result.disagreement_pct).toBeNull(); // can't disagree with a number that doesn't exist
    });
  });
});
