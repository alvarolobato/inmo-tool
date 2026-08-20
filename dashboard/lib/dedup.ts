/**
 * Dedup review-queue reads/writes — the dashboard half of the "missing half
 * of the dedup workflow": `etl/dedup/engine.py`'s `confirm_suggestion()`/
 * `reject_suggestion()` existed and were CLI-callable well before this file,
 * but nothing in the dashboard could reach them. A real run against the
 * owner's live data filed 585 `suggested_merge` rows for human review with
 * no UI anywhere that could act on one.
 *
 * Confirm/reject do NOT call the merge logic in-process — they enqueue a
 * `suggested_merge_action` row. The ETL container's `etl/dedup/actions.py`
 * (polled every few seconds, `run_action_poll_loop`, started in
 * etl/main.py) drains that queue by calling the *real* Python
 * `confirm_suggestion`/`reject_suggestion`. See `suggested_merge_action`'s
 * comment in etl/schema/init.sql for the full "why a queue table, not a
 * synchronous call" reasoning — the dashboard (Node/TypeScript) and the
 * dedup engine (Python) run in separate containers with no shared
 * filesystem or RPC channel, and this project's established answer to
 * "Node needs Python's business logic" is a polled queue table
 * (etl/capture.py's `extension_capture` is the precedent), never a second,
 * drifting TypeScript reimplementation of the merge.
 *
 * Server-only: imports lib/db-write (the `pg` client) — never import this
 * from a client component. Client components must import types/constants
 * from lib/dedup-shared instead (see that file's docstring).
 */

import { sql, withTransaction } from "@/lib/db-write";
import {
  type DedupActionKind,
  type DedupActionRow,
  type DedupEvidenceItem,
  type DedupPropertyPairCounts,
  type DedupPropertyPairSuggestion,
  type MatchBasis,
} from "@/lib/dedup-shared";

export * from "@/lib/dedup-shared";

/**
 * Profile-relevance predicate (issue #246): a suggestion pair is relevant to
 * the owner's active markets when either listing's property matches an active
 * (non-archived) search profile. "Matches a profile" is the
 * `profile_listing_state` materialization's own signal (`matched = true`),
 * keyed on `property_id` — NOT `listing_id` (see the table's schema comment in
 * etl/schema/init.sql: state is one row per (profile_id, property_id), so a
 * merged property carries a single per-profile state). Referenced as an
 * uncorrelated fragment against the `la`/`lb` listing aliases both queries
 * below share, so the definition can't drift between the list and the count.
 * Both `idx_profile_listing_state_property` (property_id) and the
 * `search_profile(id)` PK make this an indexed lookup.
 */
const PROFILE_RELEVANT_EXISTS = `EXISTS (
        SELECT 1 FROM profile_listing_state pls
        JOIN search_profile sp ON sp.id = pls.profile_id
        WHERE sp.archived_at IS NULL
          AND pls.matched = true
          AND pls.property_id IN (la.property_id, lb.property_id)
      )`;

/**
 * Same-property exclusion (issue #605 Part 1) — a pending `suggested_merge`
 * row whose two listings already share a `property_id` was already resolved
 * by some OTHER pair's merge since this one was filed. `engine.py`'s
 * `confirm_suggestion` handles this at write time (marks it `confirmed`, no
 * new merge), but between dedup runs the review query never filtered it on
 * READ — so the owner opened one, got the "already merged" banner, and only
 * found out after clicking. #600 measured 72 such pending rows in
 * production.
 *
 * Applied to every read of the `pending` queue (list AND both count
 * queries) so the chip/badge counts never disagree with what the list
 * actually shows — trading "repeats a stale question" for "count says N but
 * only N-72 cards render" would just be a different confusing thing.
 * Requires `la`/`lb` (the listing aliases every query here already joins on
 * `sm.listing_id_a`/`sm.listing_id_b`) to be in scope.
 */
const NOT_ALREADY_MERGED = `la.property_id <> lb.property_id`;

/**
 * Every still-pending `suggested_merge` row, one per SQL row, with both
 * listings normalized to (prop_lo, prop_hi) = the pair's canonical
 * lower-id-first property order (issue #605 Part 2). `#600` measured 892
 * pending LISTING-pair rows collapsing to 669 distinct PROPERTY-pair
 * questions — property A with 6 listings and property B with 7 produce up
 * to 42 listing-pair rows all asking the identical question, one property
 * pair alone had 38. Grouping `listDedupPropertyPairSuggestions`/
 * `getDedupPropertyPairCounts` on `(prop_lo, prop_hi)` collapses that,
 * regardless of which physical property `suggested_merge.listing_id_a`/`_b`
 * happened to record as "a" for any given row — `a_is_lo` lets the outer
 * query pick each per-listing field from whichever original side is the
 * canonical "lo" property without a second join. Embedded as a derived
 * table (`FROM (${PENDING_PAIR_CTE}) p`), not a `WITH` clause, so it can be
 * reused verbatim inside both the list query and the two count queries
 * without repeating the join/filter text three times.
 */
const PENDING_PAIR_CTE = `
      SELECT
        sm.id, sm.match_basis, sm.confidence, sm.detail, sm.created_at,
        LEAST(la.property_id, lb.property_id) AS prop_lo,
        GREATEST(la.property_id, lb.property_id) AS prop_hi,
        (la.property_id = LEAST(la.property_id, lb.property_id)) AS a_is_lo,
        la.id AS la_listing_id, la.source AS la_source, la.url AS la_url,
        la.current_price AS la_price, la.photo_urls AS la_photos,
        lb.id AS lb_listing_id, lb.source AS lb_source, lb.url AS lb_url,
        lb.current_price AS lb_price, lb.photo_urls AS lb_photos,
        ${PROFILE_RELEVANT_EXISTS} AS profile_relevant
      FROM suggested_merge sm
      JOIN listing la ON la.id = sm.listing_id_a
      JOIN listing lb ON lb.id = sm.listing_id_b
      WHERE sm.status = 'pending' AND ${NOT_ALREADY_MERGED}`;

/** One evidence entry as it comes back inside `PairRow.evidence` — a
 * `jsonb_agg(jsonb_build_object(...))` blob, already parsed into a plain JS
 * array/object by the `pg` driver's built-in jsonb handling (same mechanism
 * `sm.detail` relies on elsewhere in this file). Numeric/bigint values
 * embedded THIS way come back as real JS numbers (Postgres's `to_json` casts
 * emit them unquoted), unlike the same columns read directly at the top
 * level of a query, which the `pg` driver returns as strings for NUMERIC —
 * see `SuggestionRow` above for that contrast. */
interface RawEvidenceJson {
  suggestion_id: number;
  match_basis: MatchBasis;
  confidence: number;
  detail: Record<string, unknown>;
  created_at: string;
  lo_listing_id: number;
  lo_source: string;
  lo_url: string | null;
  lo_price: number | null;
  lo_photos: string[] | null;
  hi_listing_id: number;
  hi_source: string;
  hi_url: string | null;
  hi_price: number | null;
  hi_photos: string[] | null;
}

/** One grouped property-pair row from `listDedupPropertyPairSuggestions`'s
 * query — `lo_*`/`hi_*` are PROPERTY-level fields (shared by every evidence
 * entry in the group, since they're the same two properties every time),
 * `top_*` are the aggregate headline fields, and `evidence` carries the
 * per-listing-pair detail. */
interface PairRow {
  prop_lo: number;
  prop_hi: number;
  lo_address: string | null;
  lo_city: string | null;
  lo_m2: string | null;
  lo_rooms: number | null;
  lo_bathrooms: number | null;
  lo_type: string | null;
  hi_address: string | null;
  hi_city: string | null;
  hi_m2: string | null;
  hi_rooms: number | null;
  hi_bathrooms: number | null;
  hi_type: string | null;
  /** Total `operation = 'sale'` (D-016) listings on each side, across
   * every source — issue #615's "7 anuncios ↔ 13 anuncios", distinct from
   * `pair_count` (the internal evidence-row count) below. */
  lo_listing_count: number;
  hi_listing_count: number;
  /** Issue #626: the lowest-id active profile each property currently
   * matches, or `null` — see `DedupPropertyPairSuggestion.property_lo_profile_id`'s
   * docstring (lib/dedup-shared.ts) for why this can't be derived from the
   * pair-level `profile_relevant` boolean alone. */
  lo_profile_id: number | null;
  hi_profile_id: number | null;
  pair_count: number;
  top_confidence: string;
  top_match_basis: MatchBasis;
  // `MAX(p.created_at)` is a top-level TIMESTAMPTZ column, not embedded in
  // a jsonb blob — the `pg` driver's default type parsers return that as a
  // real JS `Date`, unlike the SAME field read back out of `evidence`'s
  // jsonb_build_object below (Postgres's own `to_json` cast serializes a
  // timestamp as a string, so `RawEvidenceJson.created_at` genuinely is a
  // string). Typed accurately here and converted once in mapPairRow.
  latest_created_at: Date;
  profile_relevant: boolean;
  evidence: RawEvidenceJson[];
}

function mapPairRow(row: PairRow): DedupPropertyPairSuggestion {
  const evidence: DedupEvidenceItem[] = row.evidence.map((e) => ({
    suggestion_id: e.suggestion_id,
    match_basis: e.match_basis,
    confidence: Number(e.confidence),
    detail: e.detail ?? {},
    created_at: e.created_at,
    listing_lo: {
      listing_id: e.lo_listing_id,
      property_id: row.prop_lo,
      source: e.lo_source,
      url: e.lo_url,
      current_price: e.lo_price !== null ? Number(e.lo_price) : null,
      address: row.lo_address,
      city: row.lo_city,
      m2_built: row.lo_m2 !== null ? Number(row.lo_m2) : null,
      rooms: row.lo_rooms,
      bathrooms: row.lo_bathrooms,
      property_type: row.lo_type,
      photo_urls: e.lo_photos ?? [],
    },
    listing_hi: {
      listing_id: e.hi_listing_id,
      property_id: row.prop_hi,
      source: e.hi_source,
      url: e.hi_url,
      current_price: e.hi_price !== null ? Number(e.hi_price) : null,
      address: row.hi_address,
      city: row.hi_city,
      m2_built: row.hi_m2 !== null ? Number(row.hi_m2) : null,
      rooms: row.hi_rooms,
      bathrooms: row.hi_bathrooms,
      property_type: row.hi_type,
      photo_urls: e.hi_photos ?? [],
    },
  }));

  return {
    pair_key: `${row.prop_lo}-${row.prop_hi}`,
    property_lo_id: row.prop_lo,
    property_hi_id: row.prop_hi,
    pair_count: row.pair_count,
    listing_count_lo: row.lo_listing_count,
    listing_count_hi: row.hi_listing_count,
    property_lo_profile_id: row.lo_profile_id,
    property_hi_profile_id: row.hi_profile_id,
    top_confidence: Number(row.top_confidence),
    top_match_basis: row.top_match_basis,
    latest_created_at: row.latest_created_at.toISOString(),
    profile_relevant: row.profile_relevant,
    evidence,
  };
}

/**
 * List pending review-queue suggestions grouped by PROPERTY pair (issue
 * #605 Part 2) — one card per (property_lo_id, property_hi_id), carrying
 * every still-pending listing-pair row for that pair as `evidence`
 * (strongest first). See `PENDING_PAIR_CTE`'s docstring for the 892→669
 * measurement this collapses.
 *
 * `basis`/`onlyProfileRelevant` filter on GROUPS, not rows — a basis filter
 * keeps a group if ANY of its evidence rows carry that basis (via `HAVING
 * bool_or(...)`), but still returns the group's FULL evidence list (every
 * basis it has), not just the matching rows. That's deliberate: narrowing
 * to "groups that have at least one photo_hash match" is a useful triage
 * filter, but silently dropping a group's OTHER corroborating evidence
 * (e.g. a phone match on the same pair) would make a since-informed
 * confirm/reject decision look less corroborated than it actually is.
 *
 * Same default ordering intent as the flat `listDedupSuggestions`
 * (`profile_relevant DESC, confidence DESC, latest evidence DESC`), just
 * evaluated over each group's strongest evidence rather than one row.
 */
export async function listDedupPropertyPairSuggestions(opts: {
  basis?: MatchBasis;
  onlyProfileRelevant?: boolean;
  limit?: number;
  offset?: number;
}): Promise<DedupPropertyPairSuggestion[]> {
  const limit = opts.limit ?? 30;
  const offset = opts.offset ?? 0;
  const params: unknown[] = [];
  let havingBasis = "";
  if (opts.basis) {
    params.push(opts.basis);
    havingBasis = `AND bool_or(p.match_basis = $${params.length})`;
  }
  const havingRelevant = opts.onlyProfileRelevant ? "AND bool_or(p.profile_relevant)" : "";
  params.push(limit, offset);

  const rows = await sql<PairRow>(
    `SELECT
        p.prop_lo, p.prop_hi,
        plo.address AS lo_address, plo.city AS lo_city, plo.m2_built AS lo_m2,
        plo.rooms AS lo_rooms, plo.bathrooms AS lo_bathrooms, plo.property_type AS lo_type,
        phi.address AS hi_address, phi.city AS hi_city, phi.m2_built AS hi_m2,
        phi.rooms AS hi_rooms, phi.bathrooms AS hi_bathrooms, phi.property_type AS hi_type,
        (SELECT COUNT(*)::int FROM listing l WHERE l.property_id = p.prop_lo AND l.operation = 'sale') AS lo_listing_count,
        (SELECT COUNT(*)::int FROM listing l WHERE l.property_id = p.prop_hi AND l.operation = 'sale') AS hi_listing_count,
        -- Issue #626: the lowest-id ACTIVE profile each property currently
        -- matches — mirrors PROFILE_RELEVANT_EXISTS's own predicate
        -- (non-archived search_profile, profile_listing_state.matched =
        -- true) but resolved to a real profile_id per SIDE, not a pair-wide
        -- boolean, because the internal detail page 404s unless the
        -- property is a matched candidate for the EXACT profile id in its
        -- URL (isPropertyMatchedForProfile). Deterministic (lowest id) so
        -- the same property always links to the same profile across
        -- reloads. NULL when the property matches no active profile —
        -- the dashboard must not render a link in that case.
        (SELECT pls.profile_id FROM profile_listing_state pls
           JOIN search_profile sp ON sp.id = pls.profile_id
           WHERE sp.archived_at IS NULL AND pls.matched = true AND pls.property_id = p.prop_lo
           ORDER BY pls.profile_id ASC LIMIT 1) AS lo_profile_id,
        (SELECT pls.profile_id FROM profile_listing_state pls
           JOIN search_profile sp ON sp.id = pls.profile_id
           WHERE sp.archived_at IS NULL AND pls.matched = true AND pls.property_id = p.prop_hi
           ORDER BY pls.profile_id ASC LIMIT 1) AS hi_profile_id,
        COUNT(*)::int AS pair_count,
        MAX(p.confidence) AS top_confidence,
        (array_agg(p.match_basis ORDER BY p.confidence DESC, p.created_at DESC))[1] AS top_match_basis,
        MAX(p.created_at) AS latest_created_at,
        bool_or(p.profile_relevant) AS profile_relevant,
        jsonb_agg(jsonb_build_object(
          'suggestion_id', p.id,
          'match_basis', p.match_basis,
          'confidence', p.confidence,
          'detail', p.detail,
          'created_at', p.created_at,
          'lo_listing_id', CASE WHEN p.a_is_lo THEN p.la_listing_id ELSE p.lb_listing_id END,
          'lo_source', CASE WHEN p.a_is_lo THEN p.la_source ELSE p.lb_source END,
          'lo_url', CASE WHEN p.a_is_lo THEN p.la_url ELSE p.lb_url END,
          'lo_price', CASE WHEN p.a_is_lo THEN p.la_price ELSE p.lb_price END,
          'lo_photos', CASE WHEN p.a_is_lo THEN p.la_photos ELSE p.lb_photos END,
          'hi_listing_id', CASE WHEN p.a_is_lo THEN p.lb_listing_id ELSE p.la_listing_id END,
          'hi_source', CASE WHEN p.a_is_lo THEN p.lb_source ELSE p.la_source END,
          'hi_url', CASE WHEN p.a_is_lo THEN p.lb_url ELSE p.la_url END,
          'hi_price', CASE WHEN p.a_is_lo THEN p.lb_price ELSE p.la_price END,
          'hi_photos', CASE WHEN p.a_is_lo THEN p.lb_photos ELSE p.la_photos END
        ) ORDER BY p.confidence DESC, p.created_at DESC) AS evidence
      FROM (${PENDING_PAIR_CTE}) p
      JOIN property plo ON plo.id = p.prop_lo
      JOIN property phi ON phi.id = p.prop_hi
      GROUP BY p.prop_lo, p.prop_hi, plo.address, plo.city, plo.m2_built, plo.rooms, plo.bathrooms, plo.property_type,
               phi.address, phi.city, phi.m2_built, phi.rooms, phi.bathrooms, phi.property_type
      HAVING TRUE ${havingBasis} ${havingRelevant}
      ORDER BY profile_relevant DESC, top_confidence DESC, latest_created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return rows.map(mapPairRow);
}

/** Counts for the grouped queue's filter chips — mirrors
 * `getDedupSuggestionCounts` but counts distinct property-pair GROUPS, not
 * underlying rows (see `DedupPropertyPairCounts`'s docstring for why
 * `by_basis` values can sum to more than `total` here, unlike the flat
 * view). Two queries, both grouping the same `PENDING_PAIR_CTE` — a group's
 * basis membership (may-have-several) and its profile-relevance (a single
 * bool_or) don't reduce to one shared derived table without re-fetching
 * `bases` per row in the totals query for no reason, so they stay separate
 * like the flat view's `byBasisRows`/`relevantRows` split. */
export async function getDedupPropertyPairCounts(): Promise<DedupPropertyPairCounts> {
  const [byBasisRows, totalsRows] = await Promise.all([
    sql<{ match_basis: MatchBasis; count: number }>(
      `SELECT basis AS match_basis, COUNT(*)::int AS count
        FROM (
          SELECT prop_lo, prop_hi, array_agg(DISTINCT match_basis) AS bases
          FROM (${PENDING_PAIR_CTE}) p
          GROUP BY prop_lo, prop_hi
        ) g
        CROSS JOIN LATERAL unnest(g.bases) AS basis
        GROUP BY basis`,
    ),
    sql<{ total: number; profile_relevant_total: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE profile_relevant)::int AS profile_relevant_total
        FROM (
          SELECT prop_lo, prop_hi, bool_or(profile_relevant) AS profile_relevant
          FROM (${PENDING_PAIR_CTE}) p
          GROUP BY prop_lo, prop_hi
        ) g`,
    ),
  ]);
  const by_basis: Partial<Record<MatchBasis, number>> = {};
  for (const row of byBasisRows) {
    by_basis[row.match_basis] = Number(row.count);
  }
  const total = Number(totalsRows[0]?.total ?? 0);
  const profile_relevant_total = Number(totalsRows[0]?.profile_relevant_total ?? 0);
  return { total, by_basis, profile_relevant_total };
}

/** The suggestion's current status — used to refuse enqueueing a
 * confirm/reject against a suggestion that isn't `pending` any more (e.g. a
 * double-click, or a concurrent `ps dedup confirm` from the CLI) with a
 * clear 409 rather than silently queueing a request `process_pending_actions`
 * would just reject anyway on the ETL side, seconds later and invisibly. */
export async function getSuggestionStatus(suggestionId: number): Promise<string | null> {
  const rows = await sql<{ status: string }>(`SELECT status FROM suggested_merge WHERE id = $1`, [
    suggestionId,
  ]);
  return rows[0]?.status ?? null;
}

/** Enqueue a confirm/reject request. Returns the new action's id — the
 * caller polls `getDedupAction(id)` for the ETL-side result. */
export async function enqueueDedupAction(suggestionId: number, action: DedupActionKind): Promise<number> {
  return withTransaction(async (client) => {
    const res = await client.query<{ id: number }>(
      `INSERT INTO suggested_merge_action (suggestion_id, action)
       VALUES ($1, $2) RETURNING id`,
      [suggestionId, action],
    );
    return res.rows[0].id;
  });
}

export async function getDedupAction(actionId: number): Promise<DedupActionRow | null> {
  const rows = await sql<DedupActionRow>(
    `SELECT id, suggestion_id, action, status, error_msg, result
       FROM suggested_merge_action WHERE id = $1`,
    [actionId],
  );
  return rows[0] ?? null;
}
