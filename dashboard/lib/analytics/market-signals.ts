/**
 * Days-on-market & price-drop trend signals (task 5.4, issue #34).
 *
 * Pure computation over data three earlier tasks already track — nothing
 * here ingests anything:
 *   - `listing.first_seen_at`         (task 1.2)  — when we first saw the ad
 *   - `listing_price_history`         (task 1.4)  — append-only price points
 *   - `listing_status_event`          (task 1.4)  — append-only status points
 *   - `listing.property_id -> property`(task 2.2) — the deduped identity that
 *     lets a withdrawal on one site's listing be tied to a fresh listing on a
 *     DIFFERENT site for the same physical property (the `relisted_lower`
 *     cross-listing pattern below).
 *
 * Two levels of signal, deliberately kept apart:
 *
 * 1. **Per-listing** ({@link computeListingSignals}) — `days_on_market`,
 *    `price_drop_pct_since_listing`, and the individual `price_drop_events`.
 *    These describe one advert's own life.
 *
 * 2. **Per-property** ({@link computeRelistedLower}) — the
 *    "withdrawn-and-relisted-lower" pattern, which by construction spans two
 *    DIFFERENT listings (commonly on two different sites) for the same
 *    deduped property. It cannot live at the per-listing level and is a
 *    stronger motivated-seller signal than an ordinary in-listing price cut,
 *    so it is surfaced as its own named thing, never folded into
 *    `price_drop_events`.
 *
 * A third helper ({@link computePropertyScoringSignals}) batches the
 * per-property `days_on_market` / `price_drop_pct` the scoring feature vector
 * (lib/scoring/features.ts) needs for a whole candidate pool in one query —
 * so scoring never N+1s per candidate. See that module for how these two
 * always-null-until-now feature slots (task 3.2 left them as "degrade to
 * null") get populated.
 *
 * **Freeze-at-status (issue #34 EC-2).** `days_on_market` must STOP counting
 * once a listing leaves `active` — a listing sold 10 days ago after 40 days
 * live is "40 days on market", not 50 and climbing. We freeze at the moment
 * it left the market: for a currently-non-active listing, the earliest
 * `listing_status_event` transition into a terminal status
 * ({@link TERMINAL_STATUSES}); for a still-`active` listing, `NOW()`. A
 * `reserved` listing is NOT frozen — reserved is a reversible, pending state
 * (it can flip back to `active`), unlike sold/withdrawn/expired.
 *
 * Server-only: imports lib/db-write (the `pg` client) — same reasoning as
 * area-price.ts / rent-estimate.ts, never import this from a client
 * component.
 */

import { sql } from "@/lib/db-write";

/**
 * Statuses that take a listing off the market for good (as far as this signal
 * is concerned) and therefore FREEZE `days_on_market`. `reserved` is
 * deliberately excluded — it is a reversible, pending state, not a departure
 * from the market. Matches the `listing.status` CHECK constraint's terminal
 * members (etl/schema/init.sql).
 */
export const TERMINAL_STATUSES = ["sold", "withdrawn", "expired"] as const;

/**
 * Statuses that mark a withdrawal for the cross-listing relist pattern.
 * `sold` is intentionally NOT here: a genuinely-sold property being relisted
 * lower is a data anomaly, not a motivated-seller signal, whereas a
 * `withdrawn`/`expired` listing reappearing cheaper elsewhere is exactly the
 * issue #1 §10 pattern this computes.
 */
export const WITHDRAWAL_STATUSES = ["withdrawn", "expired"] as const;

/** Default look-ahead window (days) for a relist to count as related to a withdrawal (issue #34 EC-5, configurable). */
export const DEFAULT_RELIST_WINDOW_DAYS = 90;

/** Default minimum price drop (fraction) for a relist to qualify as "lower" (issue #34 EC-4, configurable). */
export const DEFAULT_RELIST_DROP_THRESHOLD = 0.05;

/** One individual price decrease within a single listing's history. `date` is the observation time of the NEW (lower) price. */
export interface PriceDropEvent {
  date: string;
  old_price: number;
  new_price: number;
}

export interface ListingMarketSignals {
  /** Days since `first_seen_at`, FROZEN at the terminal-status transition once the listing left `active` (see module docstring / EC-2). */
  days_on_market: number;
  /**
   * `(first_recorded_price - last_recorded_price) / first_recorded_price`
   * over `listing_price_history` (earliest -> latest). `null` when there has
   * only ever been one recorded price (no drop data yet) — NOT 0 (EC-1).
   * Positive = price fell, negative = price rose.
   */
  price_drop_pct_since_listing: number | null;
  /** Every individual decrease between consecutive recorded prices (EC-1) — empty when there were none. */
  price_drop_events: PriceDropEvent[];
}

/** The cross-listing "withdrawn then relisted lower" motivated-seller signal (issue #34 item 3a / EC-4/EC-5). */
export interface RelistedLowerEvent {
  withdrawn_at: string;
  withdrawn_price: number;
  relisted_at: string;
  relisted_price: number;
  /** `(withdrawn_price - relisted_price) / withdrawn_price` — always >= the configured threshold. */
  drop_pct: number;
}

interface RawListingRow {
  first_seen_at: string | null;
  status: string;
  /** Earliest transition into a terminal status, or null if the listing never left active. */
  frozen_at: string | null;
}

interface RawPricePointRow {
  observed_at: string;
  price: string;
}

/**
 * Per-listing signals for one listing. Returns `null` only when the listing
 * doesn't exist or has no `first_seen_at` at all (nothing to measure a
 * duration from) — every other case produces a real result, with
 * `price_drop_pct_since_listing: null` / `price_drop_events: []` standing in
 * for "no drop data" rather than a fabricated zero.
 */
export async function computeListingSignals(
  listingId: number,
): Promise<ListingMarketSignals | null> {
  const [listingRows, priceRows] = await Promise.all([
    sql<RawListingRow>(
      `SELECT
         l.first_seen_at,
         l.status,
         -- Earliest transition into a terminal status (module docstring /
         -- EC-2). MIN, not MAX: the first time it left the market is when it
         -- stopped accruing days-on-market; a later re-withdrawal after a
         -- reactivation is handled by the current-status gate below, not here.
         (SELECT MIN(e.observed_at)
            FROM listing_status_event e
           WHERE e.listing_id = l.id
             AND e.status = ANY($2::text[])) AS frozen_at
       FROM listing l
      WHERE l.id = $1`,
      [listingId, TERMINAL_STATUSES as unknown as string[]],
    ),
    sql<RawPricePointRow>(
      `SELECT observed_at, price
         FROM listing_price_history
        WHERE listing_id = $1
        ORDER BY observed_at ASC, id ASC`,
      [listingId],
    ),
  ]);

  const listing = listingRows[0];
  if (!listing || listing.first_seen_at === null) return null;

  const firstSeen = new Date(listing.first_seen_at).getTime();

  // Freeze the clock: a still-active listing keeps counting to NOW(); a
  // listing that has left `active` freezes at its earliest terminal
  // transition. `reserved` (not in TERMINAL_STATUSES, so frozen_at is null
  // for a reserved-but-never-terminal listing) keeps counting — it is a
  // reversible pending state, not a market exit.
  const isActive = listing.status === "active";
  const freezeEndMs =
    !isActive && listing.frozen_at !== null
      ? new Date(listing.frozen_at).getTime()
      : Date.now();

  const days_on_market = Math.max(
    0,
    Math.floor((freezeEndMs - firstSeen) / 86_400_000),
  );

  // Price history -> individual drop events + net drop pct. Every consecutive
  // pair whose new price is strictly below the old one is a drop event (EC-1
  // wants the individual events, not just the aggregate). The aggregate is
  // first -> last, null when there's a single (or zero) recorded price.
  const prices = priceRows.map((r) => ({
    observed_at: r.observed_at,
    price: Number(r.price),
  }));
  const price_drop_events: PriceDropEvent[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const cur = prices[i];
    if (cur.price < prev.price) {
      price_drop_events.push({
        date: cur.observed_at,
        old_price: prev.price,
        new_price: cur.price,
      });
    }
  }

  let price_drop_pct_since_listing: number | null = null;
  if (prices.length > 1) {
    const first = prices[0].price;
    const last = prices[prices.length - 1].price;
    // Guard first > 0: a "precio a consultar" 0 initial price (see
    // milanuncios.py's _to_decimal, and rent-estimate.ts's identical guard)
    // would divide-by-zero into a ±Infinity/NaN pct. Treated as "no usable
    // drop data" rather than a fabricated number.
    price_drop_pct_since_listing = first > 0 ? (first - last) / first : null;
  }

  return { days_on_market, price_drop_pct_since_listing, price_drop_events };
}

interface RawWithdrawalRow {
  listing_id: number;
  withdrawn_at: string;
  withdrawn_price: string | null;
}

interface RawRelistRow {
  listing_id: number;
  active_at: string;
  relisted_price: string | null;
}

/**
 * The cross-listing "withdrawn then relisted lower" pattern for one property
 * (issue #34 item 3a). Detects a `withdrawn`/`expired` transition on ANY of
 * the property's linked listings, followed within `windowDays` (default 90,
 * EC-5) by a listing for the SAME property becoming active — a genuine
 * re-activation of the same listing OR, more commonly, a fresh listing on a
 * different source — at a price at least `dropThreshold` (default 5%, EC-4)
 * below the withdrawn listing's last price.
 *
 * Returns the qualifying pair with the LARGEST `drop_pct` (the strongest
 * motivated-seller reading) when several exist, or `null` when none do.
 *
 * A relist's "activation moment" is the later of two things it can be: a
 * fresh listing is born active at its `first_seen_at`; an existing listing
 * can be re-activated via a `listing_status_event` back to `active`. Both are
 * considered; only activations strictly AFTER the withdrawal and within the
 * window count — so the withdrawn listing's own original `first_seen_at`
 * (which predates its withdrawal) can never match itself.
 */
export async function computeRelistedLower(
  propertyId: number,
  opts: { windowDays?: number; dropThreshold?: number } = {},
): Promise<RelistedLowerEvent | null> {
  const windowDays = opts.windowDays ?? DEFAULT_RELIST_WINDOW_DAYS;
  const dropThreshold = opts.dropThreshold ?? DEFAULT_RELIST_DROP_THRESHOLD;

  const [withdrawalRows, relistRows] = await Promise.all([
    // Every withdrawal/expiry transition on any of the property's listings,
    // with the listing's last known price AT that moment: the most recent
    // price_history point on/before the withdrawal, falling back to
    // current_price when this listing has no price history at all.
    sql<RawWithdrawalRow>(
      `SELECT
         e.listing_id,
         e.observed_at AS withdrawn_at,
         COALESCE(
           (SELECT h.price
              FROM listing_price_history h
             WHERE h.listing_id = e.listing_id
               AND h.observed_at <= e.observed_at
             ORDER BY h.observed_at DESC, h.id DESC
             LIMIT 1),
           l.current_price
         ) AS withdrawn_price
       FROM listing_status_event e
       JOIN listing l ON l.id = e.listing_id
      WHERE l.property_id = $1
        AND e.status = ANY($2::text[])`,
      [propertyId, WITHDRAWAL_STATUSES as unknown as string[]],
    ),
    // Every activation moment on any of the property's listings: the fresh
    // listing's own first_seen_at (born active), UNION every explicit
    // transition back to 'active'. relisted_price is the listing's earliest
    // recorded price at/after that activation, falling back to current_price.
    sql<RawRelistRow>(
      `WITH activations AS (
         SELECT l.id AS listing_id, l.first_seen_at AS active_at
           FROM listing l
          WHERE l.property_id = $1 AND l.first_seen_at IS NOT NULL
         UNION
         SELECT e.listing_id, e.observed_at AS active_at
           FROM listing_status_event e
           JOIN listing l ON l.id = e.listing_id
          WHERE l.property_id = $1 AND e.status = 'active'
       )
       SELECT
         a.listing_id,
         a.active_at,
         COALESCE(
           (SELECT h.price
              FROM listing_price_history h
             WHERE h.listing_id = a.listing_id
               AND h.observed_at >= a.active_at
             ORDER BY h.observed_at ASC, h.id ASC
             LIMIT 1),
           (SELECT l2.current_price FROM listing l2 WHERE l2.id = a.listing_id)
         ) AS relisted_price
       FROM activations a`,
      [propertyId],
    ),
  ]);

  const withdrawals = withdrawalRows
    .filter((w) => w.withdrawn_price !== null && Number(w.withdrawn_price) > 0)
    .map((w) => ({
      listing_id: w.listing_id,
      withdrawn_at: w.withdrawn_at,
      withdrawn_at_ms: new Date(w.withdrawn_at).getTime(),
      withdrawn_price: Number(w.withdrawn_price),
    }));

  const relists = relistRows
    .filter((r) => r.relisted_price !== null && Number(r.relisted_price) > 0)
    .map((r) => ({
      listing_id: r.listing_id,
      active_at: r.active_at,
      active_at_ms: new Date(r.active_at).getTime(),
      relisted_price: Number(r.relisted_price),
    }));

  const windowMs = windowDays * 86_400_000;
  let best: RelistedLowerEvent | null = null;

  for (const w of withdrawals) {
    for (const r of relists) {
      // Strictly after the withdrawal and within the window (EC-5). The
      // strict `>` also rules out a withdrawn listing's own original
      // first_seen_at (which predates its withdrawal) matching itself.
      if (r.active_at_ms <= w.withdrawn_at_ms) continue;
      if (r.active_at_ms > w.withdrawn_at_ms + windowMs) continue;

      const drop_pct =
        (w.withdrawn_price - r.relisted_price) / w.withdrawn_price;
      if (drop_pct < dropThreshold) continue;

      if (best === null || drop_pct > best.drop_pct) {
        best = {
          withdrawn_at: w.withdrawn_at,
          withdrawn_price: w.withdrawn_price,
          relisted_at: r.active_at,
          relisted_price: r.relisted_price,
          drop_pct,
        };
      }
    }
  }

  return best;
}

/** Per-property scoring signals — the two feature slots lib/scoring/features.ts populates. */
export interface PropertyScoringSignals {
  /** Frozen days-on-market for the property's representative listing (see {@link computePropertyScoringSignals}), or null when unknown. */
  days_on_market: number | null;
  /** Net price drop pct for that same representative listing, or null when there's no drop data. Positive = price fell. */
  price_drop_pct: number | null;
}

interface RawPropertySignalRow {
  property_id: number;
  days_on_market: string | null;
  price_drop_pct: string | null;
}

/**
 * Batches per-property `days_on_market` / `price_drop_pct` for a whole
 * candidate pool in ONE query — the scoring feature extractor
 * (lib/scoring/features.ts) fetches its whole pool at once and must not N+1
 * these per candidate (same discipline as `fetchScoringInputs`).
 *
 * A deduped property can host several listings; the "representative" listing
 * is the one most relevant to a buyer evaluating the property NOW: an active
 * listing if any (the property is still buyable), preferring the most
 * recently-listed one; otherwise the most recently-listed listing overall.
 * This matches how the rest of scoring already collapses a property to a
 * single figure (features.ts's MIN(current_price) across active listings).
 *
 * Properties not present in the returned map (no listing, or no
 * `first_seen_at`) are treated as "unknown" (null) by the caller — the same
 * missing-value-imputed-to-the-pool-mean path every other scoring feature
 * uses.
 */
export async function computePropertyScoringSignals(
  propertyIds: number[],
): Promise<Map<number, PropertyScoringSignals>> {
  const result = new Map<number, PropertyScoringSignals>();
  if (propertyIds.length === 0) return result;

  const rows = await sql<RawPropertySignalRow>(
    `WITH rep AS (
       SELECT DISTINCT ON (l.property_id)
         l.property_id,
         l.id AS listing_id,
         l.first_seen_at,
         l.status
       FROM listing l
      WHERE l.property_id = ANY($1::bigint[])
        AND l.first_seen_at IS NOT NULL
      -- One representative per property: active first (still buyable), then
      -- the most recently listed. Deterministic tiebreak on id.
      ORDER BY l.property_id, (l.status = 'active') DESC, l.first_seen_at DESC, l.id DESC
     )
     SELECT
       rep.property_id,
       FLOOR(
         EXTRACT(EPOCH FROM (
           CASE
             WHEN rep.status = 'active' THEN NOW()
             ELSE COALESCE(
               (SELECT MIN(e.observed_at)
                  FROM listing_status_event e
                 WHERE e.listing_id = rep.listing_id
                   AND e.status = ANY($2::text[])),
               NOW()
             )
           END - rep.first_seen_at
         )) / 86400.0
       )::text AS days_on_market,
       (
         SELECT CASE
                  WHEN agg.cnt > 1 AND agg.first_price > 0
                  THEN (agg.first_price - agg.last_price) / agg.first_price
                  ELSE NULL
                END
           FROM (
             SELECT COUNT(*) AS cnt,
                    (ARRAY_AGG(h.price ORDER BY h.observed_at ASC, h.id ASC))[1] AS first_price,
                    (ARRAY_AGG(h.price ORDER BY h.observed_at DESC, h.id DESC))[1] AS last_price
               FROM listing_price_history h
              WHERE h.listing_id = rep.listing_id
           ) agg
       )::text AS price_drop_pct
     FROM rep`,
    [propertyIds, TERMINAL_STATUSES as unknown as string[]],
  );

  for (const row of rows) {
    result.set(row.property_id, {
      days_on_market:
        row.days_on_market !== null ? Number(row.days_on_market) : null,
      price_drop_pct:
        row.price_drop_pct !== null ? Number(row.price_drop_pct) : null,
    });
  }

  return result;
}
