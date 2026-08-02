/**
 * Real-Postgres integration tests for the hard-filter engine (task 2.4, #18).
 *
 * Opus's review of PR #57 found that all 17 existing tests across
 * scope-query.test.ts/materialize.test.ts assert against SQL substrings or
 * mocked `client.query` call sequences — none execute the generated SQL
 * against a real database. That's precisely the test shape that let a real
 * SQL-assembly bug through undetected until it was caught by hand-testing a
 * live container (see the corrected root-cause note on `ph()` in
 * scope-query.ts). This file closes that gap for the scenarios that
 * actually matter: the radius boundary, the multi-listing-per-property
 * dedup case, and the matched->unmatched transition.
 *
 * Gated on POSTGRES_DSN (or the split POSTGRES_HOST/PORT/USER/PASSWORD/DB
 * vars) being set and reachable — matches the Python side's `pg_conn`
 * fixture philosophy (etl/tests/conftest.py): skip gracefully rather than
 * hard-fail when no database is available, but run for real whenever one is.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile } from "@/lib/db/profiles";
import { materializeProfile } from "../materialize";
import type { Scope } from "@/lib/profiles-schema";

const MADRID_SOL: [number, number] = [40.4168, -3.7038];

// Real distance, Puerta del Sol -> Atocha: ~1.67km (also asserted directly
// in scope-query.test.ts's Haversine trace). Used to place properties just
// inside/outside a chosen radius without hand-picked, possibly-wrong offsets.
const ATOCHA: [number, number] = [40.4066, -3.6906];

async function withRealDb(fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

// `describe.runIf` needs a plain boolean evaluated at collection time, not a
// function checked later in a lifecycle hook — a function is always truthy,
// which would make runIf always run the suite (and then fail with raw
// connection errors) regardless of whether a database is actually reachable.
// Vitest test files are ESM, so a top-level await here runs during
// collection, before `describe.runIf` reads the value.
const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[materialize.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("materializeProfile — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  // Exact IDs this test created, cleaned up by id in afterEach — never a
  // broad table-wide scan. The previous `DELETE FROM property WHERE id NOT
  // IN (SELECT property_id FROM listing)` in beforeEach was scoped to
  // nothing (any orphaned property, anywhere), which raced with
  // candidates.integration.test.ts's own test data when vitest ran both
  // files concurrently (its default file-level parallelism) — reproduced
  // directly as an intermittent cross-file foreign-key violation. Fixed
  // there with the same pattern; fixing it here too since one file's broad
  // scan can still hit the other's rows regardless of which file "owns"
  // the bug.
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

  async function insertProperty(
    pool: Pool,
    overrides: Partial<{
      lat: number;
      lon: number;
      property_type: string;
      m2_built: number;
    }> = {},
  ): Promise<number> {
    const row = {
      lat: MADRID_SOL[0],
      lon: MADRID_SOL[1],
      property_type: "piso",
      m2_built: 70,
      ...overrides,
    };
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built)
       VALUES ($1, $2, $3, $4) RETURNING id`,
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
      external_id: string;
      status: string;
      current_price: number;
    }> = {},
  ): Promise<number> {
    const row = {
      source: "fotocasa",
      external_id: `int-test-${Math.random().toString(36).slice(2)}`,
      status: "active",
      current_price: 300000,
      ...overrides,
    };
    const result = await pool.query<{ id: number }>(
      `INSERT INTO listing (property_id, source, external_id, status, current_price)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [propertyId, row.source, row.external_id, row.status, row.current_price],
    );
    return result.rows[0].id;
  }

  async function makeProfile(scope: Scope): Promise<number> {
    const profile = await createProfile(`integration-test-${Date.now()}-${Math.random()}`, scope, {});
    createdProfileIds.push(profile.id);
    return profile.id;
  }

  async function matchedRows(pool: Pool, profileId: number) {
    const { rows } = await pool.query<{ property_id: number; matched: boolean }>(
      "SELECT property_id, matched FROM profile_listing_state WHERE profile_id = $1",
      [profileId],
    );
    return rows;
  }

  it("radius boundary: a property just inside matches, just outside does not", async () => {
    await withRealDb(async (pool) => {
      // Real distance Sol -> Atocha is ~1.67km (see scope-query.test.ts's
      // Haversine trace). A 2km radius from Sol should include Atocha; a
      // 1km radius should not.
      const insideId = await insertProperty(pool, { lat: ATOCHA[0], lon: ATOCHA[1] });
      await insertListing(pool, insideId);
      const outsideId = await insertProperty(pool, { lat: 41.3874, lon: 2.1686 }); // Barcelona, ~505km away
      await insertListing(pool, outsideId);

      const wideProfileId = await makeProfile({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 2 },
        property_types: ["piso"],
        hard_exclusions: {},
      });
      const narrowProfileId = await makeProfile({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 1 },
        property_types: ["piso"],
        hard_exclusions: {},
      });

      await materializeProfile(wideProfileId);
      await materializeProfile(narrowProfileId);

      const wideMatches = (await matchedRows(pool, wideProfileId)).map((r) => r.property_id);
      const narrowMatches = (await matchedRows(pool, narrowProfileId)).map((r) => r.property_id);

      expect(wideMatches).toContain(insideId);
      expect(wideMatches).not.toContain(outsideId);
      expect(narrowMatches).not.toContain(insideId); // 1.67km > 1km radius
      expect(narrowMatches).not.toContain(outsideId);
    });
  });

  it("price filter uses MIN(current_price) across a deduplicated property's active listings", async () => {
    await withRealDb(async (pool) => {
      // One property, two listings (the post-dedup shape) at different
      // prices — the filter must key off the cheaper active listing, not
      // an arbitrary single listing.property_id row.
      const propertyId = await insertProperty(pool);
      await insertListing(pool, propertyId, { source: "fotocasa", current_price: 250000 });
      await insertListing(pool, propertyId, { source: "milanuncios", current_price: 300000 });

      const profileId = await makeProfile({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        price_max: 260000, // below the higher listing, above the lower one
        hard_exclusions: {},
      });

      await materializeProfile(profileId);

      const matches = (await matchedRows(pool, profileId)).map((r) => r.property_id);
      expect(matches).toContain(propertyId);
    });
  });

  it("matched -> unmatched transition: re-materializing after a scope narrows flips matched to false, does not delete the row", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool, { m2_built: 70 });
      await insertListing(pool, propertyId);

      const profileId = await makeProfile({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        size_min: 60,
        hard_exclusions: {},
      });

      await materializeProfile(profileId);
      let rows = await matchedRows(pool, profileId);
      expect(rows.find((r) => r.property_id === propertyId)?.matched).toBe(true);

      // Narrow the scope so the same property no longer qualifies (needs
      // size_min 80, property is 70), and re-materialize.
      await pool.query(
        "UPDATE search_profile SET scope = jsonb_set(scope, '{size_min}', '80') WHERE id = $1",
        [profileId],
      );
      await materializeProfile(profileId);

      rows = await matchedRows(pool, profileId);
      const row = rows.find((r) => r.property_id === propertyId);
      expect(row).toBeDefined(); // preserved, not deleted
      expect(row?.matched).toBe(false); // flipped, not left stale at true
    });
  });

  it("a property with no active listings never matches, even with no price band set", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      await insertListing(pool, propertyId, { status: "withdrawn" });

      const profileId = await makeProfile({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {}, // no price band — regression test for the fix above
      });

      await materializeProfile(profileId);

      const matches = (await matchedRows(pool, profileId)).map((r) => r.property_id);
      expect(matches).not.toContain(propertyId);
    });
  });
});
