/**
 * Real-Postgres integration test for `getPropertyDetail` (task 2.8, #44).
 *
 * This module previously had zero test coverage of its own — the only thing
 * exercising it was e2e (`e2e/property-detail.spec.ts`, `e2e/card-detail-ux.spec.ts`),
 * which can assert what's rendered but not cheaply pin down the exact
 * ordering/filtering rule the photo union follows. #167's review (must-fix
 * 1) found a real divergence between this function's photo union and
 * `lib/candidates.ts`'s card photo query — no status filter here vs.
 * active-only there, `ORDER BY source` here vs. `ORDER BY listing.id` there —
 * so a card's lead photo and the detail page's hero photo could (and did)
 * disagree. Fixed by aligning both on: active listings only, ordered by
 * `source` then within-listing position. The cross-check that both real
 * code paths agree lives in candidates.integration.test.ts (it already
 * imports both); this file covers `getPropertyDetail`'s own contract in
 * isolation.
 *
 * Same per-run isolated database + exact-id cleanup pattern as
 * candidates.integration.test.ts — see that file's header for the two
 * distinct race hazards this discipline avoids.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { getPropertyDetail } from "../property-detail";

// Same rationale as candidates.integration.test.ts: coordinates far from
// MADRID_SOL/other integration files' test data, though this file's queries
// are all by exact property id, not geography, so cross-file collision isn't
// actually a risk here — kept for consistency with the sibling file.
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
      "[property-detail.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("getPropertyDetail — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdPropertyIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
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
      photo_urls: string[] | null;
    }> = {},
  ): Promise<void> {
    const row = {
      source: "fotocasa",
      status: "active",
      photo_urls: null as string[] | null,
      ...overrides,
    };
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, first_seen_at, photo_urls)
       VALUES ($1, $2, $3, $4, NOW(), $5)`,
      [propertyId, row.source, `pd-int-test-${Math.random().toString(36).slice(2)}`, row.status, row.photo_urls],
    );
  }

  it("returns null for a property that doesn't exist", async () => {
    const detail = await getPropertyDetail(-1);
    expect(detail).toBeNull();
  });

  it("excludes a withdrawn listing's photos from the gallery, matching lib/candidates.ts's active-only rule", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      await insertListing(pool, propertyId, { source: "fotocasa", status: "active", photo_urls: ["https://a/1.jpg"] });
      await insertListing(pool, propertyId, {
        source: "aliseda",
        status: "withdrawn",
        photo_urls: ["https://withdrawn/1.jpg"],
      });

      const detail = await getPropertyDetail(propertyId);

      expect(detail!.photo_urls).toEqual(["https://a/1.jpg"]);
    });
  });

  it("still lists a withdrawn listing (with its status) in `listings`, even though its photos are excluded from the gallery", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      await insertListing(pool, propertyId, {
        source: "aliseda",
        status: "withdrawn",
        photo_urls: ["https://withdrawn/1.jpg"],
      });

      const detail = await getPropertyDetail(propertyId);

      expect(detail!.photo_urls).toEqual([]);
      expect(detail!.listings).toHaveLength(1);
      expect(detail!.listings[0]).toMatchObject({ source: "aliseda", status: "withdrawn" });
    });
  });

  it("orders the photo union by listing SOURCE, not by insertion/id order (#167 review must-fix 1)", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      // milanuncios inserted (and thus id-ordered) first, fotocasa second —
      // an id-ordered gallery would put milanuncios's photo first; a
      // source-ordered one puts fotocasa's first ("fotocasa" < "milanuncios").
      await insertListing(pool, propertyId, { source: "milanuncios", photo_urls: ["https://m/1.jpg"] });
      await insertListing(pool, propertyId, { source: "fotocasa", photo_urls: ["https://f/1.jpg"] });

      const detail = await getPropertyDetail(propertyId);

      expect(detail!.photo_urls).toEqual(["https://f/1.jpg", "https://m/1.jpg"]);
    });
  });

  it("de-duplicates a photo URL repeated across listings, keeping its first (source-order) occurrence", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      await insertListing(pool, propertyId, {
        source: "fotocasa",
        photo_urls: ["https://a/1.jpg", "https://a/2.jpg"],
      });
      await insertListing(pool, propertyId, {
        source: "milanuncios",
        photo_urls: ["https://a/2.jpg", "https://b/3.jpg"],
      });

      const detail = await getPropertyDetail(propertyId);

      expect(detail!.photo_urls).toEqual(["https://a/1.jpg", "https://a/2.jpg", "https://b/3.jpg"]);
    });
  });

  it("drops a NULL element from photo_urls instead of propagating it into the gallery", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      await insertListing(pool, propertyId, {
        source: "fotocasa",
        photo_urls: ["https://a/1.jpg", null as unknown as string, "https://a/2.jpg"],
      });

      const detail = await getPropertyDetail(propertyId);

      expect(detail!.photo_urls).toEqual(["https://a/1.jpg", "https://a/2.jpg"]);
    });
  });

  it("is NOT capped — unlike the card's MAX_CARD_PHOTOS, the detail gallery returns every photo", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const manyPhotos = Array.from({ length: 12 }, (_, i) => `https://a/${i + 1}.jpg`);
      await insertListing(pool, propertyId, { photo_urls: manyPhotos });

      const detail = await getPropertyDetail(propertyId);

      expect(detail!.photo_urls).toEqual(manyPhotos);
    });
  });
});
