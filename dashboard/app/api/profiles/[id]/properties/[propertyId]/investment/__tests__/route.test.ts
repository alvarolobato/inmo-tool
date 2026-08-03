/**
 * Real-Postgres integration test for the investment-metrics API (task 5.3,
 * #33; ties in #151/#32) — same "call the route handler directly against a
 * real DB" pattern as the feedback route's own integration test
 * (app/api/profiles/[id]/candidates/[propertyId]/feedback/__tests__/route.test.ts),
 * not a mocked-query test: this route's whole job is composing three DB-
 * backed computations correctly, which a mock can't verify.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile } from "@/lib/db/profiles";
import type { Scope, ThesisParams } from "@/lib/profiles-schema";
import { GET } from "../route";

// Distinct from every other integration test file's coordinates (Madrid
// Sol/Atocha, the feedback route's [40.30,-3.85], area-price.test.ts's
// Gijón) — see docs/skills/testing-patterns.md's gotcha note.
const TEST_COORDS: [number, number] = [41.6488, -0.8891]; // Zaragoza

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
      "[investment route.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

function ctx(id: number, propertyId: number) {
  return { params: Promise.resolve({ id: String(id), propertyId: String(propertyId) }) };
}

describe.runIf(dbAvailable)("GET /api/profiles/[id]/properties/[propertyId]/investment — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdPropertyIds: number[] = [];
  let createdProfileIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
    createdProfileIds = [];
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE profile_id = ANY($1::bigint[])", [
          createdProfileIds,
        ]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [createdProfileIds]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
      }
    });
  });

  async function insertProperty(pool: Pool, overrides: Partial<{ province: string | null }> = {}): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address, province)
       VALUES ($1, $2, 'piso', 80, 'Calle de prueba, investment-int-test', $3) RETURNING id`,
      [TEST_COORDS[0], TEST_COORDS[1], overrides.province ?? "Madrid"],
    );
    const id = Number(result.rows[0].id);
    createdPropertyIds.push(id);
    return id;
  }

  async function insertListing(pool: Pool, propertyId: number, price = 200000): Promise<void> {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
       VALUES ($1, 'fotocasa', $2, 'active', $3, NOW())`,
      [propertyId, `investment-int-test-${Math.random().toString(36).slice(2)}`, price],
    );
  }

  async function makeProfile(thesisParams: ThesisParams = {}): Promise<number> {
    const scope: Scope = {
      geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
      property_types: ["piso"],
      hard_exclusions: {},
    };
    const profile = await createProfile(
      `investment-int-test-${Date.now()}-${Math.random()}`,
      scope,
      thesisParams,
    );
    createdProfileIds.push(profile.id);
    return profile.id;
  }

  async function markMatched(pool: Pool, profileId: number, propertyId: number) {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
  }

  it("returns 400 for a non-numeric profile or property id", async () => {
    const res = await GET(null as never, ctx(NaN, 1));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the profile does not exist", async () => {
    const res = await GET(null as never, ctx(999999999, 1));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the property is not a matched candidate for the profile", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile();
      const propertyId = await insertProperty(pool);
      // Deliberately NOT calling markMatched.
      const res = await GET(null as never, ctx(profileId, propertyId));
      expect(res.status).toBe(404);
    });
  });

  it("returns full metrics (area price, rent estimate, yield) for a matched property with a rent assumption", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile({
        financing: { down_payment_pct: 20, rate_pct: 3, term_years: 25 },
        rent_assumption: { eur_per_m2_month: 12 },
      });
      const propertyId = await insertProperty(pool, { province: "Madrid" });
      await insertListing(pool, propertyId, 200000);
      await markMatched(pool, profileId, propertyId);

      const res = await GET(null as never, ctx(profileId, propertyId));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.rent_estimate.method).toBe("profile_assumption");
      expect(body.rent_estimate.estimated_monthly_rent).toBeCloseTo(12 * 80, 6); // 12 EUR/m2 * 80 m2
      expect(body.yield.gross_yield_pct).not.toBeNull();
      expect(body.yield.assumptions_used.acquisition_costs.comunidad_autonoma).toBe("Madrid");
      // area_price: only this one property ingested at this coordinate, so
      // sample_size is below MIN_SAMPLE_SIZE -> no comparison (still a
      // real, non-null AreaPriceComparison object with the insufficient-
      // data shape, not null — property itself has lat/lon).
      expect(body.area_price).not.toBeNull();
      expect(body.area_price.area_median_price_per_m2).toBeNull();
    });
  });

  it("returns the explicit no-rent-assumption result (not a fabricated rent) when the profile has none set", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile({}); // no rent_assumption
      const propertyId = await insertProperty(pool);
      await insertListing(pool, propertyId);
      await markMatched(pool, profileId, propertyId);

      const res = await GET(null as never, ctx(profileId, propertyId));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.rent_estimate.method).toBe("no_rent_assumption");
      expect(body.rent_estimate.estimated_monthly_rent).toBeNull();
      expect(body.yield.gross_yield_pct).toBeNull();
      expect(body.yield.assumptions_used).toBeNull();
    });
  });

  it("uses actual IBI/community fee from a listing's raw_extra instead of the assumed operating-cost percentage", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile({ rent_assumption: { eur_per_m2_month: 12 } });
      const propertyId = await insertProperty(pool);
      await pool.query(
        `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, raw_extra)
         VALUES ($1, 'solvia', $2, 'active', 200000, NOW(), $3::jsonb)`,
        [
          propertyId,
          `investment-int-test-${Math.random().toString(36).slice(2)}`,
          JSON.stringify({ ibi_anual_eur: 500, gastos_comunidad_eur: 80 }),
        ],
      );
      await markMatched(pool, profileId, propertyId);

      const res = await GET(null as never, ctx(profileId, propertyId));
      const body = await res.json();
      expect(body.yield.assumptions_used.carrying_costs_source).toBe("actual");
      expect(body.yield.assumptions_used.ibi_known).toBe(true);
      expect(body.yield.assumptions_used.community_fee_known).toBe(true);
      // 12 EUR/m2/month * 80 m2 = 960 EUR/month rent -> annual gross rent 11,520 EUR.
      // Actual IBI (500) + actual community (80*12=960) PLUS the default
      // 8% maintenance/vacancy assumption on top (8% of 11,520 = 921.6) —
      // NOT the bare 500+960=1,460 a full-replacement model would produce
      // (Opus review must-fix #1: replacing the whole line, not just the
      // categories actual data covers, understates carrying costs and can
      // flip cash-on-cash's sign).
      expect(body.yield.assumptions_used.annual_carrying_costs_eur).toBeCloseTo(500 + 80 * 12 + 0.08 * 11520, 6);
    });
  });
});
