/**
 * Real-Postgres integration tests for the dedup review queue reads/writes
 * (lib/dedup.ts) — the dashboard half of the "missing half of the dedup
 * workflow" (see that file's module docstring).
 *
 * What's proven here (TypeScript-side, against a real DB):
 *   - listDedupPropertyPairSuggestions groups every pending suggested_merge
 *     row by PROPERTY pair (issue #605 Part 2), joins both sides'
 *     listing+property data correctly, normalizes each evidence row to the
 *     group's canonical (lo, hi) property order regardless of which side
 *     `listing_id_a`/`listing_id_b` recorded, and leads with the strongest
 *     evidence (confidence DESC).
 *   - the `basis` filter narrows to GROUPS containing that basis while
 *     keeping each group's FULL evidence; `onlyProfileRelevant` hard-filters
 *     on a group-level bool_or; profile-relevant groups sort first by
 *     default (issue #246, preserved from the pre-#605 flat view); the
 *     default view hides nothing; an archived profile or matched=false
 *     state never confers relevance.
 *   - issue #605 Part 1's same-property exclusion holds in the grouped view
 *     too — a pair whose two listings already share a property_id never
 *     forms (or joins) a group.
 *   - getDedupPropertyPairCounts counts distinct GROUPS, not underlying
 *     rows, and `by_basis` is basis-membership (can sum above `total`).
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
  getDedupPropertyPairCounts,
  getSuggestionStatus,
  listDedupPropertyPairSuggestions,
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
  let createdProfileIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
    createdListingIds = [];
    createdSuggestionIds = [];
    createdProfileIds = [];
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
      // profile_listing_state FKs both property_id and profile_id — delete it
      // before the property and search_profile rows it references.
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE profile_id = ANY($1::bigint[])", [
          createdProfileIds,
        ]);
      }
      if (createdListingIds.length > 0) {
        await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [createdListingIds]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [createdProfileIds]);
      }
    });
  });

  /** Create a search profile. `archived` toggles archived_at so a test can
   * prove archived profiles never confer relevance. */
  async function insertProfile(pool: Pool, overrides: { archived?: boolean } = {}) {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO search_profile (name, scope, archived_at)
       VALUES ('dedup-int-profile', '{}'::jsonb, $1) RETURNING id`,
      [overrides.archived ? new Date() : null],
    );
    const id = Number(result.rows[0].id);
    createdProfileIds.push(id);
    return id;
  }

  /** Materialize a property as matching (or not) a profile — the exact signal
   * profile-relevance reads (profile_listing_state.matched). */
  async function markProfileMatch(pool: Pool, profileId: number, propertyId: number, matched = true) {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched)
       VALUES ($1, $2, $3)
       ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = EXCLUDED.matched`,
      [profileId, propertyId, matched],
    );
  }

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

  describe("grouped by property pair (issue #605 Part 2)", () => {
    it("collapses every pending listing-pair row for the same two properties into ONE group", async () => {
      await withRealDb(async (pool) => {
        // Property A has 2 listings, property B has 2 listings — up to 4
        // listing-pair rows could exist for this one property pair. Insert
        // 3 of them (the #600 pattern, at a small scale).
        const propA = await insertProperty(pool, { address: "Calle A" });
        const propB = await insertProperty(pool, { address: "Calle B" });
        const a1 = await insertListing(pool, propA, { source: "fotocasa" });
        const a2 = await insertListing(pool, propA, { source: "milanuncios" });
        const b1 = await insertListing(pool, propB, { source: "idealista" });
        const b2 = await insertListing(pool, propB, { source: "pisos" });
        const s1 = await insertSuggestion(pool, a1, b1, { match_basis: "fuzzy", confidence: 0.6 });
        const s2 = await insertSuggestion(pool, a2, b1, { match_basis: "photo_hash", confidence: 0.8 });
        const s3 = await insertSuggestion(pool, a1, b2, { match_basis: "phone", confidence: 0.75 });

        // An unrelated pair, so the test can't pass by collapsing everything.
        const propC = await insertProperty(pool);
        const propD = await insertProperty(pool);
        const c1 = await insertListing(pool, propC);
        const d1 = await insertListing(pool, propD);
        const otherId = await insertSuggestion(pool, c1, d1, { match_basis: "phone", confidence: 0.75 });

        const groups = await listDedupPropertyPairSuggestions({ limit: 100 });
        const [lo, hi] = [propA, propB].sort((x, y) => x - y);
        const group = groups.find((g) => g.property_lo_id === lo && g.property_hi_id === hi);
        expect(group).toBeDefined();
        expect(group!.pair_count).toBe(3);
        expect(group!.pair_key).toBe(`${lo}-${hi}`);
        const evidenceIds = new Set(group!.evidence.map((e) => e.suggestion_id));
        expect(evidenceIds).toEqual(new Set([s1, s2, s3]));

        const otherGroup = groups.find(
          (g) => g.property_lo_id === Math.min(propC, propD) && g.property_hi_id === Math.max(propC, propD),
        );
        expect(otherGroup).toBeDefined();
        expect(otherGroup!.pair_count).toBe(1);
        expect(otherGroup!.evidence.map((e) => e.suggestion_id)).toEqual([otherId]);
      });
    });

    it("leads with the strongest evidence (top_confidence/top_match_basis) and sorts evidence strongest-first", async () => {
      await withRealDb(async (pool) => {
        const propA = await insertProperty(pool);
        const propB = await insertProperty(pool);
        const lA1 = await insertListing(pool, propA);
        const lA2 = await insertListing(pool, propA);
        const lB1 = await insertListing(pool, propB);
        const weak = await insertSuggestion(pool, lA1, lB1, { match_basis: "fuzzy", confidence: 0.6 });
        const strong = await insertSuggestion(pool, lA2, lB1, { match_basis: "photo_hash", confidence: 0.9 });

        const groups = await listDedupPropertyPairSuggestions({ limit: 100 });
        const [lo, hi] = [propA, propB].sort((x, y) => x - y);
        const group = groups.find((g) => g.property_lo_id === lo && g.property_hi_id === hi)!;
        expect(group.top_confidence).toBeCloseTo(0.9);
        expect(group.top_match_basis).toBe("photo_hash");
        expect(group.evidence.map((e) => e.suggestion_id)).toEqual([strong, weak]);
      });
    });

    it("normalizes every evidence row's sides to the group's canonical (lo, hi) property order regardless of listing_id_a/b order", async () => {
      await withRealDb(async (pool) => {
        // propLo is created first (so it gets the lower property id — the
        // canonical "lo" side), but its LISTING is deliberately created
        // SECOND, after propHi's listing — so insertSuggestion (which sorts
        // (listing_id_a, listing_id_b) by ascending LISTING id, independent
        // of property id) stores listing_id_a as the HI-property listing.
        // This is the adversarial case: la.property_id === prop_hi, not
        // prop_lo — a naive "a is always lo" assumption would fail here.
        const propLo = await insertProperty(pool, { address: "Lo side" });
        const propHi = await insertProperty(pool, { address: "Hi side" });
        const lHi = await insertListing(pool, propHi);
        const lLo = await insertListing(pool, propLo);
        expect(propLo).toBeLessThan(propHi);
        expect(lHi).toBeLessThan(lLo); // listing_id_a will be lHi, from the HI property

        await insertSuggestion(pool, lLo, lHi, { match_basis: "photo_hash", confidence: 0.85 });

        const groups = await listDedupPropertyPairSuggestions({ limit: 100 });
        const group = groups.find((g) => g.property_lo_id === propLo && g.property_hi_id === propHi)!;
        expect(group).toBeDefined();
        const ev = group.evidence[0];
        expect(ev.listing_lo.listing_id).toBe(lLo);
        expect(ev.listing_lo.property_id).toBe(propLo);
        expect(ev.listing_hi.listing_id).toBe(lHi);
        expect(ev.listing_hi.property_id).toBe(propHi);
      });
    });

    it("never groups a same-property pair — Part 1's exclusion holds in the grouped view too", async () => {
      await withRealDb(async (pool) => {
        const sharedProperty = await insertProperty(pool);
        const lA = await insertListing(pool, sharedProperty);
        const lB = await insertListing(pool, sharedProperty);
        await insertSuggestion(pool, lA, lB, { match_basis: "photo_hash", confidence: 0.95 });

        const groups = await listDedupPropertyPairSuggestions({ limit: 100 });
        expect(groups.some((g) => g.property_lo_id === sharedProperty || g.property_hi_id === sharedProperty)).toBe(
          false,
        );
      });
    });

    it("basis filter narrows to groups containing that basis, but keeps the group's FULL evidence (all bases)", async () => {
      await withRealDb(async (pool) => {
        const propA = await insertProperty(pool);
        const propB = await insertProperty(pool);
        const lA1 = await insertListing(pool, propA);
        const lA2 = await insertListing(pool, propA);
        const lB1 = await insertListing(pool, propB);
        const fuzzyId = await insertSuggestion(pool, lA1, lB1, { match_basis: "fuzzy", confidence: 0.6 });
        const photoId = await insertSuggestion(pool, lA2, lB1, { match_basis: "photo_hash", confidence: 0.9 });

        // A fuzzy-only group, which the photo_hash filter must exclude.
        const propC = await insertProperty(pool);
        const propD = await insertProperty(pool);
        const lC = await insertListing(pool, propC);
        const lD = await insertListing(pool, propD);
        await insertSuggestion(pool, lC, lD, { match_basis: "fuzzy", confidence: 0.55 });

        const filtered = await listDedupPropertyPairSuggestions({ basis: "photo_hash", limit: 100 });
        const [lo, hi] = [propA, propB].sort((x, y) => x - y);
        const group = filtered.find((g) => g.property_lo_id === lo && g.property_hi_id === hi);
        expect(group).toBeDefined();
        // Full evidence — the fuzzy sibling row is NOT dropped by the filter.
        expect(new Set(group!.evidence.map((e) => e.suggestion_id))).toEqual(new Set([fuzzyId, photoId]));

        const fuzzyOnlyGroup = filtered.find(
          (g) => g.property_lo_id === Math.min(propC, propD) && g.property_hi_id === Math.max(propC, propD),
        );
        expect(fuzzyOnlyGroup).toBeUndefined();
      });
    });

    it("profile relevance is bool_or across the group's evidence, and the toggle hard-filters groups", async () => {
      await withRealDb(async (pool) => {
        const profile = await insertProfile(pool);
        const propA = await insertProperty(pool);
        const propB = await insertProperty(pool);
        const lA1 = await insertListing(pool, propA);
        const lA2 = await insertListing(pool, propA);
        const lB1 = await insertListing(pool, propB);
        await markProfileMatch(pool, profile, propA);
        await insertSuggestion(pool, lA1, lB1, { match_basis: "fuzzy", confidence: 0.6 });
        await insertSuggestion(pool, lA2, lB1, { match_basis: "photo_hash", confidence: 0.9 });

        const propC = await insertProperty(pool);
        const propD = await insertProperty(pool);
        const lC = await insertListing(pool, propC);
        const lD = await insertListing(pool, propD);
        await insertSuggestion(pool, lC, lD, { match_basis: "fuzzy", confidence: 0.55 });

        const [lo, hi] = [propA, propB].sort((x, y) => x - y);
        const all = await listDedupPropertyPairSuggestions({ limit: 100 });
        const group = all.find((g) => g.property_lo_id === lo && g.property_hi_id === hi)!;
        expect(group.profile_relevant).toBe(true);

        const filtered = await listDedupPropertyPairSuggestions({ onlyProfileRelevant: true, limit: 100 });
        expect(filtered.some((g) => g.property_lo_id === lo && g.property_hi_id === hi)).toBe(true);
        expect(
          filtered.some(
            (g) => g.property_lo_id === Math.min(propC, propD) && g.property_hi_id === Math.max(propC, propD),
          ),
        ).toBe(false);
      });
    });

    it("getDedupPropertyPairCounts counts distinct GROUPS, not underlying rows", async () => {
      await withRealDb(async (pool) => {
        const propA = await insertProperty(pool);
        const propB = await insertProperty(pool);
        const lA1 = await insertListing(pool, propA);
        const lA2 = await insertListing(pool, propA);
        const lA3 = await insertListing(pool, propA);
        const lB1 = await insertListing(pool, propB);
        // 3 listing-pair rows for ONE property pair.
        await insertSuggestion(pool, lA1, lB1, { match_basis: "photo_hash", confidence: 0.9 });
        await insertSuggestion(pool, lA2, lB1, { match_basis: "photo_hash", confidence: 0.85 });
        await insertSuggestion(pool, lA3, lB1, { match_basis: "fuzzy", confidence: 0.6 });

        const propC = await insertProperty(pool);
        const propD = await insertProperty(pool);
        const lC = await insertListing(pool, propC);
        const lD = await insertListing(pool, propD);
        await insertSuggestion(pool, lC, lD, { match_basis: "phone", confidence: 0.75 });

        const counts = await getDedupPropertyPairCounts();
        // 2 groups total, not 4 underlying rows.
        expect(counts.total).toBe(2);
        // photo_hash and fuzzy both appear in the SAME group (A-B), so both
        // buckets count that one group — by_basis is membership, not a
        // mutually-exclusive partition, so this can (and does) sum above total.
        expect(counts.by_basis.photo_hash).toBe(1);
        expect(counts.by_basis.fuzzy).toBe(1);
        expect(counts.by_basis.phone).toBe(1);
      });
    });

    it("sorts profile-relevant groups first — even ahead of a higher-confidence non-relevant group (issue #246, preserved at the grouped level)", async () => {
      await withRealDb(async (pool) => {
        const profile = await insertProfile(pool);

        const relA = await insertProperty(pool);
        const relB = await insertProperty(pool);
        const lRelA = await insertListing(pool, relA);
        const lRelB = await insertListing(pool, relB);
        await markProfileMatch(pool, profile, relA);
        await insertSuggestion(pool, lRelA, lRelB, { match_basis: "fuzzy", confidence: 0.55 });

        const irrA = await insertProperty(pool);
        const irrB = await insertProperty(pool);
        const lIrrA = await insertListing(pool, irrA);
        const lIrrB = await insertListing(pool, irrB);
        await insertSuggestion(pool, lIrrA, lIrrB, { match_basis: "photo_hash", confidence: 0.9 });

        const groups = await listDedupPropertyPairSuggestions({ limit: 100 });
        const [relLo, relHi] = [relA, relB].sort((x, y) => x - y);
        const [irrLo, irrHi] = [irrA, irrB].sort((x, y) => x - y);
        const keys = groups
          .map((g) => g.pair_key)
          .filter((k) => k === `${relLo}-${relHi}` || k === `${irrLo}-${irrHi}`);
        expect(keys).toEqual([`${relLo}-${relHi}`, `${irrLo}-${irrHi}`]);
      });
    });

    it("default (show-all) view hides no group — the non-relevant group is still reachable (issue #246, preserved at the grouped level)", async () => {
      await withRealDb(async (pool) => {
        const profile = await insertProfile(pool);
        const relA = await insertProperty(pool);
        const relB = await insertProperty(pool);
        const lRelA = await insertListing(pool, relA);
        const lRelB = await insertListing(pool, relB);
        await markProfileMatch(pool, profile, relB);
        await insertSuggestion(pool, lRelA, lRelB, { match_basis: "fuzzy", confidence: 0.6 });

        const irrA = await insertProperty(pool);
        const irrB = await insertProperty(pool);
        const lIrrA = await insertListing(pool, irrA);
        const lIrrB = await insertListing(pool, irrB);
        await insertSuggestion(pool, lIrrA, lIrrB, { match_basis: "fuzzy", confidence: 0.61 });

        const groups = await listDedupPropertyPairSuggestions({ limit: 100 });
        const [irrLo, irrHi] = [irrA, irrB].sort((x, y) => x - y);
        expect(groups.some((g) => g.property_lo_id === irrLo && g.property_hi_id === irrHi)).toBe(true);
      });
    });

    it("an archived profile or a matched=false state does NOT confer group relevance (issue #246, preserved at the grouped level)", async () => {
      await withRealDb(async (pool) => {
        const archived = await insertProfile(pool, { archived: true });
        const active = await insertProfile(pool);

        const archProp = await insertProperty(pool);
        const archOther = await insertProperty(pool);
        const lArchA = await insertListing(pool, archProp);
        const lArchB = await insertListing(pool, archOther);
        await markProfileMatch(pool, archived, archProp, true);
        await insertSuggestion(pool, lArchA, lArchB, { match_basis: "fuzzy", confidence: 0.6 });

        const unmatchedProp = await insertProperty(pool);
        const unmatchedOther = await insertProperty(pool);
        const lUnA = await insertListing(pool, unmatchedProp);
        const lUnB = await insertListing(pool, unmatchedOther);
        await markProfileMatch(pool, active, unmatchedProp, false);
        await insertSuggestion(pool, lUnA, lUnB, { match_basis: "fuzzy", confidence: 0.6 });

        const groups = await listDedupPropertyPairSuggestions({ limit: 100 });
        const [archLo, archHi] = [archProp, archOther].sort((x, y) => x - y);
        const [unLo, unHi] = [unmatchedProp, unmatchedOther].sort((x, y) => x - y);
        expect(
          groups.find((g) => g.property_lo_id === archLo && g.property_hi_id === archHi)!.profile_relevant,
        ).toBe(false);
        expect(groups.find((g) => g.property_lo_id === unLo && g.property_hi_id === unHi)!.profile_relevant).toBe(
          false,
        );
      });
    });
  });
});
