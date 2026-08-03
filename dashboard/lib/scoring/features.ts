/**
 * Structured feature extraction for the scoring model (task 3.2, #21).
 *
 * Deliberately structured-data-only per issue #21's scope: AI-derived
 * qualitative features (Phase 4) and embeddings (Phase 7.2) are out of scope
 * here — they get incorporated as additional model inputs by whichever task
 * lands after Phase 4 ships, not this one.
 *
 * `days_on_market` and `price_drop_pct` depend on task 5.4 (not built yet) —
 * per issue #21's explicit instruction, they degrade to `null` (imputed to
 * the pool mean at training/scoring time, same as any other missing value)
 * until that task lands and actually computes them. They're kept in
 * FEATURE_NAMES now so the model's shape doesn't change out from under
 * `profile_scoring_model.coefficients` once 5.4 exists — only `extractRaw`
 * needs a follow-up then, not this module's structure.
 */

import { sql } from "@/lib/db-write";
import type { Scope } from "@/lib/profiles-schema";

/** Fixed, ordered feature list — the order here IS the order of `coefficients` in the trained model. */
export const FEATURE_NAMES = [
  "price_per_m2_relative",
  "m2_built",
  "rooms",
  "floor_numeric",
  "has_elevator",
  "year_built",
  "days_on_market",
  "price_drop_pct",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** A single candidate's features before normalization — `null` means "unknown", not zero. */
export type RawFeatureVector = Record<FeatureName, number | null>;

/** Raw per-candidate data needed to compute features — one row per matched property for a profile. */
export interface ScoringInputRow {
  property_id: number;
  m2_built: number | null;
  rooms: number | null;
  floor: string | null;
  has_elevator: boolean | null;
  year_built: number | null;
  min_price: number | null;
  first_seen_at: string | null;
}

interface RawScoringInputRow {
  property_id: number;
  m2_built: string | null;
  rooms: number | null;
  floor: string | null;
  has_elevator: boolean | null;
  year_built: number | null;
  min_price: string | null;
  first_seen_at: string | null;
}

/**
 * All matched candidates for a profile, in one query — retraining scores a
 * profile's whole candidate pool at once (issue #21's Technical approach
 * #4), not one property at a time, so this must not be N+1'd from a loop.
 */
export async function fetchScoringInputs(profileId: number): Promise<ScoringInputRow[]> {
  const rows = await sql<RawScoringInputRow>(
    `SELECT
       p.id AS property_id,
       p.m2_built,
       p.rooms,
       p.floor,
       p.has_elevator,
       p.year_built,
       (SELECT MIN(l2.current_price)
          FROM listing l2
         WHERE l2.property_id = p.id AND l2.status = 'active') AS min_price,
       (SELECT MIN(l3.first_seen_at)
          FROM listing l3
         WHERE l3.property_id = p.id) AS first_seen_at
     FROM profile_listing_state pls
     JOIN property p ON p.id = pls.property_id
     WHERE pls.profile_id = $1 AND pls.matched = true`,
    [profileId],
  );

  // property_id (bigint) arrives as a real JS number via the driver-level
  // int8 type parser (db-shared.ts, #155). m2_built/min_price are NUMERIC —
  // pg still returns those as strings (a different OID, genuine precision
  // rationale — see #155), so those coercions stay.
  return rows.map((r) => ({
    property_id: r.property_id,
    m2_built: r.m2_built !== null ? Number(r.m2_built) : null,
    rooms: r.rooms,
    floor: r.floor,
    has_elevator: r.has_elevator,
    year_built: r.year_built,
    min_price: r.min_price !== null ? Number(r.min_price) : null,
    first_seen_at: r.first_seen_at,
  }));
}

/**
 * Sentinel for "ático" (top-floor/penthouse) labels, which have no numeric
 * floor of their own in the source data. Chosen well above any real Spanish
 * building's floor count so it orders as "highest", not to imply an actual
 * story count (task 3.2 review: Opus review of PR #91, item 3 — silently
 * dropping ático to `null` discarded a real, common, high-value signal).
 */
const ATICO_SENTINEL = 50;

/**
 * Best-effort parse of Spanish floor labels into a numeric ordering.
 * Returns `null` (missing, not zero) for anything unrecognized — this is a
 * soft scoring feature, not the hard `min_floor` filter that issue #17
 * explicitly dropped as unimplementable against this same free-text column;
 * a soft feature can tolerate "sometimes unknown" in a way a hard filter
 * can't.
 *
 * Patterns are checked against real label strings pulled from this
 * project's own fixtures (`Bajos`, `Planta baja`, `Ático`, `Entreplanta`,
 * `Semi-sótano`), not synthesized ones — see PR #91's review round for the
 * concrete failures this was fixed against.
 */
export function parseFloorNumeric(floor: string | null): number | null {
  if (!floor) return null;
  const normalized = floor
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // strip accents: "ático" -> "atico", "sótano" -> "sotano"

  // "bajo"/"baja"/"bajos"/"bajas" as a standalone word also matches inside
  // "planta baja" (feminine agreement with "planta"), so one pattern covers
  // both the bare and "planta baja" forms.
  if (/\bbaj[oa]s?\b/.test(normalized) || /\bentresuelo\b/.test(normalized)) return 0;
  if (/\bentreplanta\b/.test(normalized)) return 0.5;
  // Must be checked before the plain "sotano" pattern below: a hyphenated
  // or spaced "semi-sótano"/"semi sótano" contains "sotano" as its own
  // standalone word and would otherwise fall through to the -1 branch.
  if (/\bsemi[-\s]?sotano\b/.test(normalized)) return -0.5;
  if (/\bsotano\b/.test(normalized)) return -1;
  if (/\batico\b/.test(normalized)) return ATICO_SENTINEL;

  const match = normalized.match(/(\d+)/);
  if (match) return Number(match[1]);

  return null;
}

/**
 * `price_per_m2_relative`: the candidate's own price-per-m² divided by a
 * "target" price-per-m² derived from the profile's own price and size
 * bands (price_mid / size_mid) — 1.0 means "priced exactly at what this
 * profile considers a typical price-per-m²", <1 cheaper, >1 pricier. This
 * is one reasonable reading of issue #21's "price-per-m² relative to
 * profile price-band midpoint" (the issue doesn't pin down size-band
 * involvement); documented here since it's a judgment call, not spec text.
 *
 * Degrades gracefully when bands/data are missing:
 * - No size band set -> falls back to plain price-relative (candidate
 *   price / price_mid), since there's no size reference to build a
 *   per-m² target from.
 * - No price band set at all -> null (missing, imputed like any other
 *   feature) — there's no reference point to be "relative to".
 */
function priceRelativeToBand(price: number | null, m2Built: number | null, scope: Scope): number | null {
  if (price === null) return null;

  const { price_min, price_max, size_min, size_max } = scope;
  if (price_min === undefined && price_max === undefined) return null;

  const priceMid = midpoint(price_min, price_max, price);
  if (priceMid <= 0) return null;

  if (size_min === undefined && size_max === undefined) {
    return price / priceMid;
  }
  if (m2Built === null || m2Built <= 0) return null;

  const sizeMid = midpoint(size_min, size_max, m2Built);
  if (sizeMid <= 0) return null;

  const targetPricePerM2 = priceMid / sizeMid;
  if (targetPricePerM2 <= 0) return null;

  return price / m2Built / targetPricePerM2;
}

/** Midpoint of a (possibly one-sided) band; falls back to `fallback` when neither bound is set. */
function midpoint(min: number | undefined, max: number | undefined, fallback: number): number {
  if (min !== undefined && max !== undefined) return (min + max) / 2;
  if (min !== undefined) return min;
  if (max !== undefined) return max;
  return fallback;
}

/** Pure: raw (non-normalized) feature vector for one candidate. */
export function extractRaw(row: ScoringInputRow, scope: Scope): RawFeatureVector {
  return {
    price_per_m2_relative: priceRelativeToBand(row.min_price, row.m2_built, scope),
    m2_built: row.m2_built,
    rooms: row.rooms,
    floor_numeric: parseFloorNumeric(row.floor),
    has_elevator: row.has_elevator === null ? null : row.has_elevator ? 1 : 0,
    year_built: row.year_built,
    // Not yet computable — task 5.4 owns this. See module docstring.
    days_on_market: null,
    price_drop_pct: null,
  };
}
