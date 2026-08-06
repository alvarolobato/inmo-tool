/**
 * Real-Postgres integration tests for issue #34's days-on-market & price-drop
 * signals (lib/analytics/market-signals.ts).
 *
 * Real-DB round-trips, not mocked query assertions, for the same reason
 * area-price.test.ts is: every signal here is hand-built SQL over
 * `listing_price_history` / `listing_status_event` (a correlated
 * last-price-before-withdrawal subquery, a UNION of first_seen_at + explicit
 * re-activations, a freeze-at-terminal-status CASE) — shapes that are easy to
 * get subtly wrong in a way no TypeScript-level test would catch. Same
 * skip-cleanly-without-a-DB pattern, and the same distinct-coordinate
 * discipline (though these queries are keyed by explicit property/listing id,
 * not a geographic radius, so cross-file fixture bleed can't reach them).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import {
  computeListingSignals,
  computeRelistedLower,
  computePropertyScoringSignals,
} from "../market-signals";

const DAY_MS = 86_400_000;

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
      "[market-signals.test] no reachable Postgres (POSTGRES_DSN unset or DB down) - skipping real-DB tests.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("market-signals — real Postgres", () => {
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
        // price_history / status_event cascade from listing (ON DELETE CASCADE).
        await pool.query(
          "DELETE FROM listing WHERE property_id = ANY($1::bigint[])",
          [createdPropertyIds],
        );
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
      }
    });
  });

  async function insertProperty(pool: Pool): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (property_type, m2_built) VALUES ('piso', 100) RETURNING id`,
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
      status: string;
      current_price: number;
      first_seen_at: string;
    }> = {},
  ): Promise<number> {
    const row = {
      source: "fotocasa",
      status: "active",
      current_price: 300000,
      first_seen_at: new Date().toISOString(),
      ...overrides,
    };
    const result = await pool.query<{ id: number }>(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        propertyId,
        row.source,
        `market-signals-test-${Math.random().toString(36).slice(2)}`,
        row.status,
        row.current_price,
        row.first_seen_at,
      ],
    );
    return result.rows[0].id;
  }

  async function insertPricePoint(
    pool: Pool,
    listingId: number,
    observedAt: string,
    price: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO listing_price_history (listing_id, observed_at, price) VALUES ($1, $2, $3)`,
      [listingId, observedAt, price],
    );
  }

  async function insertStatusEvent(
    pool: Pool,
    listingId: number,
    observedAt: string,
    status: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO listing_status_event (listing_id, observed_at, status) VALUES ($1, $2, $3)`,
      [listingId, observedAt, status],
    );
  }

  // ---- EC-1 --------------------------------------------------------------
  it("computes price drop history correctly", async () => {
    await withRealDb(async (pool) => {
      const now = Date.now();
      const propertyId = await insertProperty(pool);
      const listingId = await insertListing(pool, propertyId, {
        current_price: 285000,
        first_seen_at: new Date(now - 20 * DAY_MS).toISOString(),
      });

      // Three recorded price points: initial (300k), one drop (285k), and a
      // later re-observation still at 285k ("current"). Exactly ONE decrease
      // between consecutive points, so exactly one drop event — and the net
      // first->last drop is (300000 - 285000) / 300000 = 0.05.
      await insertPricePoint(
        pool,
        listingId,
        new Date(now - 20 * DAY_MS).toISOString(),
        300000,
      );
      await insertPricePoint(
        pool,
        listingId,
        new Date(now - 10 * DAY_MS).toISOString(),
        285000,
      );
      await insertPricePoint(
        pool,
        listingId,
        new Date(now - 2 * DAY_MS).toISOString(),
        285000,
      );

      const signals = await computeListingSignals(listingId);
      expect(signals).not.toBeNull();
      expect(signals!.price_drop_pct_since_listing).toBeCloseTo(0.05, 6);
      expect(signals!.price_drop_events).toHaveLength(1);
      expect(signals!.price_drop_events[0].old_price).toBe(300000);
      expect(signals!.price_drop_events[0].new_price).toBe(285000);
    });
  });

  it("returns null price_drop_pct_since_listing when only one price was ever recorded", async () => {
    await withRealDb(async (pool) => {
      const now = Date.now();
      const propertyId = await insertProperty(pool);
      const listingId = await insertListing(pool, propertyId, {
        first_seen_at: new Date(now - 5 * DAY_MS).toISOString(),
      });
      await insertPricePoint(
        pool,
        listingId,
        new Date(now - 5 * DAY_MS).toISOString(),
        300000,
      );

      const signals = await computeListingSignals(listingId);
      expect(signals).not.toBeNull();
      // A single price point is "no drop data yet" (null), NOT a fabricated 0.
      expect(signals!.price_drop_pct_since_listing).toBeNull();
      expect(signals!.price_drop_events).toHaveLength(0);
    });
  });

  // ---- EC-2 --------------------------------------------------------------
  it("days on market freezes at status transition", async () => {
    await withRealDb(async (pool) => {
      // Listed 50 days ago, SOLD 10 days ago (i.e. 40 days after listing).
      // days_on_market must freeze at 40, not keep climbing to 50. A single
      // `now` base for both timestamps keeps the difference exactly 40 days.
      const now = Date.now();
      const propertyId = await insertProperty(pool);
      const listingId = await insertListing(pool, propertyId, {
        status: "sold",
        first_seen_at: new Date(now - 50 * DAY_MS).toISOString(),
      });
      await insertStatusEvent(
        pool,
        listingId,
        new Date(now - 10 * DAY_MS).toISOString(),
        "sold",
      );

      const signals = await computeListingSignals(listingId);
      expect(signals).not.toBeNull();
      expect(signals!.days_on_market).toBe(40);
    });
  });

  it("days on market keeps counting while the listing is still active", async () => {
    await withRealDb(async (pool) => {
      const now = Date.now();
      const propertyId = await insertProperty(pool);
      // 12 days + a half-day cushion: this is the one endpoint measured
      // against the DB's own NOW() (an active listing has no freeze point),
      // so the half-day keeps floor()==12 stable against any sub-12h skew
      // between the Docker Postgres clock and the host — unlike the
      // freeze-at-status tests, whose endpoints are both fixed stored
      // timestamps and need no cushion.
      const listingId = await insertListing(pool, propertyId, {
        status: "active",
        first_seen_at: new Date(now - (12 * DAY_MS + DAY_MS / 2)).toISOString(),
      });

      const signals = await computeListingSignals(listingId);
      expect(signals).not.toBeNull();
      // No terminal transition -> counts to NOW(): 12 days and still going.
      expect(signals!.days_on_market).toBe(12);
    });
  });

  // ---- EC-4 --------------------------------------------------------------
  it("detects withdrawn-and-relisted-lower across linked listings", async () => {
    await withRealDb(async (pool) => {
      const now = Date.now();
      const propertyId = await insertProperty(pool);

      // Listing A (fotocasa): listed 70d ago, WITHDRAWN 40d ago at 300000.
      const listingA = await insertListing(pool, propertyId, {
        source: "fotocasa",
        status: "withdrawn",
        current_price: 300000,
        first_seen_at: new Date(now - 70 * DAY_MS).toISOString(),
      });
      await insertStatusEvent(
        pool,
        listingA,
        new Date(now - 40 * DAY_MS).toISOString(),
        "withdrawn",
      );

      // Listing B (milanuncios — DIFFERENT source): a fresh listing for the
      // SAME deduped property, born active 10d ago (30 days after A's
      // withdrawal, inside the 90-day window) at 270000 — 10% below 300000.
      await insertListing(pool, propertyId, {
        source: "milanuncios",
        status: "active",
        current_price: 270000,
        first_seen_at: new Date(now - 10 * DAY_MS).toISOString(),
      });

      const event = await computeRelistedLower(propertyId);
      expect(event).not.toBeNull();
      expect(event!.withdrawn_price).toBe(300000);
      expect(event!.relisted_price).toBe(270000);
      expect(event!.drop_pct).toBeCloseTo(0.1, 6);
    });
  });

  it("does not flag relisted_lower when the relist price is not below the threshold", async () => {
    await withRealDb(async (pool) => {
      const now = Date.now();
      const propertyId = await insertProperty(pool);

      const listingA = await insertListing(pool, propertyId, {
        source: "fotocasa",
        status: "withdrawn",
        current_price: 300000,
        first_seen_at: new Date(now - 70 * DAY_MS).toISOString(),
      });
      await insertStatusEvent(
        pool,
        listingA,
        new Date(now - 40 * DAY_MS).toISOString(),
        "withdrawn",
      );

      // Relisted only ~1.7% lower — below the default 5% threshold.
      await insertListing(pool, propertyId, {
        source: "milanuncios",
        status: "active",
        current_price: 295000,
        first_seen_at: new Date(now - 10 * DAY_MS).toISOString(),
      });

      expect(await computeRelistedLower(propertyId)).toBeNull();
    });
  });

  // ---- EC-5 --------------------------------------------------------------
  it("relisted-lower respects the configured time window", async () => {
    await withRealDb(async (pool) => {
      const now = Date.now();
      const propertyId = await insertProperty(pool);

      // Withdrawn 210d ago; relisted 10d ago — 200 days apart, well outside
      // the default 90-day window.
      const listingA = await insertListing(pool, propertyId, {
        source: "fotocasa",
        status: "withdrawn",
        current_price: 300000,
        first_seen_at: new Date(now - 240 * DAY_MS).toISOString(),
      });
      await insertStatusEvent(
        pool,
        listingA,
        new Date(now - 210 * DAY_MS).toISOString(),
        "withdrawn",
      );

      await insertListing(pool, propertyId, {
        source: "milanuncios",
        status: "active",
        current_price: 270000,
        first_seen_at: new Date(now - 10 * DAY_MS).toISOString(),
      });

      // Default 90-day window: 200-days-later relist does NOT trigger.
      expect(await computeRelistedLower(propertyId)).toBeNull();

      // Widening the window to cover the gap makes the SAME data qualify —
      // proving the window is genuinely configurable, not a fixed constant.
      const widened = await computeRelistedLower(propertyId, {
        windowDays: 250,
      });
      expect(widened).not.toBeNull();
      expect(widened!.drop_pct).toBeCloseTo(0.1, 6);
    });
  });

  // ---- Scoring wire-in (features.ts feeds off this) ----------------------
  it("batches per-property scoring signals (days_on_market + price_drop_pct)", async () => {
    await withRealDb(async (pool) => {
      const now = Date.now();
      const propertyId = await insertProperty(pool);
      // 30 days + half-day cushion: active listing, so days_on_market is
      // measured against the DB's NOW() — the cushion keeps floor()==30
      // stable against sub-12h Docker clock skew (see the "keeps counting"
      // test's comment).
      const firstSeenAt = new Date(
        now - (30 * DAY_MS + DAY_MS / 2),
      ).toISOString();
      const listingId = await insertListing(pool, propertyId, {
        status: "active",
        current_price: 285000,
        first_seen_at: firstSeenAt,
      });
      await insertPricePoint(pool, listingId, firstSeenAt, 300000);
      await insertPricePoint(
        pool,
        listingId,
        new Date(now - 5 * DAY_MS).toISOString(),
        285000,
      );

      const map = await computePropertyScoringSignals([propertyId]);
      const s = map.get(propertyId);
      expect(s).toBeDefined();
      expect(s!.days_on_market).toBe(30);
      expect(s!.price_drop_pct).toBeCloseTo(0.05, 6);
    });
  });
});
