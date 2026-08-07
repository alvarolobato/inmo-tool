/**
 * "En seguimiento" watchlist queries (issue #428, Feed phase 5 — plan #415 §3.5).
 *
 * A tracked property is one whose CURRENT verdict for a profile is `accept`
 * (owner decision, #415: `accept` IS the follow/seguimiento action — there is
 * no `star`). The tracked set is therefore the latest-wins derivation over
 * `feedback_event` (accept/reject/star/clear) landing on `accept`, exactly the
 * `feedback_state = 'accept'` the feed computes (lib/candidates.ts), restricted
 * to a profile's matched pool.
 *
 * These queries back TWO independent consumers that must agree on "what is a
 * tracked price drop":
 *   - the digest's top-placed "En seguimiento" section (digest.ts);
 *   - the per-hour independent watchlist pass (scheduler.ts).
 *   - the in-app indicator count (API route → CandidateList badge).
 *
 * ## Drops only, sanity-banded (owner decisions)
 *
 * Direction = DROPS ONLY (rises are visible in the feed as a SUBIDA badge but
 * never alert). The mandatory sanity band from phase 2 is reused verbatim
 * (`feed.price_change_min_pct` / `feed.price_change_max_pct`, defaults 1%/60%):
 * a move below the floor is noise, a move above the ceiling is a suspect data
 * artifact (§2.0a: 1 of 10 demo changes is a −96% artifact, 1 is a −0,1%
 * non-event). The band is applied IN SQL on the drop fraction so both the list
 * items and the count agree by construction.
 *
 * Server-only: imports `lib/db-write` (the `pg` client). Never import from a
 * client component.
 */

import { sql } from "@/lib/db-write";
import { readIntInRange } from "./config-read";
import type { DigestPriceDrop, DigestStatusChange } from "./digest";

/** The feed price-change sanity band as FRACTIONS (0.01 / 0.60 for the 1%/60% defaults). */
export interface PriceChangeBand {
  minFrac: number;
  maxFrac: number;
}

/**
 * Reads the phase-2 price-change sanity band from config (env > config.yaml >
 * default), as FRACTIONS. Shares the SAME keys the feed uses
 * (`feed.price_change_min_pct` / `feed.price_change_max_pct`) so the feed's
 * BAJADA badge and the seguimiento alert can never disagree about which drops
 * are real.
 */
export function readPriceChangeBand(): PriceChangeBand {
  const minPct = readIntInRange("feed.price_change_min_pct", "FEED_PRICE_CHANGE_MIN_PCT", 1, 0, 100);
  const maxPct = readIntInRange("feed.price_change_max_pct", "FEED_PRICE_CHANGE_MAX_PCT", 60, 1, 100);
  return { minFrac: minPct / 100, maxFrac: maxPct / 100 };
}

// The tracked (accept) predicate as a reusable CTE. Bound param $1 = profileId.
// Latest-wins over accept/reject/star/clear (retired `star` kept in the IN list
// so a legacy star still WINS the ordering, then only a literal `accept` result
// qualifies as tracked — a later reject/clear correctly un-tracks). Restricted
// to the profile's matched pool, mirroring lib/candidates.ts.
const TRACKED_CTE = `tracked AS (
  SELECT pls.property_id
    FROM profile_listing_state pls
   WHERE pls.profile_id = $1
     AND pls.matched = true
     AND (
       SELECT fe.feedback_type
         FROM feedback_event fe
        WHERE fe.profile_id = $1 AND fe.property_id = pls.property_id
          AND fe.feedback_type IN ('accept', 'reject', 'star', 'clear')
        ORDER BY fe.created_at DESC, fe.id DESC
        LIMIT 1
     ) = 'accept'
)`;

interface RawSeguimientoDropRow {
  property_id: number;
  address: string | null;
  source: string;
  url: string | null;
  old_price: string;
  new_price: string;
  observed_at: string;
}

/**
 * Sanity-banded price DROPS on a profile's TRACKED (accept) properties since
 * `since`. Bounds the `LAG()` window to the tracked listings before it scans
 * (the digest.ts §3.3 anti-pattern fix), applies the drops-only + sanity-band
 * predicate in SQL, and returns the same {@link DigestPriceDrop} shape the
 * digest's generic drop section uses.
 */
export async function loadSeguimientoPriceDrops(
  profileId: number,
  since: string,
  band: PriceChangeBand,
  limit: number,
): Promise<DigestPriceDrop[]> {
  const rows = await sql<RawSeguimientoDropRow>(
    `WITH ${TRACKED_CTE},
     drops AS (
       SELECT h.listing_id,
              h.observed_at,
              h.price AS new_price,
              LAG(h.price) OVER (PARTITION BY h.listing_id ORDER BY h.observed_at, h.id) AS prev_price
         FROM listing_price_history h
        WHERE h.listing_id IN (
                SELECT l0.id FROM listing l0
                  JOIN tracked t ON t.property_id = l0.property_id
              )
     )
     SELECT p.id AS property_id, p.address, l.source, l.url,
            d.prev_price AS old_price, d.new_price, d.observed_at
       FROM drops d
       JOIN listing l ON l.id = d.listing_id
       JOIN property p ON p.id = l.property_id
       JOIN tracked t ON t.property_id = p.id
      WHERE d.prev_price IS NOT NULL
        AND d.prev_price <> 0
        AND d.new_price < d.prev_price
        AND d.observed_at >= $2::timestamptz
        -- Drops only, sanity-banded: the drop fraction must sit within
        -- [minFrac, maxFrac] inclusive (noise below, suspect artifact above).
        AND ((d.prev_price - d.new_price) / d.prev_price) >= $3::double precision
        AND ((d.prev_price - d.new_price) / d.prev_price) <= $4::double precision
      ORDER BY d.observed_at DESC
      LIMIT $5`,
    [profileId, since, band.minFrac, band.maxFrac, limit],
  );
  return rows.map((r) => {
    const oldPrice = Number(r.old_price);
    const newPrice = Number(r.new_price);
    return {
      propertyId: r.property_id,
      zone: r.address,
      source: r.source,
      url: r.url,
      oldPrice,
      newPrice,
      dropPct: oldPrice > 0 ? (oldPrice - newPrice) / oldPrice : 0,
      observedAt: r.observed_at,
    };
  });
}

interface RawSeguimientoStatusRow {
  property_id: number;
  address: string | null;
  source: string;
  url: string | null;
  status: "sold" | "withdrawn";
  observed_at: string;
}

/**
 * Sold/withdrawn status changes on a profile's TRACKED (accept) properties
 * since `since` — "if it gets withdrawn or sold, I hear about that too, because
 * it closes the loop" (plan §1.2). Same shape as the digest's generic status
 * section, restricted to the tracked set.
 */
export async function loadSeguimientoStatusChanges(
  profileId: number,
  since: string,
  limit: number,
): Promise<DigestStatusChange[]> {
  const rows = await sql<RawSeguimientoStatusRow>(
    `WITH ${TRACKED_CTE}
     SELECT p.id AS property_id, p.address, l.source, l.url, e.status, e.observed_at
       FROM listing_status_event e
       JOIN listing l ON l.id = e.listing_id
       JOIN property p ON p.id = l.property_id
       JOIN tracked t ON t.property_id = p.id
      WHERE e.status IN ('sold', 'withdrawn')
        AND e.observed_at >= $2::timestamptz
      ORDER BY e.observed_at DESC
      LIMIT $3`,
    [profileId, since, limit],
  );
  return rows.map((r) => ({
    propertyId: r.property_id,
    zone: r.address,
    source: r.source,
    url: r.url,
    status: r.status,
    observedAt: r.observed_at,
  }));
}

/**
 * Count of DISTINCT tracked (accept) properties with a sanity-banded price drop
 * since `since` — the in-app indicator's number ("seguidas con bajada
 * reciente"). Uses the exact same drop predicate as
 * {@link loadSeguimientoPriceDrops}, so the badge count and the digest section
 * agree by construction.
 */
export async function countSeguimientoRecentDrops(
  profileId: number,
  since: string,
  band: PriceChangeBand,
): Promise<number> {
  const rows = await sql<{ n: string }>(
    `WITH ${TRACKED_CTE},
     drops AS (
       SELECT h.listing_id,
              h.observed_at,
              h.price AS new_price,
              LAG(h.price) OVER (PARTITION BY h.listing_id ORDER BY h.observed_at, h.id) AS prev_price
         FROM listing_price_history h
        WHERE h.listing_id IN (
                SELECT l0.id FROM listing l0
                  JOIN tracked t ON t.property_id = l0.property_id
              )
     )
     SELECT COUNT(DISTINCT l.property_id) AS n
       FROM drops d
       JOIN listing l ON l.id = d.listing_id
       JOIN tracked t ON t.property_id = l.property_id
      WHERE d.prev_price IS NOT NULL
        AND d.prev_price <> 0
        AND d.new_price < d.prev_price
        AND d.observed_at >= $2::timestamptz
        AND ((d.prev_price - d.new_price) / d.prev_price) >= $3::double precision
        AND ((d.prev_price - d.new_price) / d.prev_price) <= $4::double precision`,
    [profileId, since, band.minFrac, band.maxFrac],
  );
  return rows.length > 0 ? Number(rows[0].n) : 0;
}
