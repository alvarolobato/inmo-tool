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
  type DedupListingSide,
  type DedupSuggestion,
  type DedupSuggestionCounts,
  type MatchBasis,
} from "@/lib/dedup-shared";

export * from "@/lib/dedup-shared";

interface SuggestionRow {
  id: number;
  match_basis: MatchBasis;
  confidence: string;
  detail: Record<string, unknown>;
  created_at: string;
  la_listing_id: number;
  la_property_id: number;
  la_source: string;
  la_url: string | null;
  la_price: string | null;
  la_photos: string[] | null;
  la_address: string | null;
  la_city: string | null;
  la_m2: string | null;
  la_rooms: number | null;
  la_bathrooms: number | null;
  la_type: string | null;
  lb_listing_id: number;
  lb_property_id: number;
  lb_source: string;
  lb_url: string | null;
  lb_price: string | null;
  lb_photos: string[] | null;
  lb_address: string | null;
  lb_city: string | null;
  lb_m2: string | null;
  lb_rooms: number | null;
  lb_bathrooms: number | null;
  lb_type: string | null;
}

function sideA(row: SuggestionRow): DedupListingSide {
  return {
    listing_id: row.la_listing_id,
    property_id: row.la_property_id,
    source: row.la_source,
    url: row.la_url,
    current_price: row.la_price !== null ? Number(row.la_price) : null,
    address: row.la_address,
    city: row.la_city,
    m2_built: row.la_m2 !== null ? Number(row.la_m2) : null,
    rooms: row.la_rooms,
    bathrooms: row.la_bathrooms,
    property_type: row.la_type,
    photo_urls: row.la_photos ?? [],
  };
}

function sideB(row: SuggestionRow): DedupListingSide {
  return {
    listing_id: row.lb_listing_id,
    property_id: row.lb_property_id,
    source: row.lb_source,
    url: row.lb_url,
    current_price: row.lb_price !== null ? Number(row.lb_price) : null,
    address: row.lb_address,
    city: row.lb_city,
    m2_built: row.lb_m2 !== null ? Number(row.lb_m2) : null,
    rooms: row.lb_rooms,
    bathrooms: row.lb_bathrooms,
    property_type: row.lb_type,
    photo_urls: row.lb_photos ?? [],
  };
}

/**
 * List pending review-queue suggestions, strongest evidence first.
 *
 * Default order is `confidence DESC, created_at DESC` — a live run's actual
 * distribution (585 pending: 527 `fuzzy` averaging ~0.585, 52 `photo_hash`
 * averaging ~0.78) means confidence-descending already surfaces the
 * high-value `photo_hash`/`reference_code`/`phone` rows before the long
 * `fuzzy` tail, without needing a special case per basis. `basis` narrows
 * to one match_basis (the filter chips) on top of that ordering.
 */
export async function listDedupSuggestions(opts: {
  basis?: MatchBasis;
  limit?: number;
  offset?: number;
}): Promise<DedupSuggestion[]> {
  const limit = opts.limit ?? 30;
  const offset = opts.offset ?? 0;
  const params: unknown[] = [];
  let basisClause = "";
  if (opts.basis) {
    params.push(opts.basis);
    basisClause = `AND sm.match_basis = $${params.length}`;
  }
  params.push(limit, offset);

  const rows = await sql<SuggestionRow>(
    `SELECT
        sm.id, sm.match_basis, sm.confidence, sm.detail, sm.created_at,
        la.id AS la_listing_id, la.property_id AS la_property_id, la.source AS la_source,
        la.url AS la_url, la.current_price AS la_price, la.photo_urls AS la_photos,
        pa.address AS la_address, pa.city AS la_city, pa.m2_built AS la_m2,
        pa.rooms AS la_rooms, pa.bathrooms AS la_bathrooms, pa.property_type AS la_type,
        lb.id AS lb_listing_id, lb.property_id AS lb_property_id, lb.source AS lb_source,
        lb.url AS lb_url, lb.current_price AS lb_price, lb.photo_urls AS lb_photos,
        pb.address AS lb_address, pb.city AS lb_city, pb.m2_built AS lb_m2,
        pb.rooms AS lb_rooms, pb.bathrooms AS lb_bathrooms, pb.property_type AS lb_type
      FROM suggested_merge sm
      JOIN listing la ON la.id = sm.listing_id_a
      JOIN property pa ON pa.id = la.property_id
      JOIN listing lb ON lb.id = sm.listing_id_b
      JOIN property pb ON pb.id = lb.property_id
      WHERE sm.status = 'pending' ${basisClause}
      ORDER BY sm.confidence DESC, sm.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    match_basis: row.match_basis,
    confidence: Number(row.confidence),
    detail: row.detail ?? {},
    created_at: row.created_at,
    listing_a: sideA(row),
    listing_b: sideB(row),
  }));
}

/** Counts for the filter chips — always over the *full* pending queue, not
 * whatever page/basis is currently displayed, so switching chips shows
 * accurate counts without a round trip per chip. */
export async function getDedupSuggestionCounts(): Promise<DedupSuggestionCounts> {
  const rows = await sql<{ match_basis: MatchBasis; count: string }>(
    `SELECT match_basis, COUNT(*) AS count FROM suggested_merge
      WHERE status = 'pending' GROUP BY match_basis`,
  );
  const by_basis: Partial<Record<MatchBasis, number>> = {};
  let total = 0;
  for (const row of rows) {
    const n = Number(row.count);
    by_basis[row.match_basis] = n;
    total += n;
  }
  return { total, by_basis };
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
