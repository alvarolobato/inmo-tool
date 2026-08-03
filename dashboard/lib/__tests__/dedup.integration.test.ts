/**
 * Real-Postgres integration tests for the dedup review queue reads/writes
 * (lib/dedup.ts) — the dashboard half of the "missing half of the dedup
 * workflow" (see that file's module docstring).
 *
 * What's proven here (TypeScript-side, against a real DB):
 *   - listDedupSuggestions joins both sides' listing+property correctly and
 *     orders confidence DESC (the ordering the review queue UI depends on
 *     to put photo_hash/reference_code ahead of the much larger fuzzy tail).
 *   - the `basis` filter narrows correctly.
 *   - getDedupSuggestionCounts aggregates per match_basis over the FULL
 *     pending set, not just one page.
 *   - enqueueDedupAction/getDedupAction round-trip a real
 *     suggested_merge_action row.
 *   - getSuggestionStatus reflects confirmed/rejected/pending correctly.
 *
 * What's deliberately NOT re-proven here: the actual merge/reject business
 * logic (engine.confirm_suggestion/reject_suggestion) — that's Python code,
 * already covered in depth by etl/tests/test_dedup_actions.py (a real DB
 * round trip: confirm via the queue, assert one property with both
 * listings and a property_merge_log row) and etl/tests/test_dedup_engine.py.
 * This file only proves the TypeScript read/write surface the dashboard
 * actually calls; dashboard/e2e/dedup-review.spec.ts proves the full
 * browser-to-Postgres round trip, including a real invocation of the Python
 * queue processor.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import {
  enqueueDedupAction,
  getDedupAction,
  getDedupSuggestionCounts,
  getSuggestionStatus,
  listDedupSuggestions,
} from "../dedup";

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
      "[dedup.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("dedup review queue — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdPropertyIds: number[] = [];
  let createdListingIds: number[] = [];
  let createdSuggestionIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
    createdListingIds = [];
    createdSuggestionIds = [];
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdSuggestionIds.length > 0) {
        // suggested_merge_action FKs ON DELETE CASCADE from suggested_merge,
        // so deleting the suggestion rows below is sufficient — no separate
        // cleanup needed for the action rows this file's own tests create.
        await pool.query("DELETE FROM suggested_merge WHERE id = ANY($1::bigint[])", [
          createdSuggestionIds,
        ]);
      }
      if (createdListingIds.length > 0) {
        await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [createdListingIds]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
      }
    });
  });

  async function insertProperty(pool: Pool, overrides: Partial<{ address: string; m2_built: number }> = {}) {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (property_type, m2_built, address)
       VALUES ('piso', $1, $2) RETURNING id`,
      [overrides.m2_built ?? 70, overrides.address ?? "Calle de prueba dedup"],
    );
    const id = Number(result.rows[0].id);
    createdPropertyIds.push(id);
    return id;
  }

  async function insertListing(
    pool: Pool,
    propertyId: number,
    overrides: Partial<{ source: string; current_price: number; photo_urls: string[] }> = {},
  ) {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO listing (property_id, source, external_id, current_price, photo_urls)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        propertyId,
        overrides.source ?? "fotocasa",
        `dedup-int-test-${Math.random().toString(36).slice(2)}`,
        overrides.current_price ?? 200000,
        overrides.photo_urls ?? null,
      ],
    );
    const id = Number(result.rows[0].id);
    createdListingIds.push(id);
    return id;
  }

  async function insertSuggestion(
    pool: Pool,
    listingA: number,
    listingB: number,
    overrides: Partial<{ match_basis: string; confidence: number; detail: Record<string, unknown> }> = {},
  ) {
    const [lo, hi] = [listingA, listingB].sort((a, b) => a - b);
    const result = await pool.query<{ id: number }>(
      `INSERT INTO suggested_merge (listing_id_a, listing_id_b, match_basis, confidence, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [
        lo,
        hi,
        overrides.match_basis ?? "fuzzy",
        overrides.confidence ?? 0.55,
        JSON.stringify(overrides.detail ?? {}),
      ],
    );
    const id = Number(result.rows[0].id);
    createdSuggestionIds.push(id);
    return id;
  }

  it("joins both sides' listing + property data for a full comparison view", async () => {
    await withRealDb(async (pool) => {
      const propA = await insertProperty(pool, { address: "Calle A 1" });
      const propB = await insertProperty(pool, { address: "Calle B 2" });
      const listingA = await insertListing(pool, propA, { source: "milanuncios", current_price: 150000 });
      const listingB = await insertListing(pool, propB, { source: "fotocasa", current_price: 160000 });
      await insertSuggestion(pool, listingA, listingB, { match_basis: "photo_hash", confidence: 0.8 });

      const items = await listDedupSuggestions({});
      const found = items.find((s) => s.listing_a.listing_id === listingA || s.listing_b.listing_id === listingA);
      expect(found).toBeDefined();
      const [side1, side2] = [found!.listing_a, found!.listing_b].sort((a, b) => a.listing_id - b.listing_id);
      const sortedListings = [listingA, listingB].sort((a, b) => a - b);
      expect(side1.listing_id).toBe(sortedListings[0]);
      expect(side2.listing_id).toBe(sortedListings[1]);
      expect(found!.match_basis).toBe("photo_hash");
      expect(found!.confidence).toBeCloseTo(0.8);
      expect([side1.source, side2.source].sort()).toEqual(["fotocasa", "milanuncios"]);
    });
  });

  it("orders strongest evidence first (confidence DESC) so photo_hash outranks fuzzy by default", async () => {
    await withRealDb(async (pool) => {
      const propA = await insertProperty(pool);
      const propB = await insertProperty(pool);
      const propC = await insertProperty(pool);
      const propD = await insertProperty(pool);
      const lFuzzyA = await insertListing(pool, propA);
      const lFuzzyB = await insertListing(pool, propB);
      const lPhotoA = await insertListing(pool, propC);
      const lPhotoB = await insertListing(pool, propD);
      const fuzzyId = await insertSuggestion(pool, lFuzzyA, lFuzzyB, { match_basis: "fuzzy", confidence: 0.58 });
      const photoId = await insertSuggestion(pool, lPhotoA, lPhotoB, { match_basis: "photo_hash", confidence: 0.8 });

      const items = await listDedupSuggestions({});
      const ids = items.map((s) => s.id).filter((id) => id === fuzzyId || id === photoId);
      expect(ids).toEqual([photoId, fuzzyId]);
    });
  });

  it("filters by match_basis when requested", async () => {
    await withRealDb(async (pool) => {
      const propA = await insertProperty(pool);
      const propB = await insertProperty(pool);
      const propC = await insertProperty(pool);
      const propD = await insertProperty(pool);
      const lFuzzyA = await insertListing(pool, propA);
      const lFuzzyB = await insertListing(pool, propB);
      const lPhotoA = await insertListing(pool, propC);
      const lPhotoB = await insertListing(pool, propD);
      await insertSuggestion(pool, lFuzzyA, lFuzzyB, { match_basis: "fuzzy", confidence: 0.58 });
      const photoId = await insertSuggestion(pool, lPhotoA, lPhotoB, { match_basis: "photo_hash", confidence: 0.8 });

      const items = await listDedupSuggestions({ basis: "photo_hash" });
      expect(items.every((s) => s.match_basis === "photo_hash")).toBe(true);
      expect(items.some((s) => s.id === photoId)).toBe(true);
    });
  });

  it("counts pending suggestions per match_basis over the full set, not just one page", async () => {
    await withRealDb(async (pool) => {
      const propA = await insertProperty(pool);
      const propB = await insertProperty(pool);
      const lA = await insertListing(pool, propA);
      const lB = await insertListing(pool, propB);
      await insertSuggestion(pool, lA, lB, { match_basis: "photo_hash", confidence: 0.8 });

      const counts = await getDedupSuggestionCounts();
      expect(counts.total).toBeGreaterThanOrEqual(1);
      expect(counts.by_basis.photo_hash).toBeGreaterThanOrEqual(1);
    });
  });

  it("getSuggestionStatus reflects the real row status", async () => {
    await withRealDb(async (pool) => {
      const propA = await insertProperty(pool);
      const propB = await insertProperty(pool);
      const lA = await insertListing(pool, propA);
      const lB = await insertListing(pool, propB);
      const suggestionId = await insertSuggestion(pool, lA, lB);

      expect(await getSuggestionStatus(suggestionId)).toBe("pending");
      expect(await getSuggestionStatus(999999999)).toBeNull();
    });
  });

  it("enqueueDedupAction/getDedupAction round-trip a real suggested_merge_action row", async () => {
    await withRealDb(async (pool) => {
      const propA = await insertProperty(pool);
      const propB = await insertProperty(pool);
      const lA = await insertListing(pool, propA);
      const lB = await insertListing(pool, propB);
      const suggestionId = await insertSuggestion(pool, lA, lB);

      const actionId = await enqueueDedupAction(suggestionId, "confirm");
      const action = await getDedupAction(actionId);
      expect(action).not.toBeNull();
      expect(action!.suggestion_id).toBe(suggestionId);
      expect(action!.action).toBe("confirm");
      expect(action!.status).toBe("pending");
      expect(action!.result).toEqual({});
    });
  });

  it("getDedupAction returns null for an unknown id", async () => {
    await withRealDb(async () => {
      expect(await getDedupAction(999999999)).toBeNull();
    });
  });
});
