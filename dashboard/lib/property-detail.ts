/**
 * Reads the full detail view for one deduplicated property (task 2.8, #44):
 * all property fields, the union of photos across every linked `listing`
 * (task 2.2's dedup engine may have merged 2+ site listings into one
 * property — a different site can have better/different photos of the same
 * place), every linked listing with its own status, and a combined
 * price/status timeline across all of them.
 *
 * Server-only: imports lib/db-write (the `pg` client) — same reasoning as
 * lib/candidates.ts, never import this from a client component.
 */

import { sql } from "@/lib/db-write";

export interface PropertyListingDetail {
  id: number;
  source: string;
  url: string | null;
  listing_kind: string | null;
  status: string;
  current_price: number | null;
  /**
   * Seller/agency reference (issue #72), e.g. "LCSE43927". Per-listing, not
   * per-property: each portal carries the code its own seller assigned, and
   * a shared code across sources is what the dedup signal keys on.
   */
  reference_code: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface PriceHistoryPoint {
  listing_id: number;
  source: string;
  observed_at: string;
  price: number;
}

export interface StatusEventPoint {
  listing_id: number;
  source: string;
  observed_at: string;
  status: string;
}

export interface PropertyDetail {
  id: number;
  address: string | null;
  lat: number | null;
  lon: number | null;
  property_type: string | null;
  m2_built: number | null;
  m2_useful: number | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: string | null;
  has_elevator: boolean | null;
  year_built: number | null;
  energy_rating: string | null;
  /** Union of photo_urls across every linked listing, de-duplicated, order preserved from listing order. */
  photo_urls: string[];
  listings: PropertyListingDetail[];
  price_history: PriceHistoryPoint[];
  status_events: StatusEventPoint[];
}

interface RawPropertyRow {
  id: number;
  address: string | null;
  lat: string | null;
  lon: string | null;
  property_type: string | null;
  m2_built: string | null;
  m2_useful: string | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: string | null;
  has_elevator: boolean | null;
  year_built: number | null;
  energy_rating: string | null;
}

interface RawListingRow {
  id: number;
  source: string;
  url: string | null;
  listing_kind: string | null;
  status: string;
  current_price: string | null;
  reference_code: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  photo_urls: string[] | null;
}

interface RawPriceHistoryRow {
  listing_id: number;
  source: string;
  observed_at: string;
  price: string;
}

interface RawStatusEventRow {
  listing_id: number;
  source: string;
  observed_at: string;
  status: string;
}

/**
 * Returns null if the property doesn't exist. Does NOT check that the
 * property belongs to any particular profile's matched set — the API route
 * is responsible for that (a property is a durable identity, independent of
 * which profile you arrived from; see DetailSections.tsx's slot-ordering
 * comment for how later phases reference a property outside profile
 * context too, e.g. Phase 6's deal pipeline).
 */
export async function getPropertyDetail(propertyId: number): Promise<PropertyDetail | null> {
  const [propertyRows, listingRows, priceRows, statusRows] = await Promise.all([
    sql<RawPropertyRow>(
      `SELECT id, address, lat, lon, property_type, m2_built, m2_useful, rooms,
              bathrooms, floor, has_elevator, year_built, energy_rating
         FROM property
        WHERE id = $1`,
      [propertyId],
    ),
    sql<RawListingRow>(
      `SELECT id, source, url, listing_kind, status, current_price,
              reference_code, first_seen_at, last_seen_at, photo_urls
         FROM listing
        WHERE property_id = $1
        ORDER BY source`,
      [propertyId],
    ),
    sql<RawPriceHistoryRow>(
      `SELECT h.listing_id, l.source, h.observed_at, h.price
         FROM listing_price_history h
         JOIN listing l ON l.id = h.listing_id
        WHERE l.property_id = $1
        ORDER BY h.observed_at`,
      [propertyId],
    ),
    sql<RawStatusEventRow>(
      `SELECT e.listing_id, l.source, e.observed_at, e.status
         FROM listing_status_event e
         JOIN listing l ON l.id = e.listing_id
        WHERE l.property_id = $1
        ORDER BY e.observed_at`,
      [propertyId],
    ),
  ]);

  const propertyRow = propertyRows[0];
  if (!propertyRow) return null;

  const photoUrls: string[] = [];
  const seenPhotos = new Set<string>();
  for (const l of listingRows) {
    for (const url of l.photo_urls ?? []) {
      if (!seenPhotos.has(url)) {
        seenPhotos.add(url);
        photoUrls.push(url);
      }
    }
  }

  return {
    id: Number(propertyRow.id),
    address: propertyRow.address,
    lat: propertyRow.lat !== null ? Number(propertyRow.lat) : null,
    lon: propertyRow.lon !== null ? Number(propertyRow.lon) : null,
    property_type: propertyRow.property_type,
    m2_built: propertyRow.m2_built !== null ? Number(propertyRow.m2_built) : null,
    m2_useful: propertyRow.m2_useful !== null ? Number(propertyRow.m2_useful) : null,
    rooms: propertyRow.rooms,
    bathrooms: propertyRow.bathrooms,
    floor: propertyRow.floor,
    has_elevator: propertyRow.has_elevator,
    year_built: propertyRow.year_built,
    energy_rating: propertyRow.energy_rating,
    photo_urls: photoUrls,
    listings: listingRows.map((l) => ({
      id: Number(l.id),
      source: l.source,
      url: l.url,
      listing_kind: l.listing_kind,
      status: l.status,
      current_price: l.current_price !== null ? Number(l.current_price) : null,
      reference_code: l.reference_code,
      first_seen_at: l.first_seen_at,
      last_seen_at: l.last_seen_at,
    })),
    price_history: priceRows.map((h) => ({
      listing_id: Number(h.listing_id),
      source: h.source,
      observed_at: h.observed_at,
      price: Number(h.price),
    })),
    status_events: statusRows.map((e) => ({
      listing_id: Number(e.listing_id),
      source: e.source,
      observed_at: e.observed_at,
      status: e.status,
    })),
  };
}

/** True if `propertyId` is a currently-matched candidate for `profileId` (task 2.4's `profile_listing_state.matched`). */
export async function isPropertyMatchedForProfile(
  profileId: number,
  propertyId: number,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM profile_listing_state
        WHERE profile_id = $1 AND property_id = $2 AND matched = true
     ) AS exists`,
    [profileId, propertyId],
  );
  return rows[0]?.exists ?? false;
}
