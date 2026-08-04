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
import { getAdjacentCandidates, listCandidates } from "../candidates";
import { getPropertyDetail } from "../property-detail";
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
});
