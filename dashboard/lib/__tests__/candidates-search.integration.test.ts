/**
 * Real-Postgres integration test for the #470 free-text search backend
 * (Phase 1). The whole point of this issue's design is a doc that is BUILT and
 * KEPT FRESH by database triggers across three tables (property + active
 * listings + latest-per-axis ai_assessment), then queried as one more filter in
 * the feed — none of which a mocked query can prove. So this test drives the
 * real triggers and the real GIN-indexed `@@` against a live database:
 *
 *  - a listing INSERT builds `property_search_doc.doc` (trigger), and
 *    `listCandidates({ q })` narrows to properties whose ad text matches;
 *  - the doc also matches the address (unaccent: "malaga" ≈ "Málaga"), the
 *    portal slug, and assessment-derived codes AND their Spanish labels;
 *  - a description UPDATE refreshes the doc (search finds the new text);
 *  - an empty/absent `q` is a byte-identical no-op, and `q` never breaks the
 *    keyset cursor;
 *  - the one-time idempotent backfill repopulates a missing doc row.
 *
 * Gating + exact-id cleanup mirror candidates.integration.test.ts (see that
 * file's header for the per-run-DB + cross-file-parallelism rationale). The
 * coordinates are deliberately distinct from that file's and materialize's.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile } from "@/lib/db/profiles";
import { listCandidates } from "../candidates";
import type { Scope } from "@/lib/profiles-schema";

// ~Marbella (Málaga) — far from candidates.integration.test.ts (Madrid outskirts)
// and materialize.integration.test.ts (Sol/Atocha), so no cross-file radius scan
// can pick up this file's properties when vitest runs the files in parallel.
const TEST_COORDS: [number, number] = [36.5108, -4.8856];

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
      "[candidates-search.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("free-text search (#470) — real Postgres", () => {
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
      if (createdPropertyIds.length > 0) {
        // property_search_doc FKs property with ON DELETE CASCADE, so deleting
        // property clears it — but assessment/listing/pls must go first (they
        // FK property too), same ordering as candidates.integration.test.ts.
        await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE profile_id = ANY($1::bigint[])", [
          createdProfileIds,
        ]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [
          createdProfileIds,
        ]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
      }
    });
  });

  async function insertProperty(pool: Pool, address: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
      [TEST_COORDS[0], TEST_COORDS[1], address],
    );
    const id = Number(result.rows[0].id);
    createdPropertyIds.push(id);
    return id;
  }

  async function insertListing(
    pool: Pool,
    propertyId: number,
    overrides: Partial<{ source: string; description: string | null }> = {},
  ): Promise<number> {
    const row = { source: "fotocasa", description: null as string | null, ...overrides };
    const result = await pool.query<{ id: number }>(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, description)
       VALUES ($1, $2, $3, 'active', 'sale', 285000, NOW(), $4) RETURNING id`,
      [propertyId, row.source, `search-int-${Math.random().toString(36).slice(2)}`, row.description],
    );
    return Number(result.rows[0].id);
  }

  async function makeProfile(): Promise<number> {
    const scope: Scope = {
      geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
      property_types: ["piso"],
      hard_exclusions: {},
    };
    const profile = await createProfile(
      `search-int-test-${Date.now()}-${Math.random()}`,
      scope,
      {},
    );
    createdProfileIds.push(profile.id);
    return profile.id;
  }

  async function markMatched(pool: Pool, profileId: number, propertyId: number) {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched)
       VALUES ($1, $2, true)
       ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = true`,
      [profileId, propertyId],
    );
  }

  async function docFor(pool: Pool, propertyId: number): Promise<string | null> {
    const r = await pool.query<{ doc: string }>(
      "SELECT doc::text AS doc FROM property_search_doc WHERE property_id = $1",
      [propertyId],
    );
    return r.rows[0]?.doc ?? null;
  }

  it("builds the doc on listing insert and narrows the feed to the ad text", async () => {
    await withRealDb(async (pool) => {
      const withTerrace = await insertProperty(pool, "Calle Larios, Marbella");
      await insertListing(pool, withTerrace, {
        description: "Bonito piso con terraza soleada y vistas despejadas.",
      });
      const withoutTerrace = await insertProperty(pool, "Avenida del Mar, Marbella");
      await insertListing(pool, withoutTerrace, {
        description: "Piso interior reformado, sin exteriores.",
      });
      const profileId = await makeProfile();
      await markMatched(pool, profileId, withTerrace);
      await markMatched(pool, profileId, withoutTerrace);

      // The trigger populated a doc for each property on listing insert.
      expect(await docFor(pool, withTerrace)).not.toBeNull();
      expect(await docFor(pool, withoutTerrace)).not.toBeNull();

      // No q → both come back (byte-identical no-op path).
      const all = await listCandidates(profileId);
      expect(all.items.map((i) => i.property_id).sort()).toEqual(
        [withTerrace, withoutTerrace].sort(),
      );

      // q='terraza' → only the property whose ad mentions it. Spanish stemming
      // also means 'terrazas' would match the same row.
      const hit = await listCandidates(profileId, { q: "terraza" });
      expect(hit.items.map((i) => i.property_id)).toEqual([withTerrace]);
    });
  });

  it("matches the address with unaccent folding (malaga ≈ Málaga)", async () => {
    await withRealDb(async (pool) => {
      const p = await insertProperty(pool, "Paseo Marítimo, Málaga");
      await insertListing(pool, p, { description: "Piso céntrico." });
      const profileId = await makeProfile();
      await markMatched(pool, profileId, p);

      const hit = await listCandidates(profileId, { q: "malaga" });
      expect(hit.items.map((i) => i.property_id)).toEqual([p]);
    });
  });

  it("matches the portal slug and assessment-derived codes AND Spanish labels", async () => {
    await withRealDb(async (pool) => {
      const p = await insertProperty(pool, "Calle Sierra, Marbella");
      await insertListing(pool, p, { source: "idealista", description: "Vivienda amplia." });
      // Latest occupancy row with an English caveat code → the doc carries both
      // the raw code ("tenanted") and its card label ("alquilado").
      await pool.query(
        `INSERT INTO ai_assessment (property_id, assessment_type, result, prompt_version, generated_at)
         VALUES ($1, 'occupancy', $2::jsonb, 'v1', NOW())`,
        [p, JSON.stringify({ occupancy: { value: "tenanted" }, caveats: ["tenanted"] })],
      );
      const profileId = await makeProfile();
      await markMatched(pool, profileId, p);

      // portal slug (weight C)
      expect((await listCandidates(profileId, { q: "idealista" })).items.map((i) => i.property_id)).toEqual([p]);
      // the raw English code
      expect((await listCandidates(profileId, { q: "tenanted" })).items.map((i) => i.property_id)).toEqual([p]);
      // the Spanish label the card shows
      expect((await listCandidates(profileId, { q: "alquilado" })).items.map((i) => i.property_id)).toEqual([p]);
    });
  });

  it("refreshes the doc when a description is updated", async () => {
    await withRealDb(async (pool) => {
      const p = await insertProperty(pool, "Calle Nueva, Marbella");
      const listingId = await insertListing(pool, p, { description: "Piso a reformar." });
      const profileId = await makeProfile();
      await markMatched(pool, profileId, p);

      // Not there yet.
      expect((await listCandidates(profileId, { q: "chimenea" })).items).toHaveLength(0);

      await pool.query("UPDATE listing SET description = $2 WHERE id = $1", [
        listingId,
        "Piso con chimenea y suelos de madera.",
      ]);

      // The UPDATE OF description trigger recomputed the doc.
      expect((await listCandidates(profileId, { q: "chimenea" })).items.map((i) => i.property_id)).toEqual([p]);
    });
  });

  it("returns an empty feed (no error) for a query that matches nothing", async () => {
    await withRealDb(async (pool) => {
      const p = await insertProperty(pool, "Calle Corta, Marbella");
      await insertListing(pool, p, { description: "Piso normal." });
      const profileId = await makeProfile();
      await markMatched(pool, profileId, p);

      const page = await listCandidates(profileId, { q: "zzz-inexistente-xyz" });
      expect(page.items).toHaveLength(0);
      expect(page.nextCursor).toBeNull();
    });
  });

  it("keeps the keyset cursor intact when q is active (no gaps or duplicates)", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile();
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await insertProperty(pool, `Calle Piscina ${i}, Marbella`);
        // All three share the search term so q keeps all three in the feed.
        await insertListing(pool, id, { description: `Piso con piscina comunitaria ${i}.` });
        await markMatched(pool, profileId, id);
        ids.push(id);
      }

      const first = await listCandidates(profileId, { q: "piscina", limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await listCandidates(profileId, {
        q: "piscina",
        cursor: first.nextCursor,
        limit: 2,
      });
      const seen = [...first.items, ...second.items].map((i) => i.property_id);
      // All three, once each — the FTS filter didn't corrupt keyset paging.
      expect(new Set(seen).size).toBe(3);
      expect(seen.slice().sort()).toEqual(ids.slice().sort());
    });
  });

  it("backfills a missing doc row idempotently (the one-time init.sql block)", async () => {
    await withRealDb(async (pool) => {
      const p = await insertProperty(pool, "Calle Backfill, Marbella");
      await insertListing(pool, p, { description: "Piso con garaje y trastero." });

      // Simulate a pre-existing property whose doc was never built (predates the
      // feature). Delete it, then run the exact idempotent backfill init.sql ships.
      await pool.query("DELETE FROM property_search_doc WHERE property_id = $1", [p]);
      expect(await docFor(pool, p)).toBeNull();

      const backfill = `
        DO $$
        DECLARE r RECORD;
        BEGIN
          FOR r IN
            SELECT p.id FROM property p
             WHERE NOT EXISTS (SELECT 1 FROM property_search_doc d WHERE d.property_id = p.id)
          LOOP
            PERFORM refresh_property_search_doc(r.id);
          END LOOP;
        END $$;`;
      await pool.query(backfill);
      const afterFirst = await docFor(pool, p);
      expect(afterFirst).not.toBeNull();

      // Re-running is a no-op (WHERE NOT EXISTS skips the now-populated row).
      await pool.query(backfill);
      expect(await docFor(pool, p)).toBe(afterFirst);

      const profileId = await makeProfile();
      await markMatched(pool, profileId, p);
      expect((await listCandidates(profileId, { q: "garaje" })).items.map((i) => i.property_id)).toEqual([p]);
    });
  });
});
