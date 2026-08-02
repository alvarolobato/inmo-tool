/**
 * Real-Postgres integration test for the map view's data layer (task 2.7,
 * #43). Complements e2e/map.spec.ts (browser-level Leaflet rendering) with
 * a fast, non-browser check of the query itself: grouping, the
 * lat/lon-null unplottable-count split (EC-2), and pipeline_stage passing
 * through correctly for stage filtering.
 *
 * Coordinates are deliberately distinct from candidates.integration.test.ts
 * (40.5668, -3.7038) and materialize.integration.test.ts (Sol/Atocha,
 * ~40.41,-3.70) — vitest runs test files in separate workers by default,
 * all against the same live Postgres, and this project has already hit a
 * real cross-file FK collision from reusing coordinates (see
 * candidates.integration.test.ts's file header).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile } from "@/lib/db/profiles";
import { listMapCandidates } from "../map-candidates";
import type { Scope } from "@/lib/profiles-schema";

const TEST_COORDS: [number, number] = [40.2, -3.95];

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
      "[map-candidates.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("listMapCandidates — real Postgres", () => {
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

  async function insertProperty(pool: Pool, coords: [number, number] | null): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', 65, 'Map test address') RETURNING id`,
      [coords?.[0] ?? null, coords?.[1] ?? null],
    );
    const id = Number(result.rows[0].id);
    createdPropertyIds.push(id);
    return id;
  }

  async function insertListing(
    pool: Pool,
    propertyId: number,
    overrides: Partial<{ source: string; status: string; current_price: number }> = {},
  ): Promise<void> {
    const row = { source: "fotocasa", status: "active", current_price: 300000, ...overrides };
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [propertyId, row.source, `map-int-test-${Math.random().toString(36).slice(2)}`, row.status, row.current_price],
    );
  }

  async function makeProfile(scope: Scope): Promise<number> {
    const profile = await createProfile(`map-candidates-int-test-${Date.now()}-${Math.random()}`, scope, {});
    createdProfileIds.push(profile.id);
    return profile.id;
  }

  async function markMatched(pool: Pool, profileId: number, propertyId: number, stage = "new") {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched, pipeline_stage)
       VALUES ($1, $2, true, $3)
       ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = true, pipeline_stage = $3`,
      [profileId, propertyId, stage],
    );
  }

  const SCOPE: Scope = {
    geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
    property_types: ["piso"],
    hard_exclusions: {},
  };

  it("excludes matched properties with null lat/lon from items and counts them separately (EC-2)", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile(SCOPE);
      const plottableId = await insertProperty(pool, TEST_COORDS);
      await insertListing(pool, plottableId);
      await markMatched(pool, profileId, plottableId);

      const unplottableId = await insertProperty(pool, null);
      await insertListing(pool, unplottableId);
      await markMatched(pool, profileId, unplottableId);

      const result = await listMapCandidates(profileId);
      expect(result.items.map((i) => i.property_id)).toEqual([plottableId]);
      expect(result.unplottableCount).toBe(1);
      expect(result.truncated).toBe(false);
    });
  });

  it("returns pipeline_stage and numeric lat/lon (not strings)", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile(SCOPE);
      const propertyId = await insertProperty(pool, TEST_COORDS);
      await insertListing(pool, propertyId);
      await markMatched(pool, profileId, propertyId, "interested");

      const result = await listMapCandidates(profileId);
      expect(result.items).toHaveLength(1);
      const [item] = result.items;
      expect(item.pipeline_stage).toBe("interested");
      expect(typeof item.lat).toBe("number");
      expect(typeof item.lon).toBe("number");
      expect(item.lat).toBeCloseTo(TEST_COORDS[0], 4);
      expect(item.lon).toBeCloseTo(TEST_COORDS[1], 4);
    });
  });

  it("groups a deduplicated property's two listings into one row and prices from active listings only", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile(SCOPE);
      const propertyId = await insertProperty(pool, TEST_COORDS);
      await insertListing(pool, propertyId, { source: "fotocasa", current_price: 300000 });
      await insertListing(pool, propertyId, { source: "milanuncios", current_price: 295000 });
      await insertListing(pool, propertyId, { source: "idealista", status: "withdrawn", current_price: 50000 });
      await markMatched(pool, profileId, propertyId);

      const result = await listMapCandidates(profileId);
      expect(result.items).toHaveLength(1);
      const [item] = result.items;
      expect(item.listings).toHaveLength(2);
      expect(item.min_price).toBe(295000);
    });
  });

  it("never lets unplottable rows crowd out plottable ones regardless of insertion order (regression)", async () => {
    // A prior version applied `LIMIT` before excluding null-coordinate rows
    // in application code, ordered by `p.id DESC` — so unplottable rows
    // inserted *after* a plottable one (higher id, sorted first) could
    // occupy the LIMIT budget and silently drop real plottable candidates.
    // The fix moved the lat/lon-not-null check into the SQL WHERE clause,
    // which is a structural guarantee independent of row counts — this test
    // proves the invariant at a small, fast scale, not by reproducing the
    // full MAX_MAP_CANDIDATES threshold.
    await withRealDb(async (pool) => {
      const profileId = await makeProfile(SCOPE);

      const plottableId = await insertProperty(pool, TEST_COORDS);
      await insertListing(pool, plottableId);
      await markMatched(pool, profileId, plottableId);

      // Inserted after the plottable row, so each has a higher id and
      // sorts first under `ORDER BY p.id DESC`.
      for (let i = 0; i < 10; i++) {
        const unplottableId = await insertProperty(pool, null);
        await insertListing(pool, unplottableId);
        await markMatched(pool, profileId, unplottableId);
      }

      const result = await listMapCandidates(profileId);
      expect(result.items.map((i) => i.property_id)).toEqual([plottableId]);
      expect(result.unplottableCount).toBe(10);
    });
  });

  it("excludes properties not matched for this profile", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile(SCOPE);
      const propertyId = await insertProperty(pool, TEST_COORDS);
      await insertListing(pool, propertyId);
      // Not marked matched at all.

      const result = await listMapCandidates(profileId);
      expect(result.items).toHaveLength(0);
      expect(result.unplottableCount).toBe(0);
    });
  });
});
