/**
 * Real-Postgres integration test for the candidate feed (task 2.5, #19).
 *
 * The one thing worth proving against a real database rather than a mock:
 * a property with two linked `listing` rows (the actual post-dedup shape
 * task 2.2 produces) comes back as ONE candidate row with two grouped
 * listings — not two separate rows. A mocked-query unit test can assert the
 * SQL text looks right; it can't catch a JOIN that silently fans out into
 * duplicate rows, which is exactly the bug class issue #19 exists to avoid
 * ("never one card per listing"). Same gating pattern as
 * lib/filtering/__tests__/materialize.integration.test.ts.
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile } from "@/lib/db/profiles";
import { listCandidates } from "../candidates";
import type { Scope } from "@/lib/profiles-schema";

const MADRID_SOL: [number, number] = [40.4168, -3.7038];

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
      "[candidates.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("listCandidates — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  async function insertProperty(pool: Pool): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', 70, 'Calle Trafalgar, Chamberí, Madrid') RETURNING id`,
      [MADRID_SOL[0], MADRID_SOL[1]],
    );
    return result.rows[0].id;
  }

  async function insertListing(
    pool: Pool,
    propertyId: number,
    overrides: Partial<{ source: string; status: string; current_price: number }> = {},
  ): Promise<number> {
    const row = {
      source: "fotocasa",
      status: "active",
      current_price: 285000,
      ...overrides,
    };
    const result = await pool.query<{ id: number }>(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
      [propertyId, row.source, `int-test-${Math.random().toString(36).slice(2)}`, row.status, row.current_price],
    );
    return result.rows[0].id;
  }

  async function makeProfile(scope: Scope): Promise<number> {
    const profile = await createProfile(`candidates-int-test-${Date.now()}-${Math.random()}`, scope, {});
    return profile.id;
  }

  async function markMatched(pool: Pool, profileId: number, propertyId: number, matched = true) {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched)
       VALUES ($1, $2, $3)
       ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = $3`,
      [profileId, propertyId, matched],
    );
  }

  beforeEach(async () => {
    await withRealDb(async (pool) => {
      await pool.query(
        "DELETE FROM profile_listing_state WHERE profile_id IN " +
          "(SELECT id FROM search_profile WHERE name LIKE 'candidates-int-test-%')",
      );
      await pool.query("DELETE FROM search_profile WHERE name LIKE 'candidates-int-test-%'");
      await pool.query("DELETE FROM listing WHERE external_id LIKE 'int-test-%'");
      await pool.query("DELETE FROM property WHERE id NOT IN (SELECT property_id FROM listing)");
    });
  });

  const SCOPE: Scope = {
    geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
    property_types: ["piso"],
    hard_exclusions: {},
  };

  it("groups a deduplicated property's two listings into a single candidate row", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      await insertListing(pool, propertyId, { source: "fotocasa", current_price: 285000 });
      await insertListing(pool, propertyId, { source: "milanuncios", current_price: 279000 });
      const profileId = await makeProfile(SCOPE);
      await markMatched(pool, profileId, propertyId);

      const page = await listCandidates(profileId);

      expect(page.items).toHaveLength(1);
      expect(page.items[0].property_id).toBe(propertyId);
      expect(page.items[0].listings).toHaveLength(2);
      expect(page.items[0].listings.map((l) => l.source).sort()).toEqual(["fotocasa", "milanuncios"]);
      // MIN(current_price) across active listings — same convention as
      // task 2.4's price-band filter, documented in data-model.md.
      expect(page.items[0].min_price).toBe(279000);
    });
  });

  it("excludes properties with matched=false (stale, per task 2.4's convention)", async () => {
    await withRealDb(async (pool) => {
      const matchedId = await insertProperty(pool);
      await insertListing(pool, matchedId);
      const unmatchedId = await insertProperty(pool);
      await insertListing(pool, unmatchedId);
      const profileId = await makeProfile(SCOPE);
      await markMatched(pool, profileId, matchedId, true);
      await markMatched(pool, profileId, unmatchedId, false);

      const page = await listCandidates(profileId);

      expect(page.items.map((i) => i.property_id)).toEqual([matchedId]);
    });
  });

  it("paginates with a stable keyset cursor across two pages with no gaps or duplicates", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile(SCOPE);
      const propertyIds: number[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await insertProperty(pool);
        await insertListing(pool, id);
        await markMatched(pool, profileId, id);
        propertyIds.push(id);
      }

      const firstPage = await listCandidates(profileId, { limit: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = await listCandidates(profileId, { cursor: firstPage.nextCursor, limit: 2 });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.nextCursor).toBeNull();

      const seen = [...firstPage.items, ...secondPage.items].map((i) => i.property_id).sort();
      expect(seen).toEqual([...propertyIds].sort((a, b) => a - b));
    });
  });
});
