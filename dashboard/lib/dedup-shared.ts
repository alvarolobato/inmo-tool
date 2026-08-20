/**
 * Dedup review-queue types + constants — client-safe.
 *
 * Split out of lib/dedup.ts on purpose: that module imports lib/db-write
 * (the `pg` Postgres client), which pulls in Node built-ins (`fs`, `net`,
 * `tls`, `dns`) that don't exist in a browser bundle. Client components
 * (SuggestionQueue, SuggestionCard) need the *types* and the *label
 * constants* (MATCH_BASES/MATCH_BASIS_LABELS are real runtime values, not
 * erasable via `import type`) but must never import the DB access
 * functions — importing from lib/dedup instead of this file breaks
 * `next build`/dev with "Module not found: Can't resolve 'fs'" etc. Same
 * split as lib/profiles-schema.ts vs. lib/db/profiles.ts. lib/dedup.ts
 * re-exports everything here for server-side callers.
 */

export const MATCH_BASES = [
  "cadastral",
  "address_coords",
  "phone",
  "reference_code",
  "photo_hash",
  "fuzzy",
] as const;

export type MatchBasis = (typeof MATCH_BASES)[number];

/** Spanish labels for the queue's filter chips and per-row badge. */
export const MATCH_BASIS_LABELS: Record<MatchBasis, string> = {
  cadastral: "Referencia catastral",
  address_coords: "Dirección + coordenadas",
  phone: "Teléfono",
  reference_code: "Referencia de anuncio",
  photo_hash: "Fotos",
  fuzzy: "Difuso",
};

export interface DedupListingSide {
  listing_id: number;
  property_id: number;
  source: string;
  url: string | null;
  current_price: number | null;
  address: string | null;
  city: string | null;
  m2_built: number | null;
  rooms: number | null;
  bathrooms: number | null;
  property_type: string | null;
  photo_urls: string[];
}

// `DedupSuggestion`/`DedupSuggestionCounts` (one row per LISTING pair) were
// retired in issue #605 Part 2 — the review queue now groups by PROPERTY
// pair (`DedupPropertyPairSuggestion`/`DedupPropertyPairCounts` below).
// `#600` measured 892 pending listing-pair rows collapsing to 669 distinct
// property-pair questions, with one property pair alone repeating the
// identical question 38 times; grouping is now the ONLY read path, not an
// added one, so the flat shape isn't kept around as a second option.

export type DedupActionStatus = "pending" | "done" | "failed";
/**
 * `reject_pair` (issue #605 Part 2 revision — PR #611 review B1) rejects
 * the whole PROPERTY pair behind one representative `suggestion_id`, not
 * just that one listing pair — the engine derives the property pair from
 * the suggestion's listings, marks every currently-pending suggested_merge
 * row between the two properties as rejected, and persists a permanent
 * `property_merge_veto` so no listing combination between those two
 * PROPERTY IDS — including ones not yet compared — can be suggested or
 * auto-merged either. See `etl.dedup.engine.reject_property_pair`'s
 * docstring for why the plain `reject` above isn't enough for a grouped
 * card: it only ever bound the exact listing pair it was filed against,
 * leaving every OTHER combination between two multi-listing properties
 * free to resurface — reproduced live, including a case where the very
 * next dedup run auto-merged the two properties a human had just
 * rejected. NOT covered: a brand-new listing ingested after the veto,
 * which starts life as its own new property row and isn't guaranteed to
 * merge onto the correct (vetoed) side — see issue #612.
 */
export type DedupActionKind = "confirm" | "reject" | "reject_pair";

export interface DedupActionRow {
  id: number;
  suggestion_id: number;
  action: DedupActionKind;
  status: DedupActionStatus;
  error_msg: string | null;
  result: Record<string, unknown>;
}

/**
 * One underlying `suggested_merge` row, as evidence inside a grouped
 * property-pair suggestion (issue #605 Part 2). `listing_lo`/`listing_hi`
 * are the row's two listings NORMALIZED to the group's canonical
 * (lower-id, higher-id) property order — NOT `listing_a`/`listing_b`,
 * whose order is whatever `suggested_merge.listing_id_a/b` happened to
 * record and can flip which physical property is "a" from row to row
 * within the same group. Both sides still carry the full
 * `DedupListingSide` shape (property fields included) because they're the
 * same underlying join lib/dedup.ts already does for the flat view.
 */
export interface DedupEvidenceItem {
  suggestion_id: number;
  match_basis: MatchBasis;
  confidence: number;
  detail: Record<string, unknown>;
  created_at: string;
  listing_lo: DedupListingSide;
  listing_hi: DedupListingSide;
}

/**
 * One review-queue QUESTION, grouped by property pair rather than listing
 * pair (issue #605 Part 2 — #600 measured 892 pending listing-pair rows
 * collapsing to 669 distinct property-pair questions, worst case 38 rows
 * asking "is A the same property as B?" identically). `evidence` holds
 * every still-pending `suggested_merge` row for this exact
 * (property_lo_id, property_hi_id) pair, strongest first — the primary
 * comparison panel renders `evidence[0]`, the rest render as collapsed
 * corroborating evidence (see SuggestionQueue's docstring for why: leading
 * with the strongest signal keeps the default view legible, but hiding the
 * other N-1 rows entirely would make a bulk reject uninformed).
 */
export interface DedupPropertyPairSuggestion {
  /** `${property_lo_id}-${property_hi_id}` — stable, used as the React key
   * and the group's identity for resolve bookkeeping. */
  pair_key: string;
  property_lo_id: number;
  property_hi_id: number;
  /** How many pending listing-pair rows collapsed into this one question.
   * Issue #615: this is an internal implementation detail — the count of
   * `suggested_merge` rows the engine happens to have queued for this
   * pair, NOT a count of adverts. It reads to a human as "N adverts of
   * the same property" (which is what it did on the live case that
   * motivated this fix — a 7-listing property vs. a 13-listing property
   * produced "38 pares", read as "38 adverts", which is what a human
   * correctly flagged as nonsense). Kept on the type only for the reject
   * blast-radius count and the `data-pair-count` debug/test attribute —
   * MUST NOT be rendered as its own "N pares" copy. See
   * `listing_count_lo`/`listing_count_hi` for what the UI actually shows,
   * and D-135 (which revises D-133's UI-copy paragraph). */
  pair_count: number;
  /** Total SALE listings (`listing.operation = 'sale'`, D-016) on the
   * LO/HI property respectively, across every source — the number the
   * card leads with ("7 anuncios ↔ 13 anuncios", issue #615), distinct
   * from `pair_count` above. */
  listing_count_lo: number;
  listing_count_hi: number;
  /** The lowest-id ACTIVE search profile the LO/HI property currently
   * matches (`profile_listing_state.matched = true`, joined against a
   * non-archived `search_profile` — same predicate as
   * `PROFILE_RELEVANT_EXISTS`), or `null` when it matches none. Issue
   * #626: `/profiles/[id]/properties/[propertyId]` 404s unless the
   * property is a matched candidate for THAT profile id
   * (`isPropertyMatchedForProfile`), so linking to the internal detail
   * page needs a real profile id, not just the pair's `profile_relevant`
   * boolean (which only says "at least one side matches SOME profile" —
   * not which one, and not which side). `null` means there is currently
   * no internal page to link to for that side; the UI must not render a
   * broken link in that case. See `internalPropertyHref` below — the
   * ONE place this resolves to a URL. */
  property_lo_profile_id: number | null;
  property_hi_profile_id: number | null;
  top_confidence: number;
  top_match_basis: MatchBasis;
  latest_created_at: string;
  profile_relevant: boolean;
  evidence: DedupEvidenceItem[];
}

/** The one place `{profileId, propertyId}` becomes the internal detail-page
 * URL (issue #626) — `null` when the side has no matched active profile to
 * link through (`property_lo_profile_id`/`property_hi_profile_id` above),
 * in which case the caller must render no link rather than a route that
 * 404s. Never re-templated inline at each call site. */
export function internalPropertyHref(profileId: number | null, propertyId: number): string | null {
  if (profileId === null) return null;
  return `/profiles/${profileId}/properties/${propertyId}`;
}

export interface DedupPropertyPairCounts {
  /** Number of distinct property-pair GROUPS, not underlying rows — this is
   * the 669 in #600's 892→669 measurement. */
  total: number;
  /** How many groups contain AT LEAST ONE row of that basis — a group with
   * mixed-basis evidence counts under every basis it contains, so these can
   * sum to more than `total` (unlike the flat view's mutually-exclusive
   * per-row counts). */
  by_basis: Partial<Record<MatchBasis, number>>;
  profile_relevant_total: number;
}

// ============================================================
// Matched-photo resolution (issue #615)
// ============================================================
//
// The owner, mid-review: "cuando esté comparando duplicados me muestras 4
// fotos como máximo. necesito ver el resto, o por lo menos que me muestres
// las que coinciden, no las primeras que te salen." A photo_hash card that
// shows photo #1 of each listing is frequently showing two unrelated
// rooms — the actual evidence that produced the suggestion might be photo
// #5 against photo #9. `etl/dedup/signals/photo_hash.py::matched_pairs`
// is the ONE place that pairing is computed (issue #615, D-135) and
// persisted into `suggested_merge.detail.matched_photos` as
// `{url_a, url_b, distance}[]`, strongest match first. This module NEVER
// re-derives the matching itself (that would be a second, driftable
// implementation of the exact same perceptual-hash threshold logic) — it
// only resolves which of url_a/url_b belongs to the "lo" vs "hi" property
// side (a plain URL-membership lookup, not a re-match) and orders each
// side's photo list matched-first.

/** One `{url_a, url_b, distance}` entry exactly as `photo_hash.py`
 * persists it — url_a/url_b are NOT guaranteed to correspond to
 * lo/hi (they follow whichever of the two listings `evaluate_pair` happened
 * to receive as "a"/"b"); use `resolveMatchedPhotos` to pin that down. */
export interface RawMatchedPhotoPair {
  url_a: string;
  url_b: string;
  distance: number;
}

/** A matched pair resolved to this group's canonical lo/hi property order. */
export interface ResolvedPhotoMatch {
  urlLo: string;
  urlHi: string;
  distance: number;
}

/** Defensive parse of `detail.matched_photos` — absent/malformed shapes
 * (a stale pre-#615 `suggested_merge` row never had this key at all)
 * degrade to no matches, never a crash. */
export function parseMatchedPhotos(detail: Record<string, unknown>): RawMatchedPhotoPair[] {
  const raw = detail.matched_photos;
  if (!Array.isArray(raw)) return [];
  const result: RawMatchedPhotoPair[] = [];
  for (const entry of raw) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).url_a === "string" &&
      typeof (entry as Record<string, unknown>).url_b === "string" &&
      typeof (entry as Record<string, unknown>).distance === "number"
    ) {
      const e = entry as { url_a: string; url_b: string; distance: number };
      result.push({ url_a: e.url_a, url_b: e.url_b, distance: e.distance });
    }
  }
  return result;
}

/** Resolves `detail.matched_photos` against this evidence row's two sides,
 * pinning each pair's URLs to lo/hi (never guessed — a plain membership
 * test against each side's OWN `photo_urls`). A pair whose URLs match
 * neither side as expected (a listing's `photo_urls` changed on a later
 * fetch since the suggestion was filed — stale evidence) is silently
 * dropped rather than mis-assigned. Sorted strongest-match-first
 * (ascending distance) — `matched_pairs` already returns it that way, but
 * this re-sorts defensively rather than trusting persisted order.
 */
export function resolveMatchedPhotos(
  detail: Record<string, unknown>,
  listingLo: Pick<DedupListingSide, "photo_urls">,
  listingHi: Pick<DedupListingSide, "photo_urls">,
): ResolvedPhotoMatch[] {
  const loSet = new Set(listingLo.photo_urls);
  const hiSet = new Set(listingHi.photo_urls);
  const resolved: ResolvedPhotoMatch[] = [];
  for (const m of parseMatchedPhotos(detail)) {
    if (loSet.has(m.url_a) && hiSet.has(m.url_b)) {
      resolved.push({ urlLo: m.url_a, urlHi: m.url_b, distance: m.distance });
    } else if (loSet.has(m.url_b) && hiSet.has(m.url_a)) {
      resolved.push({ urlLo: m.url_b, urlHi: m.url_a, distance: m.distance });
    }
  }
  resolved.sort((a, b) => a.distance - b.distance);
  return resolved;
}

export interface OrderedPhoto {
  url: string;
  /** True when this photo is one side of a matched pair — the evidence
   * that actually produced the suggestion, not just "one of the photos
   * this listing happens to have". */
  matched: boolean;
}

/** Orders one side's photos MATCHED FIRST (in match-strength order), then
 * every remaining unmatched photo in its original order — never
 * interleaved by index. `matchedUrlsInOrder` is that side's half of
 * `resolveMatchedPhotos`'s output (`.map(m => m.urlLo)` or `.map(m =>
 * m.urlHi)`), already strongest-first. A matched URL not actually present
 * in `allUrls` (shouldn't happen — `resolveMatchedPhotos` only emits URLs
 * it found via membership in the first place — but defensive rather than
 * assumed) is skipped rather than fabricating a photo.
 *
 * DEDUPES `matchedUrlsInOrder` by URL, keeping only the FIRST (strongest,
 * since the caller already sorted it that way) occurrence — PR #621
 * review B2: `photo_hash.py`'s `matched_pairs` deliberately does NOT
 * dedupe the LARGER side (one photo there can legitimately be the best
 * match for more than one smaller-side photo, e.g. two near-identical
 * shots of the same room), so `resolveMatchedPhotos`'s output for that
 * side can repeat a URL. Left un-deduped here, a repeated URL rendered
 * TWICE: an inflated photo count ("5 fotos" for a 4-photo listing), a
 * duplicate React `key` (`ListingSidePanel`'s `key={photo.url}`), and one
 * of the 4 precious default-view slots wasted on a repeat instead of a
 * genuinely different photo. Measured live: 27 of 447 (6%) of pending
 * photo_hash rows have a larger side with more matches than distinct
 * matched URLs.
 */
export function orderPhotosMatchedFirst(allUrls: string[], matchedUrlsInOrder: string[]): OrderedPhoto[] {
  const allSet = new Set(allUrls);
  const seen = new Set<string>();
  const matched: string[] = [];
  for (const url of matchedUrlsInOrder) {
    if (allSet.has(url) && !seen.has(url)) {
      seen.add(url);
      matched.push(url);
    }
  }
  const unmatched = allUrls.filter((url) => !seen.has(url));
  return [
    ...matched.map((url) => ({ url, matched: true })),
    ...unmatched.map((url) => ({ url, matched: false })),
  ];
}
