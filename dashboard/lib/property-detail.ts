/**
 * Reads the full detail view for one deduplicated property (task 2.8, #44):
 * all property fields, the union of photos across every linked *active*
 * `listing` (task 2.2's dedup engine may have merged 2+ site listings into
 * one property — a different site can have better/different photos of the
 * same place), every linked listing with its own status regardless of
 * whether it's active, and a combined price/status timeline across all of
 * them.
 *
 * The photo union is active-listings-only (#167 review must-fix 1) — a
 * withdrawn/sold/expired listing's photos are typically stale (the listing
 * may be long off-market) and must not lead the gallery a user is actively
 * evaluating. This mirrors lib/candidates.ts's card-photo query exactly
 * (same status filter, same `source` order) so the card's lead image and
 * this gallery's hero are always the same photo — see `getPropertyDetail`'s
 * implementation comment below for the shared ordering rule.
 *
 * Server-only: imports lib/db-write (the `pg` client) — same reasoning as
 * lib/candidates.ts, never import this from a client component.
 */

import { sql } from "@/lib/db-write";
import {
  parseExtractionQuality,
  type ExtractionQuality,
} from "@/lib/extraction-quality";
import { REDFLAG_LABELS } from "@/lib/ai-assessment/redflags";

export interface PropertyListingDetail {
  id: number;
  source: string;
  url: string | null;
  listing_kind: string | null;
  status: string;
  current_price: number | null;
  /**
   * `'sale' | 'rent'` (issue #31 Opus-review "Also fix": this query had no
   * `operation`/`status` filter and no `operation` column at all, so a
   * monthly rent figure would render indistinguishable from a sale price
   * — see LinkedListings.tsx, which now suffixes "/mes" and badges this
   * explicitly. Not filtered out: today's dedup design (D-016) means a
   * property can only ever host one operation's listings, so filtering
   * would hide a rental-only property's entire listing list; the fix is
   * to label, not drop.
   */
  operation: string;
  /**
   * Seller/agency reference (issue #72), e.g. "LCSE43927". Per-listing, not
   * per-property: each portal carries the code its own seller assigned, and
   * a shared code across sources is what the dedup signal keys on.
   */
  reference_code: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  /**
   * The advert body text as scraped from the source portal (issue #360).
   * Populated for most sources; null/empty for listings that predate the
   * field or came from a source that carries no free-text body. Rendered by
   * components/property/PropertyDescription.tsx on the detail page.
   */
  description: string | null;
  /**
   * Per-listing extraction-quality grade the ETL stamped on
   * `raw_extra.extraction_quality` (issue #80). Null for listings that
   * predate the feature — they self-heal on their next fetch. See
   * lib/extraction-quality.ts.
   */
  extraction_quality: ExtractionQuality | null;
}

export interface PriceHistoryPoint {
  listing_id: number;
  source: string;
  observed_at: string;
  price: number;
  /** `'sale' | 'rent'` — see PropertyListingDetail.operation's comment. */
  operation: string;
}

export interface StatusEventPoint {
  listing_id: number;
  source: string;
  observed_at: string;
  status: string;
}

/**
 * One property-problem flag for the detail page (#361), derived from the
 * latest `redflags` ai_assessment row. `label` is the short Spanish badge
 * text (from `REDFLAG_LABELS`); `description` is the model's own one-line
 * explanation and `evidence` the literal advert quote it cited — the detail
 * page has room to show both, unlike the card's compact badge. `other` and
 * any type without a label are filtered out server-side (see
 * `getPropertyDetail`).
 */
export interface ProblemFlag {
  type: string;
  label: string;
  description: string;
  evidence: string;
  evidence_source: string | null;
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
  /** Union of photo_urls across every linked *active* listing, de-duplicated, grouped by listing in `source` order (see `getPropertyDetail`'s doc comment — #167 review). */
  photo_urls: string[];
  listings: PropertyListingDetail[];
  price_history: PriceHistoryPoint[];
  status_events: StatusEventPoint[];
  /**
   * Property problems from the latest `redflags` assessment (#361) — legal,
   * financial or physical (unfinished/halted construction, structural
   * damage). Empty when the property has no assessment yet or the latest one
   * flagged nothing — the detail page renders the block only when non-empty,
   * the same "absent, not a placeholder" rule the card's flags follow.
   */
  problem_flags: ProblemFlag[];
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
  operation: string;
  description: string | null;
  /** `raw_extra->'extraction_quality'` — untyped JSON, narrowed on read. */
  extraction_quality: unknown;
}

interface RawPriceHistoryRow {
  listing_id: number;
  source: string;
  observed_at: string;
  price: string;
  operation: string;
}

interface RawStatusEventRow {
  listing_id: number;
  source: string;
  observed_at: string;
  status: string;
}

interface RawRedflagsRow {
  /** The redflags assessment `result` JSON — `{ flags: [...], … }`. */
  result: Record<string, unknown> | null;
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
  const [propertyRows, listingRows, priceRows, statusRows, redflagsRows] = await Promise.all([
    sql<RawPropertyRow>(
      `SELECT id, address, lat, lon, property_type, m2_built, m2_useful, rooms,
              bathrooms, floor, has_elevator, year_built, energy_rating
         FROM property
        WHERE id = $1`,
      [propertyId],
    ),
    sql<RawListingRow>(
      // ORDER BY source, id: `id` is a tiebreaker for the (rare, schema-
      // permitted — only (source, external_id) is UNIQUE, not (property_id,
      // source)) case of two listings from the same source on one property,
      // so the photo union built below has a fully deterministic order
      // rather than depending on whatever order Postgres happens to return
      // same-source rows in.
      `SELECT id, source, url, listing_kind, status, current_price,
              reference_code, first_seen_at, last_seen_at, photo_urls, operation,
              description,
              raw_extra->'extraction_quality' AS extraction_quality
         FROM listing
        WHERE property_id = $1
        ORDER BY source, id`,
      [propertyId],
    ),
    sql<RawPriceHistoryRow>(
      `SELECT h.listing_id, l.source, h.observed_at, h.price, l.operation
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
    // Latest redflags assessment (#361). Newest row wins regardless of
    // prompt_version — a version bump leaves the old row in place (see the
    // ai_assessment_property_key note in loadFlags), so ORDER BY generated_at
    // DESC picks the current verdict, same rule the candidate feed uses.
    sql<RawRedflagsRow>(
      `SELECT result
         FROM ai_assessment
        WHERE property_id = $1 AND assessment_type = 'redflags'
        ORDER BY generated_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [propertyId],
    ),
  ]);

  const propertyRow = propertyRows[0];
  if (!propertyRow) return null;

  // Active listings only, in `source` order (the SQL's ORDER BY source, id),
  // matching lib/candidates.ts's card-photo query exactly (#167 review
  // must-fix 1: prior to this fix, the card filtered to active listings and
  // ordered by listing id, while this gallery had no status filter at all
  // and ordered by source — different lead image, different order,
  // different set, including a withdrawn listing's photos able to lead this
  // gallery). `listings` below still includes every listing regardless of
  // status — the status/price timeline further down the page is exactly
  // where a withdrawn listing's history belongs; only the photo union
  // excludes it.
  const photoUrls: string[] = [];
  const seenPhotos = new Set<string>();
  for (const l of listingRows) {
    if (l.status !== "active") continue;
    for (const url of l.photo_urls ?? []) {
      // A NULL array element (same root cause lib/candidates.ts's SQL
      // guards against with array_remove) would otherwise survive into a
      // string[]-typed array as a literal `null` and break the gallery's
      // `<img>` mid-cycle.
      if (url == null) continue;
      if (!seenPhotos.has(url)) {
        seenPhotos.add(url);
        photoUrls.push(url);
      }
    }
  }

  // Problem flags (#361) from the latest redflags row. Same discipline as
  // lib/candidates.ts's flagsFromAssessments: only closed-vocabulary types
  // with a label render (drops `other` and any drift), and a flag must carry
  // both a description and a literal evidence citation — an unevidenced flag
  // is dropped here too, mirroring parseRedFlagsResult's code-side backstop.
  const redflagsResult = redflagsRows[0]?.result;
  const rawFlags =
    redflagsResult && Array.isArray(redflagsResult.flags) ? redflagsResult.flags : [];
  const problemFlags: ProblemFlag[] = [];
  for (const rf of rawFlags) {
    if (typeof rf !== "object" || rf === null) continue;
    const o = rf as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : null;
    if (type === null) continue;
    const label = REDFLAG_LABELS[type];
    if (label === undefined) continue;
    const evidence = typeof o.evidence === "string" ? o.evidence.trim() : "";
    if (evidence === "") continue;
    problemFlags.push({
      type,
      label,
      description: typeof o.description === "string" ? o.description : "",
      evidence,
      evidence_source:
        typeof o.evidence_source === "string" && o.evidence_source.trim() !== ""
          ? o.evidence_source
          : null,
    });
  }

  return {
    // Bigint columns (id, listing_id) arrive as real JS numbers via the
    // driver-level int8 type parser (db-shared.ts, #155). lat/lon/m2_built/
    // m2_useful/current_price/price below are NUMERIC — a different OID
    // with a genuine precision rationale — those coercions stay.
    id: propertyRow.id,
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
      id: l.id,
      source: l.source,
      url: l.url,
      listing_kind: l.listing_kind,
      status: l.status,
      current_price: l.current_price !== null ? Number(l.current_price) : null,
      reference_code: l.reference_code,
      first_seen_at: l.first_seen_at,
      last_seen_at: l.last_seen_at,
      operation: l.operation,
      description: l.description,
      extraction_quality: parseExtractionQuality(l.extraction_quality),
    })),
    price_history: priceRows.map((h) => ({
      listing_id: h.listing_id,
      source: h.source,
      observed_at: h.observed_at,
      price: Number(h.price),
      operation: h.operation,
    })),
    status_events: statusRows.map((e) => ({
      listing_id: e.listing_id,
      source: e.source,
      observed_at: e.observed_at,
      status: e.status,
    })),
    problem_flags: problemFlags,
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
