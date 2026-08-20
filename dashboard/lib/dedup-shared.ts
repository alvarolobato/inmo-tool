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
export type DedupActionKind = "confirm" | "reject";

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
  /** How many pending listing-pair rows collapsed into this one question. */
  pair_count: number;
  top_confidence: number;
  top_match_basis: MatchBasis;
  latest_created_at: string;
  profile_relevant: boolean;
  evidence: DedupEvidenceItem[];
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
