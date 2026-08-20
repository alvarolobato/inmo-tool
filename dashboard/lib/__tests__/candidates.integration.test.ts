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
 *
 * Cleanup is scoped to exact IDs this file creates (tracked per test),
 * never a broad "delete any orphaned property"/name-prefix scan. Two
 * distinct race hazards motivate this, and #159 only closed one of them:
 *
 *  - Across separate test *runs* (two agents/CI jobs invoking `npm test`
 *    concurrently, or a crashed run leaving orphaned rows behind) — closed
 *    by #159's per-session database: each `npm test` invocation gets its
 *    own throwaway Postgres database, created before the run and dropped
 *    after, so a broad scan can no longer collide with another run's data
 *    because there is no other run's data in *this* database.
 *  - Within one run, across the several integration test *files* vitest
 *    executes in separate parallel workers against that same per-run
 *    database — still real, still requires exact-id cleanup (and, for
 *    geographic tests, coordinates far enough apart not to overlap another
 *    file's radius scan — see materialize.integration.test.ts). Reproduced
 *    directly: running this file together with materialize.integration.test.ts
 *    intermittently violated a foreign key on a property this file never
 *    touched.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile } from "@/lib/db/profiles";
import {
  getAdjacentCandidates,
  listCandidates,
  listCandidateSources,
  getPropertyInvestorScore,
} from "../candidates";
import { getPropertyDetail } from "../property-detail";
import { investorScoreBreakdown } from "@/lib/display-score";
import type { Scope } from "@/lib/profiles-schema";

// Deliberately NOT Sol/Atocha (the coordinates materialize.integration.test.ts
// uses) and far enough away (~17km, well outside any radius_km used by
// either file's tests) that materialize.integration.test.ts's real
// materializeProfile() — which does a genuine broad geographic scan, by
// design — can never pick up this file's test properties when both files
// run concurrently (vitest's default file-level parallelism). Reproduced
// directly: sharing MADRID_SOL caused an intermittent cross-file FK
// violation as materialize's own production-code scan linked a fresh
// profile_listing_state row to a property this file was mid-cleanup on.
const TEST_COORDS: [number, number] = [40.5668, -3.7038];

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

  // Exact IDs this test created, cleaned up by id in afterEach — never a
  // broad table-wide scan (see file header for why).
  let createdPropertyIds: number[] = [];
  let createdProfileIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
    createdProfileIds = [];
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdPropertyIds.length > 0) {
        // ai_assessment has no FK dependents of its own, but must be cleared
        // before `property` (it FKs to property.id) — same ordering
        // constraint as listing/profile_listing_state below.
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

  async function insertProperty(pool: Pool): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', 70, 'Calle Trafalgar, Chamberí, Madrid') RETURNING id`,
      [TEST_COORDS[0], TEST_COORDS[1]],
    );
    // pg returns bigint columns as strings — this helper's own return value
    // needs the same coercion as lib/candidates.ts now applies, or
    // comparisons against listCandidates()'s (correctly numeric) output
    // fail on type alone even when the underlying ids match.
    const id = Number(result.rows[0].id);
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
      photo_urls: string[] | null;
      /** ISO string; null leaves last_seen_at unset (never re-confirmed). */
      last_seen_at: string | null;
    }> = {},
  ): Promise<number> {
    const row = {
      source: "fotocasa",
      status: "active",
      current_price: 285000,
      photo_urls: null as string[] | null,
      last_seen_at: null as string | null,
      ...overrides,
    };
    const result = await pool.query<{ id: number }>(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, photo_urls, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7) RETURNING id`,
      [
        propertyId,
        row.source,
        `int-test-${Math.random().toString(36).slice(2)}`,
        row.status,
        row.current_price,
        row.photo_urls,
        row.last_seen_at,
      ],
    );
    return result.rows[0].id;
  }

  async function makeProfile(scope: Scope): Promise<number> {
    const profile = await createProfile(`candidates-int-test-${Date.now()}-${Math.random()}`, scope, {});
    createdProfileIds.push(profile.id);
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

  async function setScore(pool: Pool, profileId: number, propertyId: number, score: number | null) {
    await pool.query(
      `UPDATE profile_listing_state SET score = $3 WHERE profile_id = $1 AND property_id = $2`,
      [profileId, propertyId, score],
    );
  }

  async function setScoreKind(pool: Pool, profileId: number, propertyId: number, scoreKind: "cold_start" | "trained") {
    await pool.query(
      `UPDATE profile_listing_state SET score_kind = $3 WHERE profile_id = $1 AND property_id = $2`,
      [profileId, propertyId, scoreKind],
    );
  }

  async function insertAssessment(
    pool: Pool,
    propertyId: number,
    opts: {
      assessmentType?: string;
      result: Record<string, unknown>;
      promptVersion: string;
      generatedAt: Date;
    },
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ai_assessment (property_id, assessment_type, result, prompt_version, generated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [
        propertyId,
        opts.assessmentType ?? "occupancy",
        JSON.stringify(opts.result),
        opts.promptVersion,
        opts.generatedAt.toISOString(),
      ],
    );
  }

  const SCOPE: Scope = {
    geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
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

  it("returns property_id as a real number and excludes withdrawn listings from the source badges", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      await insertListing(pool, propertyId, { source: "fotocasa", status: "active", current_price: 285000 });
      await insertListing(pool, propertyId, { source: "habitaclia", status: "withdrawn", current_price: 50000 });
      const profileId = await makeProfile(SCOPE);
      await markMatched(pool, profileId, propertyId);

      const page = await listCandidates(profileId);

      expect(page.items).toHaveLength(1);
      // pg returns bigint columns as strings — must be coerced to a real
      // JSON number, not left as "179" (Phase 3's scoring/ranking sorts on it).
      expect(typeof page.items[0].property_id).toBe("number");
      // A withdrawn listing must not render as a live source badge, and
      // (already covered by min_price above) must not enter the MIN either.
      expect(page.items[0].listings.map((l) => l.source)).toEqual(["fotocasa"]);
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

      // Default Array.sort() compares as strings ("10" < "8" < "9"
      // lexicographically) — this only ever matched propertyIds' numeric
      // sort by accident, back when property_id was itself (incorrectly)
      // a string. Needs the same explicit numeric comparator on both sides.
      const seen = [...firstPage.items, ...secondPage.items].map((i) => i.property_id).sort((a, b) => a - b);
      expect(seen).toEqual([...propertyIds].sort((a, b) => a - b));
    });
  });

  it("orders globally by score across pages, not just within a page, with no gaps or duplicates (Fable review, PR #93)", async () => {
    // The bug this guards against only manifests with real, differing score
    // values and more than one page's worth of results — a prior version's
    // client-side per-page sort (and its corrupted-cursor derivation from
    // that sort) was invisible to the existing keyset test above because
    // every property there has score=null, making score-sort a no-op.
    await withRealDb(async (pool) => {
      const profileId = await makeProfile(SCOPE);
      // Deliberately inserted (and thus id-ordered) worst-score-first, so a
      // correct global-score-DESC ordering can only come from real sorting
      // by score, not from happening to agree with id DESC.
      const scores = [0.1, 0.9, 0.3, 0.7, 0.5];
      const propertyIds: number[] = [];
      for (const score of scores) {
        const id = await insertProperty(pool);
        await insertListing(pool, id);
        await markMatched(pool, profileId, id);
        await setScore(pool, profileId, id, score);
        propertyIds.push(id);
      }
      const byScoreDesc = propertyIds
        .map((id, i) => ({ id, score: scores[i] }))
        .sort((a, b) => b.score - a.score)
        .map((r) => r.id);

      const firstPage = await listCandidates(profileId, { limit: 2 });
      const secondPage = await listCandidates(profileId, {
        cursor: firstPage.nextCursor,
        limit: 2,
      });
      const thirdPage = await listCandidates(profileId, { cursor: secondPage.nextCursor, limit: 2 });

      expect(firstPage.items.map((i) => i.property_id)).toEqual(byScoreDesc.slice(0, 2));
      expect(secondPage.items.map((i) => i.property_id)).toEqual(byScoreDesc.slice(2, 4));
      expect(thirdPage.items.map((i) => i.property_id)).toEqual(byScoreDesc.slice(4, 5));
      expect(thirdPage.nextCursor).toBeNull();

      // Every property appears exactly once across all pages combined.
      const seenAcrossPages = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map(
        (i) => i.property_id,
      );
      expect(seenAcrossPages.sort((a, b) => a - b)).toEqual([...propertyIds].sort((a, b) => a - b));
    });
  });

  it("does not claim a next page exists when the result set is exactly one page long", async () => {
    // Regression: nextCursor used to be inferred from "page came back full",
    // so an exactly-full last page (e.g. exactly 2 matches with limit=2)
    // wrongly reported a next page — the UI's "Cargar más" button appeared
    // and, when clicked, fetched nothing.
    await withRealDb(async (pool) => {
      const profileId = await makeProfile(SCOPE);
      for (let i = 0; i < 2; i++) {
        const id = await insertProperty(pool);
        await insertListing(pool, id);
        await markMatched(pool, profileId, id);
      }

      const page = await listCandidates(profileId, { limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe("photos — real Postgres (#167)", () => {
    it("unions photo_urls across active listings, de-duplicated by URL, in visual (listing, then position) order", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        // Second listing repeats the first listing's second photo — must
        // appear once in the result, keeping its FIRST (this listing's)
        // position, not the second listing's.
        await insertListing(pool, propertyId, {
          source: "fotocasa",
          photo_urls: ["https://a/1.jpg", "https://a/2.jpg"],
        });
        await insertListing(pool, propertyId, {
          source: "milanuncios",
          photo_urls: ["https://a/2.jpg", "https://b/3.jpg"],
        });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);

        expect(page.items).toHaveLength(1);
        expect(page.items[0].photos).toEqual(["https://a/1.jpg", "https://a/2.jpg", "https://b/3.jpg"]);
      });
    });

    it("caps the photo array at MAX_CARD_PHOTOS (8) rather than returning every photo of a heavily-photographed listing", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        const manyPhotos = Array.from({ length: 12 }, (_, i) => `https://a/${i + 1}.jpg`);
        await insertListing(pool, propertyId, { photo_urls: manyPhotos });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);

        expect(page.items[0].photos).toHaveLength(8);
        expect(page.items[0].photos).toEqual(manyPhotos.slice(0, 8));
      });
    });

    it("returns an empty array (not null, not an error) when no linked listing has photos", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId, { photo_urls: null });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);

        expect(page.items[0].photos).toEqual([]);
      });
    });

    it("excludes photos from a withdrawn listing, matching how min_price/source badges already exclude non-active listings", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId, { source: "fotocasa", photo_urls: ["https://a/1.jpg"] });
        await insertListing(pool, propertyId, {
          source: "habitaclia",
          status: "withdrawn",
          photo_urls: ["https://withdrawn/1.jpg"],
        });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);

        expect(page.items[0].photos).toEqual(["https://a/1.jpg"]);
      });
    });

    // #167 review must-fix 1: orders by listing `source`, NOT by insertion/id
    // order. The pre-existing test above ("unions photo_urls...") inserts
    // fotocasa before milanuncios, so id order and alphabetical source order
    // happen to coincide — it cannot catch a query that (incorrectly) orders
    // by listing.id, because both orderings produce the same answer. This
    // test inserts milanuncios FIRST (so it gets the lower id) and fotocasa
    // SECOND (higher id) — an id-ordered query would put milanuncios's photo
    // first; a source-ordered query puts fotocasa's photo first, since
    // "fotocasa" < "milanuncios" alphabetically. Confirmed to fail against
    // the pre-fix (`ORDER BY listing_id, ord`) query before landing the fix.
    it("orders the photo union by listing SOURCE, not by insertion/id order", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId, {
          source: "milanuncios",
          photo_urls: ["https://m/1.jpg"],
        });
        await insertListing(pool, propertyId, {
          source: "fotocasa",
          photo_urls: ["https://f/1.jpg"],
        });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);

        expect(page.items[0].photos).toEqual(["https://f/1.jpg", "https://m/1.jpg"]);
      });
    });

    // #167 review "also fix": a NULL element inside a listing's photo_urls
    // array (a real shape `TEXT[]` permits) must never survive into the
    // output — an unguarded null is counted by the client's
    // `photos.length > 1` ticker gate and renders the placeholder mid-cycle
    // when the ticker lands on it.
    it("drops a NULL element from photo_urls instead of propagating it into the photo union", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId, {
          source: "fotocasa",
          photo_urls: ["https://a/1.jpg", null as unknown as string, "https://a/2.jpg"],
        });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);

        expect(page.items[0].photos).toEqual(["https://a/1.jpg", "https://a/2.jpg"]);
      });
    });

    // #167 review must-fix 2: a single per-listing cap of MAX_CARD_PHOTOS
    // must be sufficient regardless of how many active listings contribute —
    // each listing's own LATERAL independently returns at most 8 candidates,
    // but the final union across listings must still respect the *global*
    // cap and source ordering, not just concatenate each listing's local top
    // 8 (which would over-count when an earlier-ordered listing alone has
    // fewer than 8 photos).
    it("caps the union across multiple active listings at the global MAX_CARD_PHOTOS, filling from the earliest source first", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        // "aliseda" sorts first alphabetically and contributes only 3 —
        // the remaining 5 slots must come from "milanuncios" (10 available),
        // not 8 from each concatenated then re-capped to some other mix.
        await insertListing(pool, propertyId, {
          source: "aliseda",
          photo_urls: ["https://a/1.jpg", "https://a/2.jpg", "https://a/3.jpg"],
        });
        await insertListing(pool, propertyId, {
          source: "milanuncios",
          photo_urls: Array.from({ length: 10 }, (_, i) => `https://m/${i + 1}.jpg`),
        });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);

        expect(page.items[0].photos).toEqual([
          "https://a/1.jpg",
          "https://a/2.jpg",
          "https://a/3.jpg",
          "https://m/1.jpg",
          "https://m/2.jpg",
          "https://m/3.jpg",
          "https://m/4.jpg",
          "https://m/5.jpg",
        ]);
      });
    });
  });

  describe("photos match the detail-page gallery exactly — real Postgres (#167 review must-fix 1)", () => {
    // The exact bug reproduction from the review: three listings on one
    // property — two active (milanuncios, fotocasa) and one withdrawn
    // (aliseda) — used to render a different lead photo, a different order,
    // and a different set on the card than on the detail page, because the
    // card filtered to active + ordered by listing id while the detail page
    // had no status filter and ordered by source. Proven here by asserting
    // the two real production code paths (listCandidates + getPropertyDetail)
    // against each other directly, not by asserting each in isolation against
    // a hand-derived expectation that could itself encode the same mistake.
    it("the card's capped photo union is a true prefix of the detail page's uncapped gallery, in the same order", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId, {
          source: "milanuncios",
          status: "active",
          photo_urls: ["https://m/1.jpg", "https://m/2.jpg"],
        });
        await insertListing(pool, propertyId, {
          source: "fotocasa",
          status: "active",
          photo_urls: ["https://f/1.jpg", "https://f/2.jpg"],
        });
        await insertListing(pool, propertyId, {
          source: "aliseda",
          status: "withdrawn",
          photo_urls: ["https://w/1.jpg"],
        });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);
        const detail = await getPropertyDetail(propertyId);

        expect(detail).not.toBeNull();
        // Withdrawn listing's photo must lead neither gallery, and must not
        // appear in either at all.
        expect(detail!.photo_urls).toEqual([
          "https://f/1.jpg",
          "https://f/2.jpg",
          "https://m/1.jpg",
          "https://m/2.jpg",
        ]);
        expect(page.items[0].photos).toEqual(detail!.photo_urls);
      });
    });
  });

  describe("AI flags — real Postgres (#152 review, must-fix 1)", () => {
    it("must-fix 1: shows only the latest prompt_version's verdict, not both, when a prompt bump leaves the old row in place", async () => {
      // Reproduces the review's exact repro: a property assessed under an
      // older prompt_version as "tenanted" (badge: Alquilado), then
      // re-assessed under a newer prompt_version as "occupied_illegally"
      // (badge: Ocupado). Without loadFlags's `DISTINCT ON
      // (property_id, assessment_type)`, both rows exist simultaneously
      // (ai_assessment_property_key is UNIQUE per prompt_version, not just
      // per assessment_type) and the card would render both badges at once.
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId);
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        await insertAssessment(pool, propertyId, {
          result: { caveats: ["tenanted"] },
          promptVersion: "occupancy/v1",
          generatedAt: new Date("2026-01-01T00:00:00Z"),
        });
        await insertAssessment(pool, propertyId, {
          result: { caveats: ["occupied_illegally"] },
          promptVersion: "occupancy/v2",
          generatedAt: new Date("2026-06-01T00:00:00Z"),
        });

        const page = await listCandidates(profileId);
        expect(page.items).toHaveLength(1);
        const flags = page.items[0].flags;
        expect(flags).toEqual([{ kind: "caveat:occupied_illegally", label: "Ocupado", tone: "warn" }]);
        // The must-fix reproduction, stated directly: never both at once.
        expect(flags.some((f) => f.kind === "caveat:tenanted")).toBe(false);
      });
    });

    it("shows the newest verdict regardless of insertion order (ordered by generated_at, not by insert/id order)", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId);
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        // Newer row inserted FIRST (lower id, later generated_at) — proves
        // the ordering is genuinely by generated_at, not an accident of
        // insertion/id order that DISTINCT ON's implicit tie-break could mask.
        await insertAssessment(pool, propertyId, {
          result: { caveats: ["venta_deuda"] },
          promptVersion: "occupancy/v2",
          generatedAt: new Date("2026-06-01T00:00:00Z"),
        });
        await insertAssessment(pool, propertyId, {
          result: { caveats: ["tenanted"] },
          promptVersion: "occupancy/v1",
          generatedAt: new Date("2026-01-01T00:00:00Z"),
        });

        const page = await listCandidates(profileId);
        expect(page.items[0].flags).toEqual([
          { kind: "caveat:venta_deuda", label: "Venta de deuda", tone: "warn" },
        ]);
      });
    });

    it("combines a current occupancy verdict with a separate condition assessment on the same property", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId);
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        await insertAssessment(pool, propertyId, {
          assessmentType: "occupancy",
          result: { caveats: ["proindiviso"] },
          promptVersion: "occupancy/v1",
          generatedAt: new Date("2026-01-01T00:00:00Z"),
        });
        await insertAssessment(pool, propertyId, {
          assessmentType: "condition",
          result: { condition: "a_reformar" },
          promptVersion: "condition/v1",
          generatedAt: new Date("2026-01-01T00:00:00Z"),
        });

        const page = await listCandidates(profileId);
        const kinds = page.items[0].flags.map((f) => f.kind).sort();
        expect(kinds).toEqual(["caveat:proindiviso", "condition:a_reformar"]);
      });
    });

    it("renders no badge for a standard, unremarkable verdict (empty caveats)", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId);
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        await insertAssessment(pool, propertyId, {
          result: { caveats: [] },
          promptVersion: "occupancy/v1",
          generatedAt: new Date(),
        });

        const page = await listCandidates(profileId);
        expect(page.items[0].flags).toEqual([]);
      });
    });

    it("keeps flags scoped per property — one property's assessment never leaks onto another's card", async () => {
      await withRealDb(async (pool) => {
        const flaggedId = await insertProperty(pool);
        await insertListing(pool, flaggedId);
        const cleanId = await insertProperty(pool);
        await insertListing(pool, cleanId);
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, flaggedId);
        await markMatched(pool, profileId, cleanId);

        await insertAssessment(pool, flaggedId, {
          result: { caveats: ["usufructo"] },
          promptVersion: "occupancy/v1",
          generatedAt: new Date(),
        });

        const page = await listCandidates(profileId);
        const flaggedItem = page.items.find((i) => i.property_id === flaggedId)!;
        const cleanItem = page.items.find((i) => i.property_id === cleanId)!;
        expect(flaggedItem.flags).toEqual([{ kind: "caveat:usufructo", label: "Usufructo", tone: "warn" }]);
        expect(cleanItem.flags).toEqual([]);
      });
    });
  });

  describe("staleness (last_seen_at) — real Postgres (#243)", () => {
    const daysAgoIso = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

    it("returns the freshest active listing's last_seen_at, so lib/staleness can derive the age", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        const seen = daysAgoIso(3);
        await insertListing(pool, propertyId, { last_seen_at: seen });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);
        expect(page.items).toHaveLength(1);
        // pg returns timestamptz as an ISO-ish string; both sides normalised
        // through Date so a formatting difference doesn't fail a real match.
        expect(new Date(page.items[0].last_seen_at!).getTime()).toBe(new Date(seen).getTime());
      });
    });

    it("reflects the FRESHEST of a deduplicated property's active listings, not the oldest (mutation guard for the MAX)", async () => {
      // Two active listings on one property: one re-confirmed 30 days ago,
      // one only 2 days ago. The candidate must carry the 2-day (freshest)
      // timestamp — a MIN would return the 30-day one and wrongly mark a live
      // property stale. This is the freshest-of-linked rule issue #243 names.
      await withRealDb(async (pool) => {
        const oldSeen = daysAgoIso(30);
        const freshSeen = daysAgoIso(2);
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId, { source: "fotocasa", last_seen_at: oldSeen });
        await insertListing(pool, propertyId, { source: "milanuncios", last_seen_at: freshSeen });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);
        expect(page.items).toHaveLength(1);
        expect(new Date(page.items[0].last_seen_at!).getTime()).toBe(new Date(freshSeen).getTime());
      });
    });

    it("excludes a withdrawn listing's last_seen_at — a withdrawn sibling can't make a property look fresher", async () => {
      // Active listing seen 30 days ago; withdrawn listing seen 1 day ago.
      // The withdrawn one is fresher in absolute terms but must be excluded —
      // discover() doesn't re-confirm withdrawn listings, so only the active
      // 30-day timestamp counts (same active-only rule as min_price/photos).
      await withRealDb(async (pool) => {
        const activeSeen = daysAgoIso(30);
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId, { source: "fotocasa", status: "active", last_seen_at: activeSeen });
        await insertListing(pool, propertyId, {
          source: "habitaclia",
          status: "withdrawn",
          last_seen_at: daysAgoIso(1),
        });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);
        expect(new Date(page.items[0].last_seen_at!).getTime()).toBe(new Date(activeSeen).getTime());
      });
    });

    it("is null when no active listing has ever been re-confirmed (unknown, not fresh)", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId, { last_seen_at: null });
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);
        expect(page.items[0].last_seen_at).toBeNull();
      });
    });
  });

  describe("score_kind — real Postgres", () => {
    it("surfaces score_kind alongside score/rank_explanation", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId);
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);
        await setScore(pool, profileId, propertyId, 0.42);
        await setScoreKind(pool, profileId, propertyId, "trained");

        const page = await listCandidates(profileId);
        expect(page.items[0].score_kind).toBe("trained");
      });
    });

    it("is null until the property has been scored at all", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId);
        const profileId = await makeProfile(SCOPE);
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);
        expect(page.items[0].score_kind).toBeNull();
      });
    });
  });

  describe("ranking blend — below-market + distress (#309, D-057)", () => {
    // Seed a matched, scored candidate with a chosen price and optional
    // distress assessment. m2_built is fixed at 70 by insertProperty, so the
    // price alone drives price/m² and therefore the below-market signal.
    async function seedCandidate(
      pool: Pool,
      profileId: number,
      opts: { price: number; score: number | null; caveats?: string[] },
    ): Promise<number> {
      const id = await insertProperty(pool);
      await insertListing(pool, id, { source: "fotocasa", current_price: opts.price });
      await markMatched(pool, profileId, id);
      await setScore(pool, profileId, id, opts.score);
      if (opts.caveats) {
        await insertAssessment(pool, id, {
          assessmentType: "occupancy",
          result: { caveats: opts.caveats },
          promptVersion: "occupancy/v1",
          generatedAt: new Date("2026-01-01T00:00:00Z"),
        });
      }
      return id;
    }

    it("floats a below-market candidate above an equal/higher base-score at-market one, while the at-market one keeps its base score", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // 3 fillers at 300k establish the pool median (>= MIN_POOL_SIZE priced
        // candidates) and sit low on base score.
        for (let i = 0; i < 3; i++) {
          await seedCandidate(pool, profileId, { price: 300000, score: 0.1 });
        }
        // At-market, HIGHER base score than the deal — no boost, so it must
        // keep exactly its base score (graceful: never sinks).
        const atMarket = await seedCandidate(pool, profileId, { price: 300000, score: 0.6 });
        // Deep discount (~40% below the 300k pool median), LOWER base score —
        // only the below-market boost can lift it.
        const deal = await seedCandidate(pool, profileId, { price: 180000, score: 0.5 });

        const page = await listCandidates(profileId, { limit: 10 });
        const order = page.items.map((i) => i.property_id);

        // The deal outranks the higher-base at-market candidate purely on the
        // below-market boost (0.5 + ~0.2 > 0.6).
        expect(order.indexOf(deal)).toBeLessThan(order.indexOf(atMarket));
        expect(page.items[0].property_id).toBe(deal);

        const dealRow = page.items.find((i) => i.property_id === deal)!;
        const atMarketRow = page.items.find((i) => i.property_id === atMarket)!;

        // The deal's discount is real and surfaced (~40% below the pool median).
        expect(dealRow.below_market_pct).toBeGreaterThan(0.3);
        expect(dealRow.effective_score!).toBeGreaterThan(dealRow.score!); // boosted above base
        expect(dealRow.ranking_boost_reason).toContain("por debajo de la mediana");

        // The at-market candidate is NOT boosted — its effective score is its
        // base score (blend augments, never discards the learned score).
        expect(atMarketRow.effective_score!).toBeCloseTo(0.6, 5);
        expect(atMarketRow.ranking_boost_reason).toBeNull();
      });
    });

    it("floats a distress-flagged candidate above an equal-base clean one, and leaves the clean one on its base score", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Only two candidates → pool below MIN_POOL_SIZE, so no below-market
        // boost applies and the distress signal is isolated. Same price and
        // same base score; the only difference is the distress caveat.
        const clean = await seedCandidate(pool, profileId, { price: 300000, score: 0.5 });
        const distressed = await seedCandidate(pool, profileId, {
          price: 300000,
          score: 0.5,
          caveats: ["venta_deuda"],
        });

        const page = await listCandidates(profileId, { limit: 10 });
        const order = page.items.map((i) => i.property_id);

        expect(order.indexOf(distressed)).toBeLessThan(order.indexOf(clean));

        const distressedRow = page.items.find((i) => i.property_id === distressed)!;
        const cleanRow = page.items.find((i) => i.property_id === clean)!;

        expect(distressedRow.distress_level).toBe(1);
        expect(distressedRow.effective_score!).toBeGreaterThan(distressedRow.score!);
        expect(distressedRow.ranking_boost_reason).toContain("señales de oportunidad");
        // No below-market signal (tiny pool) and no distress → clean stays on base.
        expect(cleanRow.distress_level).toBe(0);
        expect(cleanRow.below_market_pct).toBeNull();
        expect(cleanRow.effective_score!).toBeCloseTo(0.5, 5);
        expect(cleanRow.ranking_boost_reason).toBeNull();
      });
    });

    it("keeps a never-scored candidate last even with a deep discount (the base sentinel dominates the bounded boost)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Fillers to establish a pool median at 300k.
        for (let i = 0; i < 3; i++) {
          await seedCandidate(pool, profileId, { price: 300000, score: 0.1 });
        }
        // A real (low) scored candidate, at market.
        const scored = await seedCandidate(pool, profileId, { price: 300000, score: 0.1 });
        // A never-scored candidate with a deep discount: its boost is real but
        // bounded, so it must still sort below any genuinely scored candidate
        // rather than leapfrogging the whole scored pool from the null set.
        const unscoredDeal = await seedCandidate(pool, profileId, { price: 150000, score: null });

        const page = await listCandidates(profileId, { limit: 10 });
        const order = page.items.map((i) => i.property_id);

        // The unscored deal is boosted (discount surfaced) but ranks last.
        const unscoredRow = page.items.find((i) => i.property_id === unscoredDeal)!;
        expect(unscoredRow.below_market_pct).toBeGreaterThan(0.3);
        expect(order.indexOf(scored)).toBeLessThan(order.indexOf(unscoredDeal));
        expect(order[order.length - 1]).toBe(unscoredDeal);
      });
    });

    it("degrades cleanly when NO candidate has any assessment or below-market discount — order and effective_score fall back to the base score", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // All same price (identical price/m² → zero discount for everyone) and
        // no assessments — the exact state of this deployment until #316 wires
        // the LLM. Ranking must reduce to the base score with no boost, no
        // error, no fabricated discount.
        const scores = [0.2, 0.8, 0.5];
        const byScore: { id: number; score: number }[] = [];
        for (const score of scores) {
          const id = await seedCandidate(pool, profileId, { price: 300000, score });
          byScore.push({ id, score });
        }
        const expected = byScore.sort((a, b) => b.score - a.score).map((r) => r.id);

        const page = await listCandidates(profileId, { limit: 10 });
        expect(page.items.map((i) => i.property_id)).toEqual(expected);
        for (const row of page.items) {
          expect(row.effective_score!).toBeCloseTo(row.score!, 5);
          expect(row.ranking_boost_reason).toBeNull();
          expect(row.distress_level).toBe(0);
          // pool median == every ppm2, so the discount is exactly 0 (not null:
          // the pool is large enough), and never a fabricated positive.
          expect(row.below_market_pct).toBeCloseTo(0, 5);
        }
      });
    });
  });

  describe("timing boosts + investor score (#452)", () => {
    // Seed a matched, scored candidate with a chosen days-on-market (via a past
    // first_seen_at on an active listing) and an optional two-point price history
    // that produces a net drop. All same price (300k) so the below-market signal
    // is ~0 and the timing boost is isolated.
    async function seedTiming(
      pool: Pool,
      profileId: number,
      opts: {
        score: number | null;
        firstSeenDaysAgo: number;
        priceHistory?: { price: number; daysAgo: number }[];
        price?: number;
      },
    ): Promise<number> {
      const price = opts.price ?? 300000;
      const id = await insertProperty(pool);
      const listing = await pool.query<{ id: number }>(
        `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at)
         VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, NOW() - ($4 || ' days')::interval) RETURNING id`,
        [id, `int-tim-${Math.random().toString(36).slice(2)}`, price, String(opts.firstSeenDaysAgo)],
      );
      const listingId = Number(listing.rows[0].id);
      for (const p of opts.priceHistory ?? []) {
        await pool.query(
          `INSERT INTO listing_price_history (listing_id, observed_at, price)
           VALUES ($1, NOW() - ($2 || ' days')::interval, $3)`,
          [listingId, String(p.daysAgo), p.price],
        );
      }
      await markMatched(pool, profileId, id);
      await setScore(pool, profileId, id, opts.score);
      return id;
    }

    it("a long-on-market candidate is boosted above an equal-base fresh one, and the boost is capped", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const fresh = await seedTiming(pool, profileId, { score: 0.5, firstSeenDaysAgo: 2 });
        const stale = await seedTiming(pool, profileId, { score: 0.5, firstSeenDaysAgo: 300 });

        const page = await listCandidates(profileId, { limit: 10 });
        const staleRow = page.items.find((i) => i.property_id === stale)!;
        const freshRow = page.items.find((i) => i.property_id === fresh)!;
        // Both share base 0.5; the stale one is lifted by the DOM boost (≤ 0.04)
        // and must sort first.
        expect(staleRow.effective_score!).toBeGreaterThan(freshRow.effective_score!);
        expect(staleRow.effective_score! - freshRow.effective_score!).toBeLessThanOrEqual(0.04 + 1e-9);
        expect(page.items.map((i) => i.property_id).indexOf(stale)).toBe(0);
      });
    });

    it("a net price drop lifts effective_score, and the joint timing cap holds at 0.11", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const flat = await seedTiming(pool, profileId, { score: 0.5, firstSeenDaysAgo: 2 });
        // Long on market AND a deep (25%) net drop → both timing boosts max out,
        // so the combined lift is capped at 0.11, never 0.04 + 0.07 uncapped-plus.
        const motivated = await seedTiming(pool, profileId, {
          score: 0.5,
          firstSeenDaysAgo: 300,
          priceHistory: [
            { price: 400000, daysAgo: 200 },
            { price: 300000, daysAgo: 5 },
          ],
        });

        const page = await listCandidates(profileId, { limit: 10 });
        const flatRow = page.items.find((i) => i.property_id === flat)!;
        const motivatedRow = page.items.find((i) => i.property_id === motivated)!;
        const lift = motivatedRow.effective_score! - flatRow.effective_score!;
        expect(lift).toBeGreaterThan(0.04); // more than DOM alone
        expect(lift).toBeLessThanOrEqual(0.11 + 1e-9); // joint cap
      });
    });

    it("degrades to 0 timing boost when there is no history and the listing is fresh (never sinks the base)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Fresh listing (2 days), no price history → DOM boost ≈ 0.0004, drop 0.
        const id = await seedTiming(pool, profileId, { score: 0.6, firstSeenDaysAgo: 2 });
        const page = await listCandidates(profileId, { limit: 10 });
        const row = page.items.find((i) => i.property_id === id)!;
        // effective_score is base + a negligible DOM boost, never below base.
        expect(row.effective_score!).toBeGreaterThanOrEqual(0.6);
        expect(row.effective_score!).toBeLessThan(0.6 + 0.001);
      });
    });

    it("keeps a never-scored candidate below any real score even with both timing boosts maxed (invariant)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const scored = await seedTiming(pool, profileId, { score: 0.05, firstSeenDaysAgo: 2 });
        const unscored = await seedTiming(pool, profileId, {
          score: null,
          firstSeenDaysAgo: 300,
          priceHistory: [
            { price: 400000, daysAgo: 200 },
            { price: 300000, daysAgo: 5 },
          ],
        });
        const page = await listCandidates(profileId, { limit: 10 });
        const order = page.items.map((i) => i.property_id);
        // Even fully timing-boosted, the never-scored sentinel sorts below the
        // lowest real score.
        expect(order.indexOf(scored)).toBeLessThan(order.indexOf(unscored));
        expect(order[order.length - 1]).toBe(unscored);
      });
    });

    it("getPropertyInvestorScore exposes the raw inputs and effective_score that the display re-expresses", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const id = await seedTiming(pool, profileId, {
          score: 0.5,
          firstSeenDaysAgo: 300,
          priceHistory: [
            { price: 360000, daysAgo: 200 },
            { price: 300000, daysAgo: 5 },
          ],
        });
        const s = await getPropertyInvestorScore(profileId, id);
        expect(s).not.toBeNull();
        expect(s!.base_score).toBeCloseTo(0.5, 5);
        expect(s!.days_on_market!).toBeGreaterThanOrEqual(299);
        expect(s!.price_drop_pct!).toBeCloseTo((360000 - 300000) / 360000, 4);
        // effective_score = base + timing boost (no below-market/distress here).
        expect(s!.effective_score!).toBeGreaterThan(0.5);
        // The display re-expression sums the breakdown to the shown score.
        const b = investorScoreBreakdown(s!);
        expect(b.terms.reduce((a, t) => a + t.points, 0)).toBe(b.display.value);
        expect(b.display.unscored).toBe(false);
      });
    });

    it("returns null for a property that is not a matched candidate of the profile", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const orphan = await insertProperty(pool);
        expect(await getPropertyInvestorScore(profileId, orphan)).toBeNull();
      });
    });
  });

  describe("like-for-like below-market segmentation (#461)", () => {
    // Seed a matched, scored candidate with FULL control over the segmentation
    // axes: rooms, m² built and floor (free text as the portals publish it).
    // Unlike the shared insertProperty (which hardcodes m2=70, rooms/floor NULL —
    // so segments never form and everything falls back to the pool), this lets a
    // test build a real like-for-like segment and contrast it with the pool.
    async function seedSeg(
      pool: Pool,
      profileId: number,
      opts: {
        price: number;
        rooms: number;
        m2: number;
        floor?: string | null;
        score?: number | null;
      },
    ): Promise<number> {
      const res = await pool.query<{ id: number }>(
        `INSERT INTO property (lat, lon, property_type, m2_built, rooms, floor, address)
         VALUES ($1, $2, 'piso', $3, $4, $5, 'Calle Trafalgar, Chamberí, Madrid') RETURNING id`,
        [TEST_COORDS[0], TEST_COORDS[1], opts.m2, opts.rooms, opts.floor ?? null],
      );
      const id = Number(res.rows[0].id);
      createdPropertyIds.push(id);
      await insertListing(pool, id, { source: "fotocasa", current_price: opts.price });
      await markMatched(pool, profileId, id);
      await setScore(pool, profileId, id, opts.score ?? 0.4);
      return id;
    }

    it("measures the discount against the like-for-like segment, not the whole-pool median, and records base='segment'", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // A cluster of small, cheap 1-hab/40m² flats drags the WHOLE-pool median
        // down — comparing an atypical unit against it manufactures a phantom
        // discount. Seed 5 of them at 2.500 €/m².
        for (let i = 0; i < 5; i++) {
          await seedSeg(pool, profileId, { price: 100000, rooms: 1, m2: 40, floor: "2" });
        }
        // The target's own segment: 4-hab / 100 m² / upper floor, comparables at
        // 6.000 €/m². The target is at 4.000 €/m² → 33% below its LIKE-FOR-LIKE
        // segment, but ABOVE the (small-flat-dominated) whole-pool median.
        for (let i = 0; i < 3; i++) {
          await seedSeg(pool, profileId, { price: 600000, rooms: 4, m2: 100, floor: "5" });
        }
        const target = await seedSeg(pool, profileId, {
          price: 400000,
          rooms: 4,
          m2: 100,
          floor: "5",
        });

        const page = await listCandidates(profileId, { limit: 50 });
        const row = page.items.find((i) => i.property_id === target)!;

        // Segment median 6.000, target 4.000 → 33% below, NOT the negative
        // (above-market) figure the whole-pool median would give.
        expect(row.below_market_base).toBe("segment");
        expect(row.below_market_pct!).toBeCloseTo(1 / 3, 2);
        expect(row.below_market_pct!).toBeGreaterThan(0);
        // Segment includes the target itself + its 3 comps.
        expect(row.below_market_comparables).toBe(4);
      });
    });

    it("falls back to the whole-pool median (base='pool') when the segment has fewer than MIN_POOL_SIZE comparables", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Whole pool is large enough (≥ 3 priced), but the target's segment is
        // not: only the target + ONE like-for-like comp (seg_n = 2 < 3).
        for (let i = 0; i < 3; i++) {
          await seedSeg(pool, profileId, { price: 200000, rooms: 1, m2: 45, floor: "3" });
        }
        await seedSeg(pool, profileId, { price: 500000, rooms: 5, m2: 130, floor: "6" });
        const target = await seedSeg(pool, profileId, {
          price: 300000,
          rooms: 5,
          m2: 130,
          floor: "6",
        });

        const page = await listCandidates(profileId, { limit: 50 });
        const row = page.items.find((i) => i.property_id === target)!;

        // Segment too small (2 < 3) → graceful fallback to the whole-pool median.
        expect(row.below_market_base).toBe("pool");
        // A real, non-null discount is still produced (coverage preserved).
        expect(row.below_market_pct).not.toBeNull();
      });
    });

    it("never compares a ground-floor (bajo) unit against upper floors", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Upper-floor comps priced HIGH (5.714 €/m²) — 5 of them, so they'd
        // dominate the whole-pool median if a bajo were compared against the pool.
        for (let i = 0; i < 5; i++) {
          await seedSeg(pool, profileId, { price: 400000, rooms: 3, m2: 70, floor: "4" });
        }
        // Ground-floor comps priced LOW (2.857 €/m²) — the market prices bajos
        // lower. 3 of them, so a bajo target forms its own ground segment.
        for (let i = 0; i < 3; i++) {
          await seedSeg(pool, profileId, { price: 200000, rooms: 3, m2: 70, floor: "Bajo" });
        }
        // Target: a bajo at 2.142 €/m² (150.000 / 70). vs the GROUND segment
        // (median 2.857) it is ~25% below; vs the upper-dominated whole pool it
        // would look ~62% below — a phantom discount the segmentation must avoid.
        const target = await seedSeg(pool, profileId, {
          price: 150000,
          rooms: 3,
          m2: 70,
          floor: "Bajo",
        });

        const page = await listCandidates(profileId, { limit: 50 });
        const row = page.items.find((i) => i.property_id === target)!;

        expect(row.below_market_base).toBe("segment");
        // Compared only against the 4 ground-floor units (target + 3 comps).
        expect(row.below_market_comparables).toBe(4);
        expect(row.below_market_pct!).toBeCloseTo(0.25, 2);
        // NOT the ~62% phantom discount the upper-floor pool would fabricate.
        expect(row.below_market_pct!).toBeLessThan(0.4);
      });
    });

    it("#474: 'bajo cubierta' (ático under the roof) is NOT classed as ground floor", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Three genuine ground-floor `Bajo` comps at 2.857 €/m² (200.000 / 70).
        for (let i = 0; i < 3; i++) {
          await seedSeg(pool, profileId, { price: 200000, rooms: 3, m2: 70, floor: "Bajo" });
        }
        // A plain `Bajo` target at 2.142 €/m² → joins the ground segment (itself +
        // the 3 comps = 4 like-for-like comparables), base='segment'.
        const plainBajo = await seedSeg(pool, profileId, {
          price: 150000,
          rooms: 3,
          m2: 70,
          floor: "Bajo",
        });
        // A `bajo cubierta` target — an ático UNDER THE ROOF, an UPPER floor. The
        // substring `bajo` used to drag it into the ground-floor segment (#474);
        // it must NOT be. Its own upper segment has only itself (< MIN_POOL_SIZE),
        // so it correctly falls back to the whole-pool median (base='pool') over
        // ALL 5 priced candidates — proving it was never grouped with the bajos.
        const bajoCubierta = await seedSeg(pool, profileId, {
          price: 150000,
          rooms: 3,
          m2: 70,
          floor: "Bajo cubierta",
        });

        const page = await listCandidates(profileId, { limit: 50 });
        const plainRow = page.items.find((i) => i.property_id === plainBajo)!;
        const cubiertaRow = page.items.find((i) => i.property_id === bajoCubierta)!;

        // The genuine bajo forms its ground segment (target + 3 ground comps).
        expect(plainRow.below_market_base).toBe("segment");
        expect(plainRow.below_market_comparables).toBe(4);
        // The bajo cubierta is excluded from that segment → whole-pool fallback
        // over all 5 priced candidates, NOT the 4-unit ground segment.
        expect(cubiertaRow.below_market_base).toBe("pool");
        expect(cubiertaRow.below_market_comparables).toBe(5);
      });
    });

    it("recomputes below_market_pct on the segment but keeps the 50% boost cap intact", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // A like-for-like segment at 4.000 €/m²; the target at 1.000 €/m² → a 75%
        // discount vs its segment (well past the 50% cap that guards likely-m²-
        // error data).
        for (let i = 0; i < 3; i++) {
          await seedSeg(pool, profileId, { price: 400000, rooms: 3, m2: 100, floor: "3", score: 0.4 });
        }
        const target = await seedSeg(pool, profileId, {
          price: 100000,
          rooms: 3,
          m2: 100,
          floor: "3",
          score: 0.4,
        });

        const page = await listCandidates(profileId, { limit: 50 });
        const row = page.items.find((i) => i.property_id === target)!;

        // The RAW segment discount is surfaced uncapped (~0.75)…
        expect(row.below_market_base).toBe("segment");
        expect(row.below_market_pct!).toBeCloseTo(0.75, 2);
        // …but the BOOST it contributes is capped at 0.5 × 0.5 = 0.25, so the
        // effective_score lifts the 0.4 base by no more than 0.25.
        expect(row.effective_score!).toBeCloseTo(0.4 + 0.25, 4);
      });
    });

    it("degrades to the whole-pool median unchanged when rooms/floor are unknown (existing behaviour preserved)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // insertProperty leaves rooms/floor NULL — so no segment can form and the
        // discount is computed against the whole pool exactly as before #461.
        for (let i = 0; i < 3; i++) {
          const id = await insertProperty(pool);
          await insertListing(pool, id, { current_price: 300000 });
          await markMatched(pool, profileId, id);
          await setScore(pool, profileId, id, 0.3);
        }
        const deal = await insertProperty(pool);
        await insertListing(pool, deal, { current_price: 180000 });
        await markMatched(pool, profileId, deal);
        await setScore(pool, profileId, deal, 0.3);

        const page = await listCandidates(profileId, { limit: 50 });
        const row = page.items.find((i) => i.property_id === deal)!;
        expect(row.below_market_base).toBe("pool");
        // (300k − 180k)/300k = 0.4 vs the whole-pool median, unchanged by #461.
        expect(row.below_market_pct!).toBeCloseTo(0.4, 2);
      });
    });
  });

  describe("hard filters — occupancy / condition / below-market (#310, D-059)", () => {
    // A matched, priced candidate with optional occupancy + condition
    // assessments. Reuses the SAME signals the ranking blend reads (the
    // per-axis columns the CTE derives), so filter and rank agree.
    async function seedFilterable(
      pool: Pool,
      profileId: number,
      opts: {
        price: number;
        occupancy?: "vacant" | "tenanted" | "occupied_illegally";
        condition?: "a_reformar" | "reformado" | "obra_nueva";
        renovation?: "leve" | "integral";
      },
    ): Promise<number> {
      const id = await insertProperty(pool);
      await insertListing(pool, id, { source: "fotocasa", current_price: opts.price });
      await markMatched(pool, profileId, id);
      if (opts.occupancy) {
        // occupancy is a NESTED Verdict — the CTE reads ->'occupancy'->>'value'.
        await insertAssessment(pool, id, {
          assessmentType: "occupancy",
          result: {
            occupancy: { value: opts.occupancy },
            caveats: opts.occupancy === "vacant" ? [] : [opts.occupancy],
          },
          promptVersion: "occupancy/v2",
          generatedAt: new Date("2026-02-01T00:00:00Z"),
        });
      }
      if (opts.condition) {
        await insertAssessment(pool, id, {
          assessmentType: "condition",
          result: {
            condition: opts.condition,
            renovation_severity: opts.condition === "a_reformar" ? (opts.renovation ?? "unknown") : null,
          },
          promptVersion: "condition/v2",
          generatedAt: new Date("2026-02-01T00:00:00Z"),
        });
      }
      return id;
    }

    it("occupancy=occupied returns only tenanted/illegally-occupied candidates (EC: filter by occupied)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const tenanted = await seedFilterable(pool, profileId, { price: 300000, occupancy: "tenanted" });
        const squatted = await seedFilterable(pool, profileId, {
          price: 300000,
          occupancy: "occupied_illegally",
        });
        const vacant = await seedFilterable(pool, profileId, { price: 300000, occupancy: "vacant" });

        const page = await listCandidates(profileId, { occupancy: "occupied", limit: 10 });
        expect(page.items.map((i) => i.property_id).sort((a, b) => a - b)).toEqual(
          [tenanted, squatted].sort((a, b) => a - b),
        );
        expect(page.items.map((i) => i.property_id)).not.toContain(vacant);

        // The complementary filter keeps only the vacant one.
        const free = await listCandidates(profileId, { occupancy: "free", limit: 10 });
        expect(free.items.map((i) => i.property_id)).toEqual([vacant]);
      });
    });

    it("condition=a_reformar excludes reformado; renovation=integral narrows to the integral one (EC: filter by renovation integral)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const integral = await seedFilterable(pool, profileId, {
          price: 300000,
          condition: "a_reformar",
          renovation: "integral",
        });
        const leve = await seedFilterable(pool, profileId, {
          price: 300000,
          condition: "a_reformar",
          renovation: "leve",
        });
        const reformado = await seedFilterable(pool, profileId, { price: 300000, condition: "reformado" });

        // condition filter: both a_reformar, not the reformado one.
        const aReformar = await listCandidates(profileId, { condition: "a_reformar", limit: 10 });
        expect(aReformar.items.map((i) => i.property_id).sort((a, b) => a - b)).toEqual(
          [integral, leve].sort((a, b) => a - b),
        );
        expect(aReformar.items.map((i) => i.property_id)).not.toContain(reformado);

        // renovation severity narrows to just the integral one.
        const integralOnly = await listCandidates(profileId, { renovation: "integral", limit: 10 });
        expect(integralOnly.items.map((i) => i.property_id)).toEqual([integral]);
      });
    });

    it("minBelowMarketPct keeps only candidates ≥ N% below the pool median price/m² (EC: filter by below-market)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // 3 fillers at 300k set the pool median (>= MIN_POOL_SIZE); a deal at
        // 200k sits ~33% below it. m2_built is fixed at 70, so price drives ppm2.
        for (let i = 0; i < 3; i++) {
          await seedFilterable(pool, profileId, { price: 300000 });
        }
        const deal = await seedFilterable(pool, profileId, { price: 200000 });

        const page = await listCandidates(profileId, { minBelowMarketPct: 0.15, limit: 10 });
        // Only the deal clears ≥15%; the at-median fillers (0% discount) drop.
        expect(page.items.map((i) => i.property_id)).toEqual([deal]);
        expect(page.items[0].below_market_pct).toBeGreaterThan(0.3);
      });
    });

    it("combines an assessment filter with the below-market filter", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        for (let i = 0; i < 3; i++) {
          await seedFilterable(pool, profileId, { price: 300000 });
        }
        // Two deals ≥15% below; only one is also a_reformar.
        const cheapReformar = await seedFilterable(pool, profileId, {
          price: 200000,
          condition: "a_reformar",
        });
        const cheapReformado = await seedFilterable(pool, profileId, {
          price: 200000,
          condition: "reformado",
        });

        const page = await listCandidates(profileId, {
          condition: "a_reformar",
          minBelowMarketPct: 0.15,
          limit: 10,
        });
        expect(page.items.map((i) => i.property_id)).toEqual([cheapReformar]);
        expect(page.items.map((i) => i.property_id)).not.toContain(cheapReformado);
      });
    });

    it("degrades cleanly: an assessment filter with NO assessment data returns an empty feed, not an error", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Matched, priced, but NEVER assessed — the deployment reality until
        // #316 wires the LLM. Filtering on occupancy must return [] (unknown
        // excluded), not throw and not silently pass the property through.
        await seedFilterable(pool, profileId, { price: 300000 });
        await seedFilterable(pool, profileId, { price: 280000 });

        const occ = await listCandidates(profileId, { occupancy: "occupied", limit: 10 });
        expect(occ.items).toEqual([]);
        const cond = await listCandidates(profileId, { condition: "a_reformar", limit: 10 });
        expect(cond.items).toEqual([]);

        // Sanity: with no filter the same profile DOES return its candidates,
        // so the empty result above is the filter's doing, not a broken feed.
        const unfiltered = await listCandidates(profileId, { limit: 10 });
        expect(unfiltered.items).toHaveLength(2);
      });
    });

    it("no filters set behaves exactly as before (no regression)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const a = await seedFilterable(pool, profileId, { price: 300000, occupancy: "tenanted" });
        const b = await seedFilterable(pool, profileId, { price: 280000, condition: "a_reformar" });

        const page = await listCandidates(profileId, { limit: 10 });
        expect(page.items.map((i) => i.property_id).sort((x, y) => x - y)).toEqual(
          [a, b].sort((x, y) => x - y),
        );
      });
    });
  });

  describe("caveat / redflag-type hard filters (#386, D-059)", () => {
    // A matched, priced candidate carrying optional occupancy caveats and/or
    // redflags flag types — seeded through the SAME `ai_assessment` rows the
    // ranking CTE reads, so the filter and the distress boost agree.
    async function seedTagged(
      pool: Pool,
      profileId: number,
      opts: { caveats?: string[]; redflagTypes?: string[] },
    ): Promise<number> {
      const id = await insertProperty(pool);
      await insertListing(pool, id, { source: "fotocasa", current_price: 300000 });
      await markMatched(pool, profileId, id);
      if (opts.caveats) {
        await insertAssessment(pool, id, {
          assessmentType: "occupancy",
          // occupancy value isn't what the caveat filter reads — the derived
          // caveats[] is — but keep a plausible nested verdict for realism.
          result: { occupancy: { value: "vacant" }, caveats: opts.caveats },
          promptVersion: "occupancy/v2",
          generatedAt: new Date("2026-02-01T00:00:00Z"),
        });
      }
      if (opts.redflagTypes) {
        await insertAssessment(pool, id, {
          assessmentType: "redflags",
          result: {
            flags: opts.redflagTypes.map((t) => ({
              type: t,
              description: `check ${t}`,
              evidence: `menciona ${t}`,
              evidence_source: "fotocasa",
            })),
          },
          promptVersion: "redflags/v3",
          generatedAt: new Date("2026-02-01T00:00:00Z"),
        });
      }
      return id;
    }

    it("caveat=venta_deuda keeps only debt-sale candidates (EC: owner's 'venta de deuda' ask)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const debt = await seedTagged(pool, profileId, { caveats: ["venta_deuda"] });
        const nuda = await seedTagged(pool, profileId, { caveats: ["nuda_propiedad"] });
        const clean = await seedTagged(pool, profileId, { caveats: [] });

        const page = await listCandidates(profileId, { caveat: "venta_deuda", limit: 10 });
        expect(page.items.map((i) => i.property_id)).toEqual([debt]);
        expect(page.items.map((i) => i.property_id)).not.toContain(nuda);
        expect(page.items.map((i) => i.property_id)).not.toContain(clean);

        // A different caveat value selects the other one.
        const nudaPage = await listCandidates(profileId, { caveat: "nuda_propiedad", limit: 10 });
        expect(nudaPage.items.map((i) => i.property_id)).toEqual([nuda]);
      });
    });

    it("redflagType=unfinished_construction keeps only obra-sin-terminar candidates (EC: owner's 'obra sin terminar' ask)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const unfinished = await seedTagged(pool, profileId, {
          redflagTypes: ["unfinished_construction"],
        });
        const embargo = await seedTagged(pool, profileId, { redflagTypes: ["embargo"] });
        // A property carrying BOTH types is kept by either filter (array membership).
        const both = await seedTagged(pool, profileId, {
          redflagTypes: ["embargo", "unfinished_construction"],
        });

        const page = await listCandidates(profileId, {
          redflagType: "unfinished_construction",
          limit: 10,
        });
        expect(page.items.map((i) => i.property_id).sort((a, b) => a - b)).toEqual(
          [unfinished, both].sort((a, b) => a - b),
        );
        expect(page.items.map((i) => i.property_id)).not.toContain(embargo);

        const embargoPage = await listCandidates(profileId, { redflagType: "embargo", limit: 10 });
        expect(embargoPage.items.map((i) => i.property_id).sort((a, b) => a - b)).toEqual(
          [embargo, both].sort((a, b) => a - b),
        );
      });
    });

    it("caveat and redflagType compose with each other and with an existing #310 filter", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Target: debt-sale AND unfinished-construction.
        const target = await seedTagged(pool, profileId, {
          caveats: ["venta_deuda"],
          redflagTypes: ["unfinished_construction"],
        });
        // Same caveat, wrong redflag → excluded by the redflag filter.
        const debtOnly = await seedTagged(pool, profileId, {
          caveats: ["venta_deuda"],
          redflagTypes: ["embargo"],
        });
        // Right redflag, no caveat → excluded by the caveat filter.
        const unfinishedOnly = await seedTagged(pool, profileId, {
          redflagTypes: ["unfinished_construction"],
        });

        const page = await listCandidates(profileId, {
          caveat: "venta_deuda",
          redflagType: "unfinished_construction",
          limit: 10,
        });
        expect(page.items.map((i) => i.property_id)).toEqual([target]);
        expect(page.items.map((i) => i.property_id)).not.toContain(debtOnly);
        expect(page.items.map((i) => i.property_id)).not.toContain(unfinishedOnly);
      });
    });

    it("degrades cleanly: a caveat/redflagType filter with NO assessment data returns an empty feed, not an error", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Matched + priced but never assessed — null caveats/redflag_types must
        // be excluded (unknown), never a false pass and never a throw.
        await seedTagged(pool, profileId, {});
        await seedTagged(pool, profileId, {});

        const cav = await listCandidates(profileId, { caveat: "venta_deuda", limit: 10 });
        expect(cav.items).toEqual([]);
        const rf = await listCandidates(profileId, {
          redflagType: "unfinished_construction",
          limit: 10,
        });
        expect(rf.items).toEqual([]);

        // Sanity: unfiltered, both properties come back — the empties above are
        // the filters' doing, not a broken feed.
        const unfiltered = await listCandidates(profileId, { limit: 10 });
        expect(unfiltered.items).toHaveLength(2);
      });
    });
  });

  describe("'Con alertas' UNION filter (#466, D-059)", () => {
    // Matched, priced candidate carrying optional occupancy caveats and/or
    // redflags flag types — seeded through the SAME `ai_assessment` rows the
    // ranking CTE reads, so the UNION filter and the warn badges agree.
    async function seedTagged(
      pool: Pool,
      profileId: number,
      opts: { caveats?: string[]; redflagTypes?: string[] },
    ): Promise<number> {
      const id = await insertProperty(pool);
      await insertListing(pool, id, { source: "fotocasa", current_price: 300000 });
      await markMatched(pool, profileId, id);
      if (opts.caveats) {
        await insertAssessment(pool, id, {
          assessmentType: "occupancy",
          result: { occupancy: { value: "vacant" }, caveats: opts.caveats },
          promptVersion: "occupancy/v2",
          generatedAt: new Date("2026-02-01T00:00:00Z"),
        });
      }
      if (opts.redflagTypes) {
        await insertAssessment(pool, id, {
          assessmentType: "redflags",
          result: {
            flags: opts.redflagTypes.map((t) => ({
              type: t,
              description: `check ${t}`,
              evidence: `menciona ${t}`,
              evidence_source: "fotocasa",
            })),
          },
          promptVersion: "redflags/v3",
          generatedAt: new Date("2026-02-01T00:00:00Z"),
        });
      }
      return id;
    }

    it("keeps candidates with ≥1 redflag OR ≥1 warn caveat; excludes clean + never-assessed", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Warn caveat only (no redflag).
        const caveatOnly = await seedTagged(pool, profileId, {
          caveats: ["venta_deuda"],
        });
        // Redflag only (no caveat).
        const redflagOnly = await seedTagged(pool, profileId, {
          redflagTypes: ["embargo"],
        });
        // Both.
        const both = await seedTagged(pool, profileId, {
          caveats: ["nuda_propiedad"],
          redflagTypes: ["litigio"],
        });
        // Assessed but clean: empty caveats, empty flags → NO alert.
        const clean = await seedTagged(pool, profileId, {
          caveats: [],
          redflagTypes: [],
        });
        // Never assessed at all → excluded (unknown, never a false pass).
        const neverAssessed = await seedTagged(pool, profileId, {});

        const page = await listCandidates(profileId, { hasAlerts: true, limit: 50 });
        const ids = page.items.map((i) => i.property_id).sort((a, b) => a - b);
        expect(ids).toEqual([caveatOnly, redflagOnly, both].sort((a, b) => a - b));
        expect(ids).not.toContain(clean);
        expect(ids).not.toContain(neverAssessed);

        // Sanity: unfiltered, all five come back — the exclusions are the
        // filter's doing, not a broken feed.
        const unfiltered = await listCandidates(profileId, { limit: 50 });
        expect(unfiltered.items).toHaveLength(5);
      });
    });

    it("a NON-warn caveat alone does not count as an alert", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // `pleno_dominio` is not in WARN_CAVEAT_CODES (and carries no warn badge),
        // so an occupancy assessment whose only caveat is that must NOT surface.
        const nonWarn = await seedTagged(pool, profileId, {
          caveats: ["pleno_dominio"],
        });
        const warn = await seedTagged(pool, profileId, { caveats: ["usufructo"] });

        const page = await listCandidates(profileId, { hasAlerts: true, limit: 50 });
        expect(page.items.map((i) => i.property_id)).toEqual([warn]);
        expect(page.items.map((i) => i.property_id)).not.toContain(nonWarn);
      });
    });

    it("composes (AND) with redflagType", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Has the specific redflag → survives both hasAlerts and the type filter.
        const target = await seedTagged(pool, profileId, {
          redflagTypes: ["unfinished_construction"],
        });
        // Has an alert (a warn caveat) but NOT that redflag type → dropped by the
        // composed redflagType filter even though hasAlerts alone would keep it.
        const otherAlert = await seedTagged(pool, profileId, {
          caveats: ["venta_deuda"],
        });

        const page = await listCandidates(profileId, {
          hasAlerts: true,
          redflagType: "unfinished_construction",
          limit: 50,
        });
        expect(page.items.map((i) => i.property_id)).toEqual([target]);
        expect(page.items.map((i) => i.property_id)).not.toContain(otherAlert);
      });
    });

    it("absent hasAlerts (off, #593) does not narrow the feed", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        await seedTagged(pool, profileId, { caveats: ["venta_deuda"] });
        await seedTagged(pool, profileId, {}); // never assessed
        const absent = await listCandidates(profileId, { limit: 50 });
        expect(absent.items).toHaveLength(2);
      });
    });

    // #593: the tri-state's whole point — "sin alertas" (hasAlerts: false)
    // must be the TRUE COMPLEMENT of "con alertas" (hasAlerts: true), derived
    // from the SAME predicate rather than a second one that can silently
    // drift (the #590 freshness-bug lesson the issue calls out by name).
    it("hasAlerts:false ('sin alertas') is the true complement of hasAlerts:true — the two partitions sum to the unfiltered (assessed) total, and a never-assessed candidate lands in NEITHER (D-059)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Flagged, three ways (same fixture shape as the "keeps candidates
        // with ≥1 redflag OR ≥1 warn caveat" test above).
        const caveatOnly = await seedTagged(pool, profileId, {
          caveats: ["venta_deuda"],
        });
        const redflagOnly = await seedTagged(pool, profileId, {
          redflagTypes: ["embargo"],
        });
        const both = await seedTagged(pool, profileId, {
          caveats: ["nuda_propiedad"],
          redflagTypes: ["litigio"],
        });
        // Assessed and genuinely clean (both axes checked, nothing found) —
        // the "sin alertas" case that must NOT be confused with "unassessed".
        const clean1 = await seedTagged(pool, profileId, {
          caveats: [],
          redflagTypes: [],
        });
        const clean2 = await seedTagged(pool, profileId, {
          caveats: [],
          redflagTypes: [],
        });
        // Never assessed at all — the judgement-call case (#593): excluded
        // from BOTH partitions, never counted as "sin alertas" just because
        // no evidence exists yet.
        const neverAssessed = await seedTagged(pool, profileId, {});

        const withAlerts = await listCandidates(profileId, {
          hasAlerts: true,
          limit: 50,
        });
        const withoutAlerts = await listCandidates(profileId, {
          hasAlerts: false,
          limit: 50,
        });
        const unfiltered = await listCandidates(profileId, { limit: 50 });

        const withIds = withAlerts.items
          .map((i) => i.property_id)
          .sort((a, b) => a - b);
        const withoutIds = withoutAlerts.items
          .map((i) => i.property_id)
          .sort((a, b) => a - b);

        expect(withIds).toEqual(
          [caveatOnly, redflagOnly, both].sort((a, b) => a - b),
        );
        expect(withoutIds).toEqual([clean1, clean2].sort((a, b) => a - b));

        // Disjoint (a candidate is never in both partitions at once)...
        expect(new Set([...withIds, ...withoutIds]).size).toBe(
          withIds.length + withoutIds.length,
        );
        // ...never-assessed excluded from BOTH (the D-059 judgement call)...
        expect(withIds).not.toContain(neverAssessed);
        expect(withoutIds).not.toContain(neverAssessed);
        // ...and — the assertion that actually proves "true complement" —
        // the two partitions sum to the unfiltered total MINUS the one
        // never-assessed candidate the tri-state deliberately excludes from
        // both. If the negative were a second, drifted predicate, this sum
        // would silently stop matching.
        expect(unfiltered.items).toHaveLength(6);
        expect(withIds.length + withoutIds.length).toBe(5);
      });
    });
  });

  describe("beach-proximity + heritage-zone filters and soft boost (#392, Fase 4 of #385)", () => {
    // A matched, priced candidate carrying an optional `location` assessment —
    // seeded through the SAME ai_assessment row the ranking CTE reads for both
    // the beach/heritage filters and the soft beach boost (D-059).
    async function seedLocated(
      pool: Pool,
      profileId: number,
      opts: { beach?: string; heritage?: boolean; score?: number | null },
    ): Promise<number> {
      const id = await insertProperty(pool);
      await insertListing(pool, id, { source: "fotocasa", current_price: 300000 });
      await markMatched(pool, profileId, id);
      if (opts.score !== undefined) await setScore(pool, profileId, id, opts.score);
      if (opts.beach !== undefined || opts.heritage !== undefined) {
        await insertAssessment(pool, id, {
          assessmentType: "location",
          result: {
            beach_proximity: opts.beach ?? "none",
            beach_evidence: opts.beach && opts.beach !== "none" ? `menciona ${opts.beach}` : "",
            heritage_zone: opts.heritage ?? false,
            heritage_evidence: opts.heritage ? "casco histórico" : "",
          },
          promptVersion: "location/v1",
          generatedAt: new Date("2026-03-01T00:00:00Z"),
        });
      }
      return id;
    }

    it("beachProximity=frontline keeps ONLY primera-línea candidates (owner's hard-filter ask)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const front = await seedLocated(pool, profileId, { beach: "frontline" });
        const view = await seedLocated(pool, profileId, { beach: "sea_view" });
        const near = await seedLocated(pool, profileId, { beach: "near_beach" });
        const none = await seedLocated(pool, profileId, { beach: "none" });

        const page = await listCandidates(profileId, { beachProximity: "frontline", limit: 10 });
        expect(page.items.map((i) => i.property_id)).toEqual([front]);
        for (const other of [view, near, none]) {
          expect(page.items.map((i) => i.property_id)).not.toContain(other);
        }
      });
    });

    it("beachProximity is a MINIMUM grade: sea_view keeps frontline+sea_view; near_beach keeps all three positive grades", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const front = await seedLocated(pool, profileId, { beach: "frontline" });
        const view = await seedLocated(pool, profileId, { beach: "sea_view" });
        const near = await seedLocated(pool, profileId, { beach: "near_beach" });
        const none = await seedLocated(pool, profileId, { beach: "none" });

        const sea = await listCandidates(profileId, { beachProximity: "sea_view", limit: 10 });
        expect(sea.items.map((i) => i.property_id).sort((a, b) => a - b)).toEqual(
          [front, view].sort((a, b) => a - b),
        );
        expect(sea.items.map((i) => i.property_id)).not.toContain(near);
        expect(sea.items.map((i) => i.property_id)).not.toContain(none);

        const nearOrBetter = await listCandidates(profileId, {
          beachProximity: "near_beach",
          limit: 10,
        });
        expect(nearOrBetter.items.map((i) => i.property_id).sort((a, b) => a - b)).toEqual(
          [front, view, near].sort((a, b) => a - b),
        );
        // 'none' (assessed, no signal) is still excluded from even the loosest grade.
        expect(nearOrBetter.items.map((i) => i.property_id)).not.toContain(none);
      });
    });

    it("heritageZone keeps only casco-histórico candidates; false and unassessed are excluded", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const heritage = await seedLocated(pool, profileId, { beach: "none", heritage: true });
        const notHeritage = await seedLocated(pool, profileId, { beach: "none", heritage: false });
        const unassessed = await seedLocated(pool, profileId, {}); // no location row at all

        const page = await listCandidates(profileId, { heritageZone: true, limit: 10 });
        expect(page.items.map((i) => i.property_id)).toEqual([heritage]);
        expect(page.items.map((i) => i.property_id)).not.toContain(notHeritage);
        expect(page.items.map((i) => i.property_id)).not.toContain(unassessed);
      });
    });

    it("degrades cleanly: a beach/heritage filter with NO location assessment returns an empty feed, not an error", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        await seedLocated(pool, profileId, {}); // matched + priced, never assessed
        await seedLocated(pool, profileId, {});

        const beach = await listCandidates(profileId, { beachProximity: "frontline", limit: 10 });
        expect(beach.items).toEqual([]);
        const heritage = await listCandidates(profileId, { heritageZone: true, limit: 10 });
        expect(heritage.items).toEqual([]);

        // Sanity: unfiltered, both properties come back — the empties are the
        // filters' doing (null beach_proximity/heritage_zone = unknown), not a break.
        const unfiltered = await listCandidates(profileId, { limit: 10 });
        expect(unfiltered.items).toHaveLength(2);
      });
    });

    it("SOFT boost: a sea-view candidate floats above an equal-base non-beach one, which keeps its base score (no filtering)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Only two candidates → pool below MIN_POOL_SIZE, so no below-market boost;
        // same price + same base score, so ONLY the beach grade differs.
        const plain = await seedLocated(pool, profileId, { beach: "none", score: 0.5 });
        const seaView = await seedLocated(pool, profileId, { beach: "sea_view", score: 0.5 });

        const page = await listCandidates(profileId, { limit: 10 });
        const order = page.items.map((i) => i.property_id);
        // The sea-view candidate is lifted above the equal-base plain one — but the
        // plain one is NOT filtered out (soft boost, both still present).
        expect(order.indexOf(seaView)).toBeLessThan(order.indexOf(plain));
        expect(order).toContain(plain);

        const seaRow = page.items.find((i) => i.property_id === seaView)!;
        const plainRow = page.items.find((i) => i.property_id === plain)!;
        // sea_view = 2 units × 0.03 = +0.06 over the base 0.5.
        expect(seaRow.effective_score!).toBeCloseTo(0.56, 5);
        expect(seaRow.ranking_boost_reason).toContain("proximidad a la playa");
        // The non-beach candidate keeps EXACTLY its base score (augment, never sink).
        expect(plainRow.effective_score!).toBeCloseTo(0.5, 5);
        expect(plainRow.ranking_boost_reason).toBeNull();
      });
    });
  });

  describe("VPO hard filter + tourist-licence soft boost (#398, Fase 5 of #385)", () => {
    // A matched, priced candidate carrying an optional `opportunity` assessment —
    // seeded through the SAME ai_assessment row the ranking CTE reads for both the
    // VPO hard filter and the soft tourist-licence boost (D-059).
    async function seedOpportunity(
      pool: Pool,
      profileId: number,
      opts: { vpo?: boolean; tourist?: boolean; score?: number | null; assessed?: boolean },
    ): Promise<number> {
      const id = await insertProperty(pool);
      await insertListing(pool, id, { source: "fotocasa", current_price: 300000 });
      await markMatched(pool, profileId, id);
      if (opts.score !== undefined) await setScore(pool, profileId, id, opts.score);
      // `assessed` defaults true; pass assessed:false to seed NO opportunity row.
      if (opts.assessed !== false) {
        await insertAssessment(pool, id, {
          assessmentType: "opportunity",
          result: {
            is_vpo: opts.vpo ?? false,
            vpo_evidence: opts.vpo ? "vivienda de protección oficial" : "",
            tourist_license: opts.tourist ?? false,
            tourist_license_evidence: opts.tourist ? "licencia turística concedida" : "",
          },
          promptVersion: "opportunity/v1",
          generatedAt: new Date("2026-03-01T00:00:00Z"),
        });
      }
      return id;
    }

    it("isVpo=true keeps ONLY VPO candidates (owner's buscar-VPO direction)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const vpo = await seedOpportunity(pool, profileId, { vpo: true });
        const notVpo = await seedOpportunity(pool, profileId, { vpo: false });
        const unassessed = await seedOpportunity(pool, profileId, { assessed: false });

        const page = await listCandidates(profileId, { isVpo: true, limit: 10 });
        expect(page.items.map((i) => i.property_id)).toEqual([vpo]);
        expect(page.items.map((i) => i.property_id)).not.toContain(notVpo);
        // NULL is_vpo (never assessed) is excluded — unknown, never a false pass.
        expect(page.items.map((i) => i.property_id)).not.toContain(unassessed);
      });
    });

    it("isVpo=false keeps ONLY non-VPO candidates (excluir-VPO direction), excluding unassessed too", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const vpo = await seedOpportunity(pool, profileId, { vpo: true });
        const notVpo = await seedOpportunity(pool, profileId, { vpo: false });
        const unassessed = await seedOpportunity(pool, profileId, { assessed: false });

        const page = await listCandidates(profileId, { isVpo: false, limit: 10 });
        expect(page.items.map((i) => i.property_id)).toEqual([notVpo]);
        expect(page.items.map((i) => i.property_id)).not.toContain(vpo);
        // Excluding VPO must NOT smuggle in an unassessed property as "not VPO":
        // we don't know, so it stays out (unknown, never a false pass).
        expect(page.items.map((i) => i.property_id)).not.toContain(unassessed);
      });
    });

    it("degrades cleanly: a VPO filter with NO opportunity assessment returns an empty feed, not an error", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        await seedOpportunity(pool, profileId, { assessed: false });
        await seedOpportunity(pool, profileId, { assessed: false });

        expect((await listCandidates(profileId, { isVpo: true, limit: 10 })).items).toEqual([]);
        expect((await listCandidates(profileId, { isVpo: false, limit: 10 })).items).toEqual([]);
        // Sanity: unfiltered, both come back — the empties are the filter's doing.
        expect((await listCandidates(profileId, { limit: 10 })).items).toHaveLength(2);
      });
    });

    it("SOFT boost: a tourist-licence candidate floats above an equal-base one, which keeps its base score (no filtering)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        // Two candidates → pool below MIN_POOL_SIZE (no below-market boost); same
        // price + base score, so ONLY the tourist-licence boolean differs.
        const plain = await seedOpportunity(pool, profileId, { tourist: false, score: 0.5 });
        const licensed = await seedOpportunity(pool, profileId, { tourist: true, score: 0.5 });

        const page = await listCandidates(profileId, { limit: 10 });
        const order = page.items.map((i) => i.property_id);
        // Licensed candidate is lifted above the equal-base plain one, but the
        // plain one is NOT filtered out (soft boost, both still present).
        expect(order.indexOf(licensed)).toBeLessThan(order.indexOf(plain));
        expect(order).toContain(plain);

        const licRow = page.items.find((i) => i.property_id === licensed)!;
        const plainRow = page.items.find((i) => i.property_id === plain)!;
        // tourist_license = +0.04 over the base 0.5.
        expect(licRow.effective_score!).toBeCloseTo(0.54, 5);
        expect(licRow.ranking_boost_reason).toContain("licencia turística concedida");
        // The unlicensed candidate keeps EXACTLY its base score (augment, never sink).
        expect(plainRow.effective_score!).toBeCloseTo(0.5, 5);
        expect(plainRow.ranking_boost_reason).toBeNull();
      });
    });

    it("tourist_license is NEVER a filter: an unlicensed candidate is never dropped by any opportunity control", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const licensed = await seedOpportunity(pool, profileId, { tourist: true });
        const unlicensed = await seedOpportunity(pool, profileId, { tourist: false });

        // No isVpo filter → both present regardless of licence (boost lifts, never filters).
        const page = await listCandidates(profileId, { limit: 10 });
        expect(page.items.map((i) => i.property_id).sort((a, b) => a - b)).toEqual(
          [licensed, unlicensed].sort((a, b) => a - b),
        );
      });
    });
  });

  describe("source (portal) filter (#265)", () => {
    it("narrows the feed to properties with an active sale listing from the selected source", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);

        // Property A: idealista-only.
        const idealistaOnly = await insertProperty(pool);
        await insertListing(pool, idealistaOnly, { source: "idealista" });
        await markMatched(pool, profileId, idealistaOnly);

        // Property B: fotocasa-only.
        const fotocasaOnly = await insertProperty(pool);
        await insertListing(pool, fotocasaOnly, { source: "fotocasa" });
        await markMatched(pool, profileId, fotocasaOnly);

        // Unfiltered: both properties.
        const all = await listCandidates(profileId);
        expect(all.items.map((i) => i.property_id).sort((a, b) => a - b)).toEqual(
          [idealistaOnly, fotocasaOnly].sort((a, b) => a - b),
        );

        // Filtered to idealista: only property A.
        const filtered = await listCandidates(profileId, { source: "idealista" });
        expect(filtered.items.map((i) => i.property_id)).toEqual([idealistaOnly]);
      });
    });

    it("matches a deduplicated property when ANY of its listings is from the source", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);

        // One property with two source listings (the post-dedup shape).
        const multi = await insertProperty(pool);
        await insertListing(pool, multi, { source: "fotocasa", current_price: 285000 });
        await insertListing(pool, multi, { source: "solvia", current_price: 279000 });
        await markMatched(pool, profileId, multi);

        // Filtering by EITHER source returns the single deduplicated card,
        // still carrying BOTH badges (the filter narrows which properties
        // appear, never which listings a surviving card shows).
        for (const src of ["fotocasa", "solvia"]) {
          const page = await listCandidates(profileId, { source: src });
          expect(page.items.map((i) => i.property_id)).toEqual([multi]);
          expect(page.items[0].listings.map((l) => l.source).sort()).toEqual(["fotocasa", "solvia"]);
        }
      });
    });

    it("ignores a withdrawn or rent-only listing's source (matches the visible badge set)", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const propertyId = await insertProperty(pool);
        // Active sale from fotocasa (the badge the card shows) + a WITHDRAWN
        // aliseda listing that must NOT make the card matchable by "aliseda".
        await insertListing(pool, propertyId, { source: "fotocasa", status: "active" });
        await insertListing(pool, propertyId, { source: "aliseda", status: "withdrawn" });
        await markMatched(pool, profileId, propertyId);

        const byWithdrawn = await listCandidates(profileId, { source: "aliseda" });
        expect(byWithdrawn.items).toHaveLength(0);

        const byActive = await listCandidates(profileId, { source: "fotocasa" });
        expect(byActive.items.map((i) => i.property_id)).toEqual([propertyId]);
      });
    });

    it("combines with keyset pagination — the filter holds across pages", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const idealistaIds: number[] = [];
        for (let i = 0; i < 3; i++) {
          const id = await insertProperty(pool);
          await insertListing(pool, id, { source: "idealista" });
          await markMatched(pool, profileId, id);
          idealistaIds.push(id);
          // Interleave a fotocasa property that must never appear under the
          // idealista filter, on any page.
          const other = await insertProperty(pool);
          await insertListing(pool, other, { source: "fotocasa" });
          await markMatched(pool, profileId, other);
        }

        const first = await listCandidates(profileId, { source: "idealista", limit: 2 });
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).not.toBeNull();

        const second = await listCandidates(profileId, {
          source: "idealista",
          cursor: first.nextCursor,
          limit: 2,
        });
        expect(second.items).toHaveLength(1);
        expect(second.nextCursor).toBeNull();

        const seen = [...first.items, ...second.items].map((i) => i.property_id).sort((a, b) => a - b);
        expect(seen).toEqual([...idealistaIds].sort((a, b) => a - b));
      });
    });

    it("treats an empty/whitespace source as no filter", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);
        const a = await insertProperty(pool);
        await insertListing(pool, a, { source: "idealista" });
        await markMatched(pool, profileId, a);
        const b = await insertProperty(pool);
        await insertListing(pool, b, { source: "fotocasa" });
        await markMatched(pool, profileId, b);

        const page = await listCandidates(profileId, { source: "   " });
        expect(page.items).toHaveLength(2);
      });
    });
  });

  describe("hides data from disabled sources (#319 / D-055)", () => {
    // Connector names this block registers, cleaned up per-test. `listing.source`
    // equals `connector_registry.connector_name` (see lib/db/source-active.ts),
    // so a listing's source resolves to its connector's on/off state.
    const NORMAL_OFF = "d319-normal-off";
    const NORMAL_ON = "d319-normal-on";
    const CAPTURE_OFF = "d319-capture-off";
    const CAPTURE_ON = "d319-capture-on";
    const ALL_CONNS = [NORMAL_OFF, NORMAL_ON, CAPTURE_OFF, CAPTURE_ON];

    // Register a connector + its config so the feed can resolve its source
    // to an on/off state. `supportsDiscovery=false` marks a capture-only
    // connector (its OFF state is capture_enabled=false); a normal connector's
    // OFF state is enabled=false.
    async function registerConnector(
      pool: Pool,
      name: string,
      opts: { supportsDiscovery: boolean; on: boolean },
    ) {
      await pool.query(
        `INSERT INTO connector_registry
           (connector_name, registered, supports_discovery, supported_filters)
         VALUES ($1, true, $2, '[]'::jsonb)
         ON CONFLICT (connector_name) DO UPDATE SET supports_discovery = EXCLUDED.supports_discovery`,
        [name, opts.supportsDiscovery],
      );
      // enabled drives a normal connector's on/off; capture_enabled drives a
      // capture-only one. Set both explicitly so the row is unambiguous.
      const enabled = opts.supportsDiscovery ? opts.on : true;
      const captureEnabled = opts.supportsDiscovery ? true : opts.on;
      await pool.query(
        `INSERT INTO connector_config (connector_name, enabled, capture_enabled, filters)
         VALUES ($1, $2, $3, '{}'::jsonb)
         ON CONFLICT (connector_name) DO UPDATE SET enabled = $2, capture_enabled = $3`,
        [name, enabled, captureEnabled],
      );
    }

    afterEach(async () => {
      await withRealDb(async (pool) => {
        await pool.query("DELETE FROM connector_config WHERE connector_name = ANY($1::text[])", [ALL_CONNS]);
        await pool.query("DELETE FROM connector_registry WHERE connector_name = ANY($1::text[])", [ALL_CONNS]);
      });
    });

    it("excludes a property whose only active-sale listing is from a disabled NORMAL connector", async () => {
      await withRealDb(async (pool) => {
        await registerConnector(pool, NORMAL_OFF, { supportsDiscovery: true, on: false });
        await registerConnector(pool, NORMAL_ON, { supportsDiscovery: true, on: true });
        const profileId = await makeProfile(SCOPE);

        const offProp = await insertProperty(pool);
        await insertListing(pool, offProp, { source: NORMAL_OFF });
        await markMatched(pool, profileId, offProp);

        const onProp = await insertProperty(pool);
        await insertListing(pool, onProp, { source: NORMAL_ON });
        await markMatched(pool, profileId, onProp);

        const page = await listCandidates(profileId);
        expect(page.items.map((i) => i.property_id)).toEqual([onProp]);
      });
    });

    it("excludes a property from a disabled CAPTURE-ONLY connector, includes an enabled one", async () => {
      await withRealDb(async (pool) => {
        await registerConnector(pool, CAPTURE_OFF, { supportsDiscovery: false, on: false });
        await registerConnector(pool, CAPTURE_ON, { supportsDiscovery: false, on: true });
        const profileId = await makeProfile(SCOPE);

        const offProp = await insertProperty(pool);
        await insertListing(pool, offProp, { source: CAPTURE_OFF });
        await markMatched(pool, profileId, offProp);

        const onProp = await insertProperty(pool);
        await insertListing(pool, onProp, { source: CAPTURE_ON });
        await markMatched(pool, profileId, onProp);

        const page = await listCandidates(profileId);
        expect(page.items.map((i) => i.property_id)).toEqual([onProp]);
      });
    });

    it("keeps a property that has an enabled source, but drops the disabled source's badge/price", async () => {
      await withRealDb(async (pool) => {
        await registerConnector(pool, NORMAL_OFF, { supportsDiscovery: true, on: false });
        await registerConnector(pool, NORMAL_ON, { supportsDiscovery: true, on: true });
        const profileId = await makeProfile(SCOPE);

        const propertyId = await insertProperty(pool);
        // Enabled source at a higher price, disabled source at a lower price:
        // if the disabled listing leaked into MIN it would win — proving it's
        // genuinely excluded, not just hidden from the badge list.
        await insertListing(pool, propertyId, { source: NORMAL_ON, current_price: 300000 });
        await insertListing(pool, propertyId, { source: NORMAL_OFF, current_price: 100000 });
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);
        expect(page.items).toHaveLength(1);
        expect(page.items[0].listings.map((l) => l.source)).toEqual([NORMAL_ON]);
        expect(page.items[0].min_price).toBe(300000);
      });
    });

    it("treats a source with no registry/config row as active (default on)", async () => {
      await withRealDb(async (pool) => {
        // No registerConnector call at all — the source is unknown to the
        // registry, which must default to active (matching the ETL's
        // missing-row defaults), not vanish from the feed.
        const profileId = await makeProfile(SCOPE);
        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId, { source: "d319-unregistered" });
        await markMatched(pool, profileId, propertyId);

        const page = await listCandidates(profileId);
        expect(page.items.map((i) => i.property_id)).toEqual([propertyId]);
      });
    });

    it("listCandidateSources omits a disabled source from the filter options", async () => {
      await withRealDb(async (pool) => {
        await registerConnector(pool, NORMAL_OFF, { supportsDiscovery: true, on: false });
        await registerConnector(pool, NORMAL_ON, { supportsDiscovery: true, on: true });
        const profileId = await makeProfile(SCOPE);

        const propertyId = await insertProperty(pool);
        await insertListing(pool, propertyId, { source: NORMAL_ON });
        await insertListing(pool, propertyId, { source: NORMAL_OFF });
        await markMatched(pool, profileId, propertyId);

        const sources = await listCandidateSources(profileId);
        expect(sources).toEqual([NORMAL_ON]);
      });
    });
  });

  describe("listCandidateSources (#265)", () => {
    it("returns the distinct active-sale sources present for the profile, alphabetically", async () => {
      await withRealDb(async (pool) => {
        const profileId = await makeProfile(SCOPE);

        const p1 = await insertProperty(pool);
        await insertListing(pool, p1, { source: "solvia" });
        await insertListing(pool, p1, { source: "aliseda" });
        await markMatched(pool, profileId, p1);

        const p2 = await insertProperty(pool);
        await insertListing(pool, p2, { source: "fotocasa" });
        // A withdrawn source must not appear in the options — it can't be
        // used to narrow anything (the filter is active-sale only).
        await insertListing(pool, p2, { source: "milanuncios", status: "withdrawn" });
        await markMatched(pool, profileId, p2);

        const sources = await listCandidateSources(profileId);
        expect(sources).toEqual(["aliseda", "fotocasa", "solvia"]);
      });
    });

    it("excludes sources from unmatched properties and returns [] when the profile has none", async () => {
      await withRealDb(async (pool) => {
        const emptyProfile = await makeProfile(SCOPE);
        expect(await listCandidateSources(emptyProfile)).toEqual([]);

        const profileId = await makeProfile(SCOPE);
        const unmatched = await insertProperty(pool);
        await insertListing(pool, unmatched, { source: "idealista" });
        await markMatched(pool, profileId, unmatched, false);
        expect(await listCandidateSources(profileId)).toEqual([]);
      });
    });
  });
});

describe.runIf(dbAvailable)("getAdjacentCandidates — real Postgres", () => {
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
      // feedback_event has a NOT NULL FK to property(id), so it must be deleted
      // before the properties it references (#417 adjacency tests seed rejects).
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM feedback_event WHERE property_id = ANY($1::bigint[])", [
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

  async function insertProperty(pool: Pool): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', 70, 'Calle de prueba, adjacent-int-test') RETURNING id`,
      [TEST_COORDS[0], TEST_COORDS[1]],
    );
    const id = Number(result.rows[0].id);
    createdPropertyIds.push(id);
    return id;
  }

  async function rejectProperty(pool: Pool, profileId: number, propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO feedback_event (profile_id, property_id, feedback_type) VALUES ($1, $2, 'reject')`,
      [profileId, propertyId],
    );
  }

  async function makeProfile(): Promise<number> {
    const scope: Scope = {
      geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
      property_types: ["piso"],
      hard_exclusions: {},
    };
    const profile = await createProfile(`adjacent-int-test-${Date.now()}-${Math.random()}`, scope, {});
    createdProfileIds.push(profile.id);
    return profile.id;
  }

  async function seedRanked(pool: Pool, profileId: number, scores: (number | null)[]): Promise<number[]> {
    const ids: number[] = [];
    for (const score of scores) {
      const propertyId = await insertProperty(pool);
      await pool.query(
        `INSERT INTO profile_listing_state (profile_id, property_id, matched, score)
         VALUES ($1, $2, true, $3)`,
        [profileId, propertyId, score],
      );
      ids.push(propertyId);
    }
    return ids;
  }

  it("returns the correct prev/next for a candidate in the middle of the ranking", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile();
      const [top, middle, bottom] = await seedRanked(pool, profileId, [0.9, 0.5, 0.1]);

      const result = await getAdjacentCandidates(profileId, middle);
      expect(result.prevPropertyId).toBe(top);
      expect(result.nextPropertyId).toBe(bottom);
    });
  });

  it("returns null for prev at the top of the ranking, and null for next at the bottom", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile();
      const [top, , bottom] = await seedRanked(pool, profileId, [0.9, 0.5, 0.1]);

      const topResult = await getAdjacentCandidates(profileId, top);
      expect(topResult.prevPropertyId).toBeNull();
      expect(topResult.nextPropertyId).not.toBeNull();

      const bottomResult = await getAdjacentCandidates(profileId, bottom);
      expect(bottomResult.nextPropertyId).toBeNull();
      expect(bottomResult.prevPropertyId).not.toBeNull();
    });
  });

  it("breaks a tied score by property_id DESC, matching listCandidates's own tiebreak", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile();
      const a = await insertProperty(pool);
      const b = await insertProperty(pool);
      const [lo, hi] = [a, b].sort((x, y) => x - y);
      for (const id of [a, b]) {
        await pool.query(
          `INSERT INTO profile_listing_state (profile_id, property_id, matched, score) VALUES ($1, $2, true, 0.5)`,
          [profileId, id],
        );
      }

      // listCandidates orders ties by id DESC — the higher id ranks first.
      const page = await listCandidates(profileId);
      expect(page.items.map((i) => i.property_id)).toEqual([hi, lo]);

      // getAdjacentCandidates must agree: the higher id's "next" is the lower id.
      const hiResult = await getAdjacentCandidates(profileId, hi);
      expect(hiResult.nextPropertyId).toBe(lo);
      expect(hiResult.prevPropertyId).toBeNull();

      const loResult = await getAdjacentCandidates(profileId, lo);
      expect(loResult.prevPropertyId).toBe(hi);
      expect(loResult.nextPropertyId).toBeNull();
    });
  });

  it("treats a NULL score as ranked last, consistent with listCandidates's NO_SCORE_SENTINEL", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile();
      const [scored, unscored] = await seedRanked(pool, profileId, [0.5, null]);

      const scoredResult = await getAdjacentCandidates(profileId, scored);
      expect(scoredResult.nextPropertyId).toBe(unscored);

      const unscoredResult = await getAdjacentCandidates(profileId, unscored);
      expect(unscoredResult.prevPropertyId).toBe(scored);
      expect(unscoredResult.nextPropertyId).toBeNull();
    });
  });

  it("returns null/null for a property that isn't matched for this profile", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile();
      const propertyId = await insertProperty(pool);
      // Deliberately not inserted into profile_listing_state at all.

      const result = await getAdjacentCandidates(profileId, propertyId);
      expect(result).toEqual({ prevPropertyId: null, nextPropertyId: null });
    });
  });

  it("returns null/null for a property marked matched=false", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile();
      const propertyId = await insertProperty(pool);
      await pool.query(
        `INSERT INTO profile_listing_state (profile_id, property_id, matched, score) VALUES ($1, $2, false, 0.5)`,
        [profileId, propertyId],
      );

      const result = await getAdjacentCandidates(profileId, propertyId);
      expect(result).toEqual({ prevPropertyId: null, nextPropertyId: null });
    });
  });

  it("scopes neighbours to this profile — a higher/lower-scored candidate in another profile is never returned", async () => {
    await withRealDb(async (pool) => {
      const profileA = await makeProfile();
      const profileB = await makeProfile();
      const [aOnly] = await seedRanked(pool, profileA, [0.5]);
      // A property scored much higher, but matched only for profile B —
      // must never appear as profile A's neighbour of aOnly.
      const outsider = await insertProperty(pool);
      await pool.query(
        `INSERT INTO profile_listing_state (profile_id, property_id, matched, score) VALUES ($1, $2, true, 0.99)`,
        [profileB, outsider],
      );

      const result = await getAdjacentCandidates(profileA, aOnly);
      expect(result).toEqual({ prevPropertyId: null, nextPropertyId: null });
    });
  });

  // #417: prev/next must honour the feed's includeRejected escape hatch so it
  // never desyncs from the show-rejected list the user is paging through.
  it("skips a rejected neighbour by default, so prev/next matches the default feed", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile();
      const [top, middle, bottom] = await seedRanked(pool, profileId, [0.9, 0.5, 0.1]);
      await rejectProperty(pool, profileId, middle);

      // Default (includeRejected omitted): the rejected middle is invisible, so
      // top's next jumps straight to bottom — exactly what the default feed shows.
      const topResult = await getAdjacentCandidates(profileId, top);
      expect(topResult.nextPropertyId).toBe(bottom);
      const bottomResult = await getAdjacentCandidates(profileId, bottom);
      expect(bottomResult.prevPropertyId).toBe(top);
    });
  });

  it("includes a rejected neighbour with includeRejected=true, in the same order as the show-rejected list", async () => {
    await withRealDb(async (pool) => {
      const profileId = await makeProfile();
      const [top, middle, bottom] = await seedRanked(pool, profileId, [0.9, 0.5, 0.1]);
      await rejectProperty(pool, profileId, middle);

      // includeRejected=true: prev/next steps ONTO the rejected middle, matching
      // the order the show-rejected feed pages through (top → middle → bottom).
      const topResult = await getAdjacentCandidates(profileId, top, true);
      expect(topResult.nextPropertyId).toBe(middle);

      const middleResult = await getAdjacentCandidates(profileId, middle, true);
      expect(middleResult.prevPropertyId).toBe(top);
      expect(middleResult.nextPropertyId).toBe(bottom);

      const bottomResult = await getAdjacentCandidates(profileId, bottom, true);
      expect(bottomResult.prevPropertyId).toBe(middle);
    });
  });
});
