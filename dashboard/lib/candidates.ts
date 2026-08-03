/**
 * Reads the materialized candidate set for a search profile (task 2.4,
 * `profile_listing_state.matched = true`) grouped at the `property` level.
 *
 * Server-only: imports lib/db-write (the `pg` client) — same reasoning as
 * lib/db/profiles.ts, never import this from a client component.
 *
 * One row out = one deduplicated property (issue #19: "one card per
 * property_id, not per listing" — a property with 2+ linked listings after
 * task 2.2's dedup engine merges cross-site duplicates must render as a
 * single candidate with multiple source badges, never as separate cards).
 */

import { sql } from "@/lib/db-write";

export interface CandidateListingSummary {
  id: number;
  source: string;
  url: string | null;
  current_price: number | null;
}

/**
 * A qualitative flag rendered as a compact badge on the card (#152).
 *
 * `tone` drives colour only — `neutral` for descriptive facts, `warn` for
 * things that materially change what you're buying (occupied, debt sale,
 * partial ownership). Deliberately not derived from the label text so a
 * future flag can't accidentally inherit the wrong urgency.
 */
export interface CandidateFlag {
  kind: string;
  label: string;
  tone: "neutral" | "warn";
}

export interface CandidateRow {
  property_id: number;
  address: string | null;
  lat: number | null;
  lon: number | null;
  property_type: string | null;
  m2_built: number | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: string | null;
  /** First photo across the property's active listings — the card's primary visual (#152). Null when no linked listing has photos. */
  thumbnail_url: string | null;
  /**
   * AI-derived qualitative flags (#25 occupancy/debt-sale/partial-sale, #26
   * condition). Always present, empty until an assessment exists — the card
   * renders nothing rather than a placeholder, so this degrades cleanly both
   * before #25 lands and for properties it hasn't assessed yet.
   */
  flags: CandidateFlag[];
  /** MIN(listing.current_price) across the property's *active* listings — same convention as task 2.4's price-band filter (see data-model.md). Null if no active listing has a price. */
  min_price: number | null;
  /** Earliest first_seen_at across all of the property's listings. */
  first_seen_at: string | null;
  listings: CandidateListingSummary[];
  /** Task 3.2 (#21): null until this profile has a trained model, or the property hasn't been rescored since one was trained. */
  score: number | null;
  /** Task 3.3 (#22): human-readable, model-grounded explanation of `score` — a cold-start message when `score` is null because no model exists yet, not because this specific property hasn't been rescored. */
  rank_explanation: string | null;
}

export interface CandidatePage {
  items: CandidateRow[];
  /**
   * Opaque cursor string — pass back as `cursor` to fetch the next page; null
   * when this is the last page. Encodes both `score` and `property_id` (a
   * compound keyset key), not just an id, because results are ordered
   * globally by score (see `listCandidates`) — a single-id cursor can't
   * resume a score-ordered scan correctly. Callers must not parse this
   * themselves; treat it as opaque.
   */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * `score` is a sigmoid output, always in (0, 1) when set (task 3.2) — -1 is
 * a safe sentinel for "no score yet" that still sorts correctly last under
 * `ORDER BY effective_score DESC`, letting the keyset comparison stay a
 * plain numeric compound compare instead of needing NULL-aware branching.
 */
const NO_SCORE_SENTINEL = -1;

interface CandidateCursor {
  score: number;
  id: number;
}

function encodeCursor(score: number | null, id: number): string {
  const effectiveScore = score ?? NO_SCORE_SENTINEL;
  return Buffer.from(JSON.stringify([effectiveScore, id])).toString("base64url");
}

/** Returns null on any malformed input — callers should treat that as an invalid cursor (400), not silently fall back to page 1. */
export function decodeCursor(raw: string): CandidateCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "number" &&
      Number.isFinite(parsed[0]) &&
      typeof parsed[1] === "number" &&
      Number.isInteger(parsed[1]) &&
      parsed[1] > 0
    ) {
      return { score: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

interface RawCandidateRow {
  property_id: number;
  address: string | null;
  lat: string | null;
  lon: string | null;
  property_type: string | null;
  m2_built: string | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: string | null;
  thumbnail_url: string | null;
  min_price: string | null;
  first_seen_at: string | null;
  listings: CandidateListingSummary[];
  score: string | null;
  rank_explanation: string | null;
}

/**
 * Maps an `ai_assessment` row to the badges the card shows.
 *
 * Only surfaces verdicts that change the investment decision — a `vacant`
 * property or a `full` sale is the unremarkable default and gets no badge,
 * because a badge on every card carries no information.
 *
 * De-duplicated by `kind`: a property with two linked listings can carry two
 * assessments agreeing that it's occupied, and "Ocupado Ocupado" on the card
 * would be a dedup bug made visible.
 */
function flagsFromAssessments(rows: RawAssessmentRow[]): CandidateFlag[] {
  const flags: CandidateFlag[] = [];
  for (const row of rows) {
    const result = row.result ?? {};
    const occupancy = typeof result.occupancy === "string" ? result.occupancy : null;
    const saleType = typeof result.sale_type === "string" ? result.sale_type : null;
    const condition = typeof result.condition === "string" ? result.condition : null;

    if (occupancy !== null && occupancy !== "vacant" && occupancy !== "unknown") {
      flags.push({
        kind: `occupancy:${occupancy}`,
        label: OCCUPANCY_LABELS[occupancy] ?? occupancy,
        tone: "warn",
      });
    }
    if (saleType !== null && saleType !== "full" && saleType !== "unknown") {
      flags.push({
        kind: `sale_type:${saleType}`,
        label: SALE_TYPE_LABELS[saleType] ?? saleType,
        tone: "warn",
      });
    }
    if (condition !== null && condition !== "unknown") {
      const label = CONDITION_LABELS[condition];
      if (label !== undefined) flags.push({ kind: `condition:${condition}`, label, tone: "neutral" });
    }
  }
  const byKind = new Map<string, CandidateFlag>();
  for (const flag of flags) {
    if (!byKind.has(flag.kind)) byKind.set(flag.kind, flag);
  }
  return [...byKind.values()];
}

/**
 * Vocabularies mirror #24's enum-language convention: Spanish for market
 * terms of art that lose meaning in translation (`nuda propiedad`,
 * `a reformar`), English for generic system state (`vacant`, `full`).
 * Unknown values fall through to the raw string rather than being dropped,
 * so a vocabulary added by #25 still renders something useful here.
 */
const OCCUPANCY_LABELS: Record<string, string> = {
  tenanted: "Alquilado",
  squatted: "Ocupado",
  occupied: "Ocupado",
};

const SALE_TYPE_LABELS: Record<string, string> = {
  debt: "Venta de deuda",
  partial: "Venta parcial",
  nuda_propiedad: "Nuda propiedad",
  proindiviso: "Proindiviso",
};

const CONDITION_LABELS: Record<string, string> = {
  a_reformar: "A reformar",
  a_rehabilitar: "A rehabilitar",
  obra_nueva: "Obra nueva",
};

interface RawAssessmentRow {
  property_id: number;
  result: Record<string, unknown> | null;
}

type AssessmentKey = "property_id" | "listing_id" | null;
let assessmentKeyPromise: Promise<AssessmentKey> | null = null;

/**
 * Which column `ai_assessment` is keyed on, probed once per process.
 *
 * #25 (occupancy) is in flight and re-keys this table from `listing_id` to
 * `property_id`. Both shapes are live at once across branches, and simply
 * assuming the new one would mean the badges never render (and every list
 * request logs a caught DB error) until that lands. Probing lets the same
 * code read either shape correctly instead of degrading to "no flags".
 *
 * A failed probe is not cached — a transient DB blip would otherwise
 * disable flags for the lifetime of the process.
 */
function assessmentKeyColumn(): Promise<AssessmentKey> {
  if (assessmentKeyPromise === null) {
    assessmentKeyPromise = sql<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'ai_assessment'
          AND column_name IN ('property_id', 'listing_id')`,
    )
      .then((rows) => {
        const columns = new Set(rows.map((r) => r.column_name));
        // property_id wins when both exist: that's #25 mid-migration, and the
        // new key is the authoritative one (an assessment belongs to the
        // deduplicated property, not to whichever site's listing produced it).
        if (columns.has("property_id")) return "property_id" as const;
        if (columns.has("listing_id")) return "listing_id" as const;
        return null;
      })
      .catch((err) => {
        console.warn("[candidates] could not probe ai_assessment shape:", err);
        assessmentKeyPromise = null;
        return null;
      });
  }
  return assessmentKeyPromise;
}

/**
 * Best-effort: returns no flags rather than propagating if `ai_assessment`
 * can't be read. The badges are an enhancement — not something worth
 * failing the whole candidate feed over.
 */
async function loadFlags(propertyIds: number[]): Promise<Map<number, CandidateFlag[]>> {
  const byProperty = new Map<number, CandidateFlag[]>();
  if (propertyIds.length === 0) return byProperty;

  const key = await assessmentKeyColumn();
  if (key === null) return byProperty;

  let rows: RawAssessmentRow[];
  try {
    rows =
      key === "property_id"
        ? await sql<RawAssessmentRow>(
            `SELECT property_id, result
               FROM ai_assessment
              WHERE property_id = ANY($1::bigint[])`,
            [propertyIds],
          )
        : await sql<RawAssessmentRow>(
            // Pre-#25 shape: assessments hang off a listing, so a deduplicated
            // property collects the assessments of every listing linked to it.
            `SELECT l.property_id, a.result
               FROM ai_assessment a
               JOIN listing l ON l.id = a.listing_id
              WHERE l.property_id = ANY($1::bigint[])`,
            [propertyIds],
          );
  } catch (err) {
    console.warn("[candidates] ai_assessment unavailable, rendering without flags:", err);
    return byProperty;
  }

  const grouped = new Map<number, RawAssessmentRow[]>();
  for (const row of rows) {
    const id = Number(row.property_id);
    const list = grouped.get(id) ?? [];
    list.push(row);
    grouped.set(id, list);
  }
  for (const [id, group] of grouped) {
    byProperty.set(id, flagsFromAssessments(group));
  }
  return byProperty;
}

/**
 * Keyset (cursor) pagination on `(effective_score DESC, property.id DESC)`,
 * not OFFSET — this table is expected to grow into the thousands (issue #19
 * Technical approach #3: "don't fetch-all-and-filter-client-side"), and
 * OFFSET pagination degrades linearly with page depth while keyset
 * pagination stays O(limit) regardless of how deep the caller pages.
 *
 * Task 3.4 (#23), EC-1: ordering is global (by score, best first), not just
 * within a page — an earlier version of this function sorted only the
 * already-fetched page client-side, which meant a high-scoring candidate on
 * page 2 could render below a low-scoring one on page 1 (a real bug, not a
 * documented tradeoff: "Cargar más" appends pages, so per-page sorting
 * actively defeated the point of scoring for any profile with more matched
 * candidates than one page). The compound `(score, id)` keyset below fixes
 * this: `p.id` alone is no longer sufficient to resume the scan once the
 * primary sort key is `score`, so the cursor must carry both.
 */
export async function listCandidates(
  profileId: number,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<CandidatePage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const rawCursor = opts.cursor ?? null;

  let cursorScore: number | null = null;
  let cursorId: number | null = null;
  if (rawCursor !== null) {
    const decoded = decodeCursor(rawCursor);
    if (decoded === null) {
      throw new Error("Cursor no válido.");
    }
    cursorScore = decoded.score;
    cursorId = decoded.id;
  }

  // Fetch one extra row so we can tell whether a next page truly exists
  // instead of assuming it does whenever a page is exactly full (that
  // false-positive was showing a dead "Cargar más" on the last page).
  const rows = await sql<RawCandidateRow>(
    `SELECT
       p.id AS property_id,
       p.address,
       p.lat,
       p.lon,
       p.property_type,
       p.m2_built,
       p.rooms,
       p.bathrooms,
       p.floor,
       -- First photo of the first active listing that has any. ORDER BY
       -- l4.id keeps the choice stable across runs so the card doesn't
       -- shuffle its thumbnail between loads.
       (SELECT l4.photo_urls[1]
          FROM listing l4
         WHERE l4.property_id = p.id
           AND l4.status = 'active'
           AND l4.photo_urls IS NOT NULL
           AND array_length(l4.photo_urls, 1) > 0
         ORDER BY l4.id
         LIMIT 1) AS thumbnail_url,
       (SELECT MIN(l2.current_price)
          FROM listing l2
         WHERE l2.property_id = p.id AND l2.status = 'active') AS min_price,
       (SELECT MIN(l3.first_seen_at)
          FROM listing l3
         WHERE l3.property_id = p.id) AS first_seen_at,
       pls.score,
       pls.rank_explanation,
       COALESCE(
         (SELECT json_agg(
                   json_build_object(
                     'id', l.id,
                     'source', l.source,
                     'url', l.url,
                     'current_price', l.current_price
                   )
                   ORDER BY l.source
                 )
            FROM listing l
           WHERE l.property_id = p.id AND l.status = 'active'),
         '[]'
       ) AS listings
     FROM profile_listing_state pls
     JOIN property p ON p.id = pls.property_id
     WHERE pls.profile_id = $1
       AND pls.matched = true
       AND (
         $2::double precision IS NULL
         OR COALESCE(pls.score, ${NO_SCORE_SENTINEL}) < $2::double precision
         OR (COALESCE(pls.score, ${NO_SCORE_SENTINEL}) = $2::double precision AND p.id < $3::bigint)
       )
     ORDER BY COALESCE(pls.score, ${NO_SCORE_SENTINEL}) DESC, p.id DESC
     LIMIT $4`,
    [profileId, cursorScore, cursorId, limit + 1],
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const flagsByProperty = await loadFlags(pageRows.map((r) => Number(r.property_id)));

  const items: CandidateRow[] = pageRows.map((r) => ({
    // pg returns bigint columns as strings; property_id needs to be a real
    // JSON number (Phase 3's scoring/ranking will compare/sort on it) —
    // unlike lat/lon/m2_built this one was missed and shipped as a string
    // ("179" not 179) in the live API response.
    property_id: Number(r.property_id),
    address: r.address,
    lat: r.lat !== null ? Number(r.lat) : null,
    lon: r.lon !== null ? Number(r.lon) : null,
    property_type: r.property_type,
    m2_built: r.m2_built !== null ? Number(r.m2_built) : null,
    rooms: r.rooms,
    bathrooms: r.bathrooms,
    floor: r.floor,
    thumbnail_url: r.thumbnail_url,
    flags: flagsByProperty.get(Number(r.property_id)) ?? [],
    min_price: r.min_price !== null ? Number(r.min_price) : null,
    first_seen_at: r.first_seen_at,
    listings: r.listings,
    score: r.score !== null ? Number(r.score) : null,
    rank_explanation: r.rank_explanation,
  }));

  // Cursor is derived from the *last row of the SQL result*, which is
  // already in final (score, id) DESC order — there is no separate
  // client-side re-sort of `pageRows` to accidentally derive it from
  // afterward (that was the bug: a previous version sorted `pageRows` by
  // score for display *after* the cursor should have been captured from
  // the id-ordered fetch, corrupting the keyset scan).
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore
    ? encodeCursor(lastRow.score !== null ? Number(lastRow.score) : null, Number(lastRow.property_id))
    : null;

  return { items, nextCursor };
}

export interface AdjacentCandidates {
  /** The property ranked immediately better than this one, or null if it's first. */
  prevPropertyId: number | null;
  /** The property ranked immediately worse than this one, or null if it's last. */
  nextPropertyId: number | null;
}

/**
 * Neighbours of `propertyId` in this profile's candidate ordering (#152/#146),
 * so the detail page can offer prev/next without going back to the list.
 *
 * **Recomputed live, not snapshotted.** Both are defensible; this picks live
 * deliberately:
 *
 *   - It reuses the exact `(COALESCE(score, -1) DESC, id DESC)` ordering and
 *     keyset comparison `listCandidates` uses, so the sequence can't silently
 *     diverge from the list the user is paging through. A snapshot would need
 *     that ordering duplicated in a second place and kept in sync — the class
 *     of drift that produced #23's cursor bug, where the cursor was derived
 *     from a different ordering than the display sort.
 *   - It stays stateless: no session storage, no cursor list to carry through
 *     navigation, nothing to invalidate.
 *
 * The cost is real and worth naming: giving feedback triggers a retrain, so
 * scores can move under you mid-browse, and "next" may then differ from what
 * the list showed when you opened it — you might revisit one property or skip
 * past one. That is bounded (a re-rank shuffles neighbours, it doesn't hide
 * candidates) and it always reflects the model's current belief, which for a
 * tool whose whole point is learning your preferences is the more honest
 * behaviour. A snapshot would page you through a ranking the model has
 * already moved on from.
 */
export async function getAdjacentCandidates(
  profileId: number,
  propertyId: number,
): Promise<AdjacentCandidates> {
  const anchor = await sql<{ score: string | null }>(
    `SELECT score
       FROM profile_listing_state
      WHERE profile_id = $1 AND property_id = $2 AND matched = true`,
    [profileId, propertyId],
  );
  if (anchor.length === 0) {
    return { prevPropertyId: null, nextPropertyId: null };
  }
  const anchorScore = anchor[0].score !== null ? Number(anchor[0].score) : NO_SCORE_SENTINEL;

  // "next" = ranked after the anchor under the list's DESC ordering; "prev"
  // reverses both the comparison and the sort, then takes the nearest row.
  const [nextRows, prevRows] = await Promise.all([
    sql<{ property_id: number }>(
      `SELECT pls.property_id
         FROM profile_listing_state pls
        WHERE pls.profile_id = $1
          AND pls.matched = true
          AND (COALESCE(pls.score, ${NO_SCORE_SENTINEL}) < $2::double precision
               OR (COALESCE(pls.score, ${NO_SCORE_SENTINEL}) = $2::double precision
                   AND pls.property_id < $3::bigint))
        ORDER BY COALESCE(pls.score, ${NO_SCORE_SENTINEL}) DESC, pls.property_id DESC
        LIMIT 1`,
      [profileId, anchorScore, propertyId],
    ),
    sql<{ property_id: number }>(
      `SELECT pls.property_id
         FROM profile_listing_state pls
        WHERE pls.profile_id = $1
          AND pls.matched = true
          AND (COALESCE(pls.score, ${NO_SCORE_SENTINEL}) > $2::double precision
               OR (COALESCE(pls.score, ${NO_SCORE_SENTINEL}) = $2::double precision
                   AND pls.property_id > $3::bigint))
        ORDER BY COALESCE(pls.score, ${NO_SCORE_SENTINEL}) ASC, pls.property_id ASC
        LIMIT 1`,
      [profileId, anchorScore, propertyId],
    ),
  ]);

  return {
    nextPropertyId: nextRows.length > 0 ? Number(nextRows[0].property_id) : null,
    prevPropertyId: prevRows.length > 0 ? Number(prevRows[0].property_id) : null,
  };
}
