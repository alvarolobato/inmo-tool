/**
 * Shared "which price do we show" logic for a deduplicated property (#585
 * review N8) — pure, dependency-free, client-safe.
 *
 * Extracted out of `PropertyHeader.tsx` (which computed this inline before
 * #584/#589 landed): the price used is the min `current_price` across ACTIVE
 * listings — same convention as the candidate list/map (task 2.4/2.5) — with
 * a fallback to the min price across ALL listings (flagged `isHistorical`)
 * when no listing is active, so a fully sold/withdrawn property still shows
 * its last-known price rather than "no price available."
 *
 * `TriageBar.tsx` needed the exact same figure for its compact summary and
 * originally duplicated a partial version of this that dropped the
 * `isHistorical` fallback flag entirely — a withdrawn property's last-known
 * price would have rendered in the bar with no historical marker, i.e. as
 * if it were a live, current asking price. Sharing this one function is what
 * keeps that guarantee real instead of "true until the two copies drift."
 */

import type { PropertyListingDetail } from "@/lib/property-detail";

export interface PropertyPriceSummary {
  /** Min price across active listings, or across all listings when none are active; null when the property has no priced listing at all. */
  minPrice: number | null;
  /** Max price across the same set `minPrice` was drawn from — used to detect cross-source disagreement. */
  maxPrice: number | null;
  /**
   * True when `minPrice`/`maxPrice` were drawn from ALL listings because no
   * listing is currently active — the property has a real, known price, but
   * it is a last-known/historical one, not a live current asking price.
   */
  isHistorical: boolean;
}

export function summarizePropertyPrice(listings: PropertyListingDetail[]): PropertyPriceSummary {
  const activePrices = listings
    .filter((l) => l.status === "active" && l.current_price !== null)
    .map((l) => l.current_price as number);
  const allPrices = listings
    .filter((l) => l.current_price !== null)
    .map((l) => l.current_price as number);

  const isHistorical = activePrices.length === 0 && allPrices.length > 0;
  const pricesUsed = activePrices.length > 0 ? activePrices : allPrices;
  const minPrice = pricesUsed.length > 0 ? Math.min(...pricesUsed) : null;
  const maxPrice = pricesUsed.length > 0 ? Math.max(...pricesUsed) : null;

  return { minPrice, maxPrice, isHistorical };
}
