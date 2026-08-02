import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { createProfile } from "@/lib/db/profiles";
import {
  computeColdStartScore,
  MIN_TRAINING_EXAMPLES,
  MIN_TRAINING_EXAMPLES_MULTIPLIER,
  poolMedianPricePerM2,
} from "../pipeline";
import { FEATURE_NAMES, extractRaw, type ScoringInputRow } from "../features";
import { retrainAndRescoreProfile } from "../retrain";
import type { Scope } from "@/lib/profiles-schema";

const SCOPE: Scope = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
  property_types: ["piso"],
  price_min: 150000,
  price_max: 250000,
  hard_exclusions: {},
};

function raw(min_price: number | null, m2_built: number | null) {
  return extractRaw(
    { property_id: 1, m2_built, rooms: null, floor: null, has_elevator: null, year_built: null, min_price, first_seen_at: null },
    SCOPE,
  );
}

describe("MIN_TRAINING_EXAMPLES (task 3.4, #23)", () => {
  it("scales with the active feature count, not a hardcoded number", () => {
    // Issue #23's own derivation: roughly 3-5x feature count. This test
    // guards against someone hardcoding "32" directly and silently
    // decoupling it from FEATURE_NAMES.length the next time a feature is
    // added or removed.
    expect(MIN_TRAINING_EXAMPLES).toBe(MIN_TRAINING_EXAMPLES_MULTIPLIER * FEATURE_NAMES.length);
    expect(MIN_TRAINING_EXAMPLES_MULTIPLIER).toBeGreaterThanOrEqual(3);
    expect(MIN_TRAINING_EXAMPLES_MULTIPLIER).toBeLessThanOrEqual(5);
  });

  it("is 32 at the current 8-feature model — documents the concrete number this repo actually runs with today", () => {
    expect(FEATURE_NAMES.length).toBe(8);
    expect(MIN_TRAINING_EXAMPLES).toBe(32);
  });
});

describe("computeColdStartScore (task 3.4, #23)", () => {
  it("scores exactly at the profile's target price-per-m² as neutral (0.5)", () => {
    // price_min=150000, price_max=250000 -> band midpoint 200000; no size
    // band set, so price_per_m2_relative degrades to plain price/priceMid.
    // A candidate priced exactly at the midpoint has v=1.
    const score = computeColdStartScore(raw(200000, null));
    expect(score).toBeCloseTo(0.5, 5);
  });

  it("scores a cheaper-than-target candidate higher than 0.5 (price-per-m² ascending = cheaper first)", () => {
    const cheapScore = computeColdStartScore(raw(100000, null)); // v=0.5
    expect(cheapScore).toBeGreaterThan(0.5);
  });

  it("scores a pricier-than-target candidate lower than 0.5", () => {
    const priceyScore = computeColdStartScore(raw(400000, null)); // v=2.0
    expect(priceyScore).toBeLessThan(0.5);
  });

  it("orders multiple candidates by ascending price consistently (a real ranking, not just a sign check)", () => {
    const cheapest = computeColdStartScore(raw(50000, null));
    const mid = computeColdStartScore(raw(200000, null));
    const pricey = computeColdStartScore(raw(500000, null));
    expect(cheapest).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(pricey);
  });

  it("is neutral (0.5) when price is entirely unknown, not a guess in either direction", () => {
    const score = computeColdStartScore(raw(null, 70));
    expect(score).toBe(0.5);
  });

  it("stays within (0, 1) for an extreme price ratio, never hits exactly 0 or 1", () => {
    const veryExpensive = computeColdStartScore(raw(50_000_000, null));
    expect(veryExpensive).toBeGreaterThan(0);
    expect(veryExpensive).toBeLessThan(0.01);
  });

  describe("pool-median fallback when a profile has no price band (Fable review of PR #93)", () => {
    // No price_min/price_max set at all -> price_per_m2_relative is always
    // null regardless of the candidate's own data, which previously made
    // every candidate tie at exactly 0.5 (arbitrary/tied cold-start order —
    // the exact thing this function exists to avoid). scoreColdStart (the
    // real caller in pipeline.ts) computes the pool median and passes it as
    // poolFallback; this test exercises computeColdStartScore's fallback
    // branch directly, the same way scoreColdStart would call it.
    const NO_BAND_SCOPE: Scope = {
      geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
      property_types: ["piso"],
      hard_exclusions: {},
    };
    const rawNoBand = (min_price: number | null, m2_built: number | null) =>
      extractRaw(
        { property_id: 1, m2_built, rooms: null, floor: null, has_elevator: null, year_built: null, min_price, first_seen_at: null },
        NO_BAND_SCOPE,
      );

    it("ties at 0.5 with no fallback supplied — the bug this fix addresses", () => {
      expect(computeColdStartScore(rawNoBand(100000, 50))).toBe(0.5);
      expect(computeColdStartScore(rawNoBand(500000, 50))).toBe(0.5);
    });

    it("ranks cheaper-per-m² above pricier-per-m² relative to the pool median once a fallback is supplied", () => {
      const medianPricePerM2 = 3000; // e.g. a pool centered around 3000 EUR/m2
      const cheap = computeColdStartScore(rawNoBand(100000, 50), {
        pricePerM2: 2000, // below median
        poolMedianPricePerM2: medianPricePerM2,
      });
      const pricey = computeColdStartScore(rawNoBand(500000, 50), {
        pricePerM2: 5000, // above median
        poolMedianPricePerM2: medianPricePerM2,
      });
      expect(cheap).toBeGreaterThan(0.5);
      expect(pricey).toBeLessThan(0.5);
      expect(cheap).toBeGreaterThan(pricey);
    });

    it("poolMedianPricePerM2 computes a real median, ignoring rows with unknown price/size", () => {
      const inputs: ScoringInputRow[] = [
        { property_id: 1, m2_built: 50, rooms: null, floor: null, has_elevator: null, year_built: null, min_price: 100000, first_seen_at: null }, // 2000/m2
        { property_id: 2, m2_built: 50, rooms: null, floor: null, has_elevator: null, year_built: null, min_price: 200000, first_seen_at: null }, // 4000/m2
        { property_id: 3, m2_built: 50, rooms: null, floor: null, has_elevator: null, year_built: null, min_price: 300000, first_seen_at: null }, // 6000/m2
        { property_id: 4, m2_built: null, rooms: null, floor: null, has_elevator: null, year_built: null, min_price: 999999, first_seen_at: null }, // excluded: no size
      ];
      expect(poolMedianPricePerM2(inputs)).toBe(4000);
    });

    it("returns null when no candidate in the pool has both price and size known", () => {
      const inputs: ScoringInputRow[] = [
        { property_id: 1, m2_built: null, rooms: null, floor: null, has_elevator: null, year_built: null, min_price: 100000, first_seen_at: null },
      ];
      expect(poolMedianPricePerM2(inputs)).toBeNull();
    });
  });
});

/**
 * EC-2 (issue #23): a profile transitions from cold-start ordering to a real
 * trained model's scoring exactly when it crosses MIN_TRAINING_EXAMPLES —
 * not before, not some other threshold. Requires real feedback_event +
 * profile_scoring_model rows, so this is gated on a reachable Postgres
 * instance like this project's `*.integration.test.ts` files, kept in this
 * file (not split into a separate integration file) to match issue #23's own
 * named verification target (`pipeline.test.ts`).
 */
const TEST_COORDS: [number, number] = [40.20, -3.95]; // far from other test files' coordinates
const createdPropertyIds: number[] = [];
const createdProfileIds: number[] = [];

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
      "[pipeline.test] no reachable Postgres (POSTGRES_DSN unset or DB down) - skipping the EC-2 transition test.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("transitions from cold-start to trained model at threshold (EC-2, #23)", () => {
  afterAll(async () => {
    await withRealDb(async (pool) => {
      await pool.query("DELETE FROM feedback_event WHERE profile_id = ANY($1::bigint[])", [createdProfileIds]);
      await pool.query("DELETE FROM profile_scoring_model WHERE profile_id = ANY($1::bigint[])", [createdProfileIds]);
      await pool.query("DELETE FROM profile_listing_state WHERE profile_id = ANY($1::bigint[])", [createdProfileIds]);
      await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [createdProfileIds]);
      await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
    });
  });

  it("stays at cold-start below the threshold, switches to a real fit at exactly MIN_TRAINING_EXAMPLES", async () => {
    await withRealDb(async (pool) => {
      const scope: Scope = {
        geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      };
      const profile = await createProfile(`pipeline-ec2-test-${Date.now()}-${Math.random()}`, scope, {});
      createdProfileIds.push(profile.id);

      async function addLabeledProperty(price: number, feedbackType: "accept" | "reject"): Promise<number> {
        const propRes = await pool.query<{ id: string }>(
          `INSERT INTO property (lat, lon, property_type, m2_built) VALUES ($1, $2, 'piso', 70) RETURNING id`,
          [TEST_COORDS[0], TEST_COORDS[1]],
        );
        const propertyId = Number(propRes.rows[0].id);
        createdPropertyIds.push(propertyId);
        await pool.query(
          `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
           VALUES ($1, 'fotocasa', $2, 'active', $3, NOW())`,
          [propertyId, `ec2-test-${Math.random().toString(36).slice(2)}`, price],
        );
        await pool.query(
          `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
          [profile.id, propertyId],
        );
        await pool.query(
          `INSERT INTO feedback_event (profile_id, property_id, feedback_type) VALUES ($1, $2, $3)`,
          [profile.id, propertyId, feedbackType],
        );
        return propertyId;
      }

      // One below the threshold: MIN_TRAINING_EXAMPLES - 1 labeled examples,
      // split evenly (both classes present, so this isn't the separate
      // one-sided cold-start reason — purely a below-threshold check).
      const belowCount = MIN_TRAINING_EXAMPLES - 1;
      for (let i = 0; i < belowCount; i++) {
        await addLabeledProperty(i % 2 === 0 ? 150000 : 450000, i % 2 === 0 ? "accept" : "reject");
      }

      const belowResult = await retrainAndRescoreProfile(profile.id);
      expect(belowResult.trained).toBe(false);
      expect(belowResult.trainingExampleCount).toBe(belowCount);

      const { rows: belowRows } = await pool.query<{ score_kind: string | null }>(
        `SELECT DISTINCT score_kind FROM profile_listing_state WHERE profile_id = $1`,
        [profile.id],
      );
      expect(belowRows.every((r) => r.score_kind === "cold_start")).toBe(true);

      // One more example crosses MIN_TRAINING_EXAMPLES exactly.
      await addLabeledProperty(150000, "accept");
      const atThresholdResult = await retrainAndRescoreProfile(profile.id);
      expect(atThresholdResult.trained).toBe(true);
      expect(atThresholdResult.trainingExampleCount).toBe(MIN_TRAINING_EXAMPLES);

      const { rows: trainedRows } = await pool.query<{ score_kind: string | null }>(
        `SELECT DISTINCT score_kind FROM profile_listing_state WHERE profile_id = $1`,
        [profile.id],
      );
      expect(trainedRows.every((r) => r.score_kind === "trained")).toBe(true);
    });
  }, 20000);
});
