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

export interface DedupSuggestion {
  id: number;
  match_basis: MatchBasis;
  confidence: number;
  detail: Record<string, unknown>;
  created_at: string;
  listing_a: DedupListingSide;
  listing_b: DedupListingSide;
  /**
   * True when at least one side's property matches an active (non-archived)
   * search profile — i.e. `profile_listing_state.matched = true` for a
   * profile with `archived_at IS NULL`. Profile-relevant pairs sort first in
   * the default view (see lib/dedup.ts `listDedupSuggestions`). Lets the UI
   * badge the row and decrement `profile_relevant_total` on resolve without a
   * refetch. Issue #246.
   */
  profile_relevant: boolean;
}

export interface DedupSuggestionCounts {
  /** Full pending queue size — always over the whole queue, never scoped to
   * the toggle, so switching "solo mis perfiles" / "ver todos" never makes the
   * chip counts flicker. */
  total: number;
  by_basis: Partial<Record<MatchBasis, number>>;
  /** How many of the `total` pending pairs are profile-relevant. Always a
   * subset count over the full queue (never scoped to the toggle), so the UI
   * can show "12 relevantes a tus perfiles · 200 en total". Issue #246. */
  profile_relevant_total: number;
}

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
