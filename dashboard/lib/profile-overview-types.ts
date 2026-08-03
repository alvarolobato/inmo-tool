/**
 * Perfiles overview result shape (issue #192) — client-safe (no `pg`
 * import). Split out of lib/db/profile-overview.ts for the same reason
 * lib/profiles-schema.ts is split from lib/db/profiles.ts: that module
 * imports lib/db-write (the `pg` client), which pulls in Node built-ins
 * (`fs`, `net`, `tls`, `dns`) that don't exist in a browser bundle. Client
 * components (the Perfiles list page, ProfileOverviewRow) need the *types*
 * but must never import the DB access function itself.
 * lib/db/profile-overview.ts re-exports everything here for server-side
 * callers (the API route).
 */

import type { SearchProfileRow } from "@/lib/profiles-schema";

export interface ProfileThumbnail {
  property_id: number;
  /** Null when the property has no active listing with at least one photo — the client renders the existing placeholder tile, never an empty gap (same convention as CandidateCard). */
  photo_url: string | null;
}

export interface ProfileOverviewMetrics {
  matched_count: number;
  /** Matched properties with property.created_at >= COALESCE(last_viewed_at, created_at - 1 day) — "seen since your last visit", or "first-seen in the last 24h" for a never-visited profile. */
  new_count: number;
  accepted_count: number;
  rejected_count: number;
  starred_count: number;
  /** MIN(listing.current_price) across a matched property's active listings, aggregated across all matched properties. Null when no matched property has a priced active listing. */
  min_price: number | null;
  median_price: number | null;
  max_price: number | null;
  cold_start_count: number;
  trained_count: number;
  /** Raw count from profile_scoring_model, for an "N/32" progress readout — null when no model row exists yet (pure cold-start, 0 feedback). */
  training_example_count: number | null;
  /** training_example_count >= MIN_TRAINING_EXAMPLES (lib/scoring/pipeline.ts). */
  model_trained: boolean;
  /**
   * Gross yield median (%), "bruto (estimado)" — null whenever the profile
   * has no `thesis_params.rent_assumption` OR no matched property has both a
   * priced active listing and a known m2_built. Never a fabricated 0 —
   * absence must render as "no yield chip", not "0%".
   */
  gross_yield_median_pct: number | null;
  /** Count of matched properties with at least one AI-derived tone='warn' flag. A real, always-computed count — 0 is legitimate; the row hides the chip for 0, that's a rendering choice, not a data-absence one. */
  flagged_count: number;
  /** Top 4 matched candidates by (score DESC NULLS LAST, property.id DESC). */
  thumbnails: ProfileThumbnail[];
}

export type ProfileOverviewEntry =
  | { ok: true; profile: SearchProfileRow; metrics: ProfileOverviewMetrics }
  | { ok: false; id: number; name: string; issues: string[] };
