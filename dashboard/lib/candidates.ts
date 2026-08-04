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
  /**
   * Capped, de-duplicated union of `photo_urls` across the property's
   * *active* listings, grouped by listing in `source` order (alphabetical),
   * then by within-listing position — the same status filter and the same
   * order the detail page's gallery uses (`getPropertyDetail` in
   * lib/property-detail.ts, which filters to active listings and reads them
   * `ORDER BY source`), and the same de-dup-by-URL rule (first occurrence in
   * that order wins). Powers the card's photo-first lead image (#152) and
   * its in-place photo ticker (#167): `photos[0]` is genuinely the same lead
   * image the detail page's hero shows, and flicking through the ticker
   * walks a prefix of the same sequence the lightbox does — not an
   * independently-ordered subset (a real, reproduced bug prior to #167's
   * review must-fix 1: this query used to filter `active` but order by
   * `listing.id`, while the detail page didn't filter status at all and
   * ordered by `source` — different lead image, different order, different
   * set, including a withdrawn listing's photos able to lead the detail
   * gallery). The card's primary visual is `photos[0]`; empty means no
   * active listing has photos (the card falls back to a placeholder).
   *
   * Capped at `MAX_CARD_PHOTOS`, unlike the detail gallery (uncapped by
   * design — a user who has drilled into one property should see
   * everything). A list page renders up to `DEFAULT_LIMIT` cards at once;
   * fetching every photo of every card would make an already-nontrivial
   * page query far more expensive for a control most users only nudge a
   * couple of times per card.
   *
   * #167 removed the separate `thumbnail_url` field this replaced — it was
   * always exactly `photos[0] ?? null`, a redundant derived value once the
   * full array exists (this project's "no dual representations of the same
   * fact" default; see AGENTS.md's backwards-compatibility policy). Read
   * `photos[0]` directly.
   */
  photos: string[];
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
  /**
   * FRESHEST `last_seen_at` across the property's *active* sale listings —
   * "last time discover() re-confirmed this property is still live" (issue
   * #243, roadmap §6.1). MAX, not MIN: a deduplicated property is only as
   * stale as its most-recently-confirmed listing (if any linked listing was
   * seen recently, the property isn't stale). Active-sale-only, matching
   * `min_price`/`listings`/`photos` above — a withdrawn sibling's frozen
   * timestamp must neither rescue nor is re-confirmed by discover(). Null when
   * no active sale listing has a `last_seen_at` (unknown, not fresh). The card
   * renders `StalenessBadge` from this; see lib/staleness.ts for why
   * `last_seen_at` and not `last_fetched_at`.
   */
  last_seen_at: string | null;
  listings: CandidateListingSummary[];
  /** Task 3.2 (#21): null until this profile has a trained model, or the property hasn't been rescored since one was trained. */
  score: number | null;
  /** Task 3.3 (#22): human-readable, model-grounded explanation of `score` — a cold-start message when `score` is null because no model exists yet, not because this specific property hasn't been rescored. */
  rank_explanation: string | null;
  /**
   * Durable marker for whether `score`/`rank_explanation` came from the
   * cold-start heuristic or a real trained model (task 3.4, #23) — null
   * until the property has been scored at all. The client should switch on
   * this, not on comparing `rank_explanation` against the cold-start
   * sentence: that string is *persisted* at scoring time
   * (lib/scoring/cold-start.ts), so a purely cosmetic copy edit to the
   * constant would silently stop matching every already-written row and
   * un-suppress the old sentence on every card (#152 review).
   */
  score_kind: "cold_start" | "trained" | null;
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
 * Cap on `CandidateRow.photos` per property (#167). A list page renders up
 * to `DEFAULT_LIMIT` cards; an uncapped union (the detail gallery's rule)
 * would let one heavily-photographed property drag the whole page's photo
 * payload up unpredictably. 8 is comfortably more than the ticker gets
 * clicked through in practice.
 *
 * This constant also bounds the per-*listing* LATERAL LIMIT inside
 * `listCandidates`'s SQL, not just the final output length — see that
 * query's comment. (An earlier version of this comment claimed the query
 * had a cheap per-row LIMIT; it didn't — the cap was only applied *after* a
 * full unnest + sort of every photo of every active listing, O(total
 * photos) not O(cap). Re-measured on PG16: +70% latency over the old
 * single-thumbnail query on a normal page, ~4x on a property with one
 * heavily-photographed listing. Fixed by #167's review must-fix 2 — see
 * the PR body for before/after EXPLAIN ANALYZE numbers.)
 */
const MAX_CARD_PHOTOS = 8;

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
  photos: string[];
  min_price: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  listings: CandidateListingSummary[];
  score: string | null;
  rank_explanation: string | null;
  score_kind: "cold_start" | "trained" | null;
}

/**
 * Maps a property's `ai_assessment` rows to the badges the card shows.
 *
 * Only surfaces verdicts that change the investment decision — a standard
 * "compraventa" of "pleno dominio" on a vacant property is the unremarkable
 * default and gets no badge, because a badge on every card carries no
 * information. Unrecognised codes are dropped rather than rendered as raw
 * text (#152 review, must-fix 3): both vocabularies below are closed
 * enumerations validated where the row is written (see `deriveCaveats` in
 * `lib/ai-assessment/occupancy.ts` and `CONDITION_CATEGORIES` in
 * `lib/ai-assessment/condition.ts`), so anything not in the label maps is
 * either the standard "nothing to report" value or evidence of drift between
 * this file and the writer's vocabulary — never scraped free text that could
 * grow the card.
 *
 * Exported for direct unit testing: this is the pure function findings #1
 * and #3 in the #152 review trace back to, and it is cheap to test in
 * isolation without a mocked `pg` pool.
 *
 * De-duplicated by `kind` as a second line of defence — the real fix for
 * "two verdicts on one axis" is `loadFlags`'s `DISTINCT ON`, which ensures
 * `rows` here holds at most one row per `assessment_type` per property. This
 * dedup keeps `flagsFromAssessments` safe to call with un-deduplicated input
 * too (e.g. from a future caller), rather than depending on that invariant.
 */
export function flagsFromAssessments(rows: RawAssessmentRow[]): CandidateFlag[] {
  const flags: CandidateFlag[] = [];
  for (const row of rows) {
    const result = row.result ?? {};

    // #156's three-axis occupancy assessment (occupancy/transaction/
    // ownership verdicts) derives `caveats` once, server-side, from those
    // three verdicts — see `deriveCaveats` in lib/ai-assessment/occupancy.ts.
    // Reading it here instead of re-parsing the raw verdict objects keeps
    // this file and that one from ever disagreeing about which combinations
    // are noteworthy (the same "single computation" rule explainScore()
    // follows for rank_explanation).
    const caveats = Array.isArray(result.caveats) ? result.caveats : [];
    for (const code of caveats) {
      if (typeof code !== "string") continue;
      const label = CAVEAT_LABELS[code];
      if (label !== undefined) flags.push({ kind: `caveat:${code}`, label, tone: "warn" });
    }

    // #26's condition assessment (lib/ai-assessment/condition.ts) writes a
    // flat `result.condition` string (single axis — no nested `verdict`
    // object like occupancy's three). `reformado`/`unclear` are the
    // unremarkable/no-info defaults and intentionally have no label below,
    // same as occupancy's `pleno_dominio` getting no caveat badge.
    const condition = typeof result.condition === "string" ? result.condition : null;
    if (condition !== null) {
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
 * Every non-default value of `OccupancyResult.caveats` (#25 + #145) worth a
 * badge — see `CAVEAT_CODES` in lib/ai-assessment/occupancy.ts for the
 * closed vocabulary this mirrors. Spanish for market terms of art that lose
 * meaning in translation (`nuda propiedad`), English for generic system
 * state where no better Spanish term reads as naturally short.
 */
const CAVEAT_LABELS: Record<string, string> = {
  tenanted: "Alquilado",
  occupied_illegally: "Ocupado",
  venta_deuda: "Venta de deuda",
  nuda_propiedad: "Nuda propiedad",
  usufructo: "Usufructo",
  proindiviso: "Proindiviso",
  derecho_superficie: "Derecho de superficie",
};

/**
 * Every `ConditionCategory` (#26, `lib/ai-assessment/condition.ts`) worth a
 * badge. `reformado` (the unremarkable default, like occupancy's
 * `pleno_dominio`) and `unclear` (no information, not a finding) are
 * deliberately absent — a badge on every card carries no information.
 */
const CONDITION_LABELS: Record<string, string> = {
  a_reformar: "A reformar",
  obra_nueva: "Obra nueva",
};

export interface RawAssessmentRow {
  property_id: number;
  result: Record<string, unknown> | null;
}

/**
 * Best-effort: returns no flags rather than propagating if `ai_assessment`
 * can't be read. The badges are an enhancement — not something worth
 * failing the whole candidate feed over.
 *
 * `ai_assessment` allows multiple rows per `(property_id, assessment_type)`
 * — one per `prompt_version` (see the `ai_assessment_property_key` unique
 * constraint in etl/schema/init.sql) — so a prompt-version bump leaves the
 * *old* verdict's row in place alongside the new one. `DISTINCT ON
 * (property_id, assessment_type)`, ordered by `generated_at DESC` (most
 * recent first), picks exactly the current verdict per axis; without it,
 * `flagsFromAssessments`'s dedup-by-`kind` cannot help, because two
 * different verdicts on the same axis produce two different `kind` strings
 * (e.g. `occupancy:tenanted` and `occupancy:occupied_illegally` reported
 * simultaneously) — the exact bug the #152 review reproduced (#152 review,
 * must-fix 1).
 */
async function loadFlags(propertyIds: number[]): Promise<Map<number, CandidateFlag[]>> {
  const byProperty = new Map<number, CandidateFlag[]>();
  if (propertyIds.length === 0) return byProperty;

  let rows: RawAssessmentRow[];
  try {
    rows = await sql<RawAssessmentRow>(
      `SELECT DISTINCT ON (property_id, assessment_type)
              property_id, result
         FROM ai_assessment
        WHERE property_id = ANY($1::bigint[])
          AND assessment_type IN ('occupancy', 'condition')
        ORDER BY property_id, assessment_type, generated_at DESC NULLS LAST, id DESC`,
      [propertyIds],
    );
  } catch (err) {
    console.warn("[candidates] ai_assessment unavailable, rendering without flags:", err);
    return byProperty;
  }

  const grouped = new Map<number, RawAssessmentRow[]>();
  for (const row of rows) {
    const id = row.property_id;
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
       -- Capped, de-duplicated union of photo_urls across this property's
       -- active listings (#167), ordered to match the detail page's gallery
       -- exactly (getPropertyDetail in lib/property-detail.ts, which also
       -- filters to active listings and reads them ORDER BY source): grouped
       -- by listing in 'source' order, then within-listing position — so
       -- photos[0] here is genuinely the same lead image the detail page's
       -- hero uses. See CandidateRow.photos's docstring for the bug this
       -- alignment fixes (#167 review must-fix 1).
       --
       -- Cost is bounded per LISTING, not per photo (must-fix 2): the inner
       -- LATERAL unnests l4.photo_urls WITH ORDINALITY and LIMITs to
       -- MAX_CARD_PHOTOS with NO ORDER BY inside that LATERAL. unnest() is
       -- evaluated lazily (value-per-call) and WITH ORDINALITY is always
       -- emitted in increasing/array order, so a bare LIMIT stops the
       -- generator after the first MAX_CARD_PHOTOS elements instead of
       -- materializing (and sorting) every photo of every active listing
       -- before truncating — the previous shape, which only capped via the
       -- outer WHERE rn <= N *after* that full unnest+sort, measured +70%
       -- over the old single-thumbnail query on a normal page and ~4x on one
       -- heavily-photographed listing (see PR body for numbers). Adding an
       -- ORDER BY inside the LATERAL would silently reintroduce that cost —
       -- Postgres can't avoid materializing a Sort's input just because a
       -- LIMIT sits above it — so this deliberately leans on unnest's
       -- already-ordered output instead of re-deriving it.
       --
       -- array_remove(l4.photo_urls, NULL) drops NULL array elements before
       -- unnesting — an unguarded NULL survives into 'photos', is counted by
       -- the client's 'photos.length > 1' ticker gate, and renders the
       -- placeholder mid-cycle when the ticker lands on that index.
       --
       -- DISTINCT ON (photo_url) dedupes by URL (a listing can repeat a
       -- photo, and two sources can share one after dedup), keeping each
       -- photo's first (source, ord) occurrence; row_number() over that same
       -- (source, ord) order re-establishes visual order (DISTINCT ON's own
       -- ORDER BY has to sort by photo_url first, which scrambles it); the
       -- outer WHERE re-caps to MAX_CARD_PHOTOS before json_agg (needed
       -- because up to listing_count * MAX_CARD_PHOTOS rows can reach this
       -- point once multiple listings each contribute their own capped
       -- share), and json_agg's own ORDER BY rn guarantees the final array
       -- reflects that order (aggregates don't otherwise guarantee input
       -- order).
       COALESCE(
         (SELECT json_agg(photo_url ORDER BY rn)
            FROM (
              SELECT photo_url, row_number() OVER (ORDER BY listing_source, ord) AS rn
                FROM (
                  SELECT DISTINCT ON (photo_url)
                         photo_url, listing_source, ord
                    FROM (
                      SELECT l4.source AS listing_source, u.photo_url, u.ord
                        FROM listing l4
                        CROSS JOIN LATERAL (
                          SELECT uu.photo_url, uu.ord
                            FROM unnest(array_remove(l4.photo_urls, NULL))
                                 WITH ORDINALITY AS uu(photo_url, ord)
                           LIMIT ${MAX_CARD_PHOTOS}
                        ) u
                       WHERE l4.property_id = p.id
                         AND l4.status = 'active'
                         AND l4.operation = 'sale'
                         AND l4.photo_urls IS NOT NULL
                    ) per_listing
                   ORDER BY photo_url, listing_source, ord
                ) deduped
            ) numbered
           WHERE numbered.rn <= ${MAX_CARD_PHOTOS}
         ),
         '[]'
       ) AS photos,
       -- AND l2.operation = 'sale' (issue #31): every property reaching
       -- this query already came through profile_listing_state, which
       -- scope-query.ts now gates on an active SALE listing existing at
       -- all — so a rent-only property can't reach here today. Kept
       -- explicit anyway (docs/architecture/data-model.md flagged this
       -- exact subquery by name as a "cross-cutting landmine for #31,
       -- not yet fixed") rather than relying solely on that upstream
       -- invariant holding forever: a candidate card showing a monthly
       -- rent figure labelled as a sale price would be a severe,
       -- silent bug if it ever did leak through.
       (SELECT MIN(l2.current_price)
          FROM listing l2
         WHERE l2.property_id = p.id AND l2.status = 'active' AND l2.operation = 'sale') AS min_price,
       (SELECT MIN(l3.first_seen_at)
          FROM listing l3
         WHERE l3.property_id = p.id) AS first_seen_at,
       -- FRESHEST last_seen_at across active SALE listings (issue #243): the
       -- staleness age the card renders. MAX, not MIN — the property is only
       -- as stale as its most-recently-re-confirmed listing. Same
       -- active + operation='sale' filter as min_price/listings/photos, so a
       -- withdrawn listing's frozen last_seen_at can neither make the property
       -- look fresher than its live listings nor be treated as a live
       -- re-confirmation. NULL when no active sale listing has been seen.
       (SELECT MAX(l6.last_seen_at)
          FROM listing l6
         WHERE l6.property_id = p.id AND l6.status = 'active' AND l6.operation = 'sale') AS last_seen_at,
       pls.score,
       pls.rank_explanation,
       pls.score_kind,
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
           WHERE l.property_id = p.id AND l.status = 'active' AND l.operation = 'sale'),
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

  const flagsByProperty = await loadFlags(pageRows.map((r) => r.property_id));

  const items: CandidateRow[] = pageRows.map((r) => ({
    // property_id (bigint) arrives as a real JS number via the driver-level
    // int8 type parser (db-shared.ts, #155) — no per-site Number() needed.
    // lat/lon/m2_built/min_price/score below are NUMERIC, a different OID
    // with a genuine precision rationale — those coercions stay.
    property_id: r.property_id,
    address: r.address,
    lat: r.lat !== null ? Number(r.lat) : null,
    lon: r.lon !== null ? Number(r.lon) : null,
    property_type: r.property_type,
    m2_built: r.m2_built !== null ? Number(r.m2_built) : null,
    rooms: r.rooms,
    bathrooms: r.bathrooms,
    floor: r.floor,
    photos: r.photos ?? [],
    flags: flagsByProperty.get(r.property_id) ?? [],
    min_price: r.min_price !== null ? Number(r.min_price) : null,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    listings: r.listings,
    score: r.score !== null ? Number(r.score) : null,
    rank_explanation: r.rank_explanation,
    score_kind: r.score_kind ?? null,
  }));

  // Cursor is derived from the *last row of the SQL result*, which is
  // already in final (score, id) DESC order — there is no separate
  // client-side re-sort of `pageRows` to accidentally derive it from
  // afterward (that was the bug: a previous version sorted `pageRows` by
  // score for display *after* the cursor should have been captured from
  // the id-ordered fetch, corrupting the keyset scan).
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore
    ? encodeCursor(lastRow.score !== null ? Number(lastRow.score) : null, lastRow.property_id)
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
    nextPropertyId: nextRows.length > 0 ? nextRows[0].property_id : null,
    prevPropertyId: prevRows.length > 0 ? prevRows[0].property_id : null,
  };
}
