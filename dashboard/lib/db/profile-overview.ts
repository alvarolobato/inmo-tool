/**
 * Perfiles list aggregate overview — issue #192 (design: docs comment on
 * #176 §0/§5). Server-only: imports lib/db-write (the `pg` client), same
 * reasoning as lib/db/profiles.ts — never import this from a client
 * component.
 *
 * Backs `GET /api/profiles/overview`, the redesigned Perfiles list page's
 * ONLY data call (issue #193) — this module's whole point is answering "one
 * profile row's worth of metrics + thumbnails" for every active profile in a
 * single round trip, not `SearchProfileRow.length` round trips. Does NOT
 * replace `GET /api/profiles` (lib/db/profiles.ts's `listActiveProfiles`),
 * which keeps its existing plain shape for `ProfileSwitcher`/`ProfileForm`'s
 * edit flow and doubles as this page's degraded fallback when the heavier
 * query below fails (see #193's partial-failure handling).
 *
 * ## Shape (issue #113 dependency)
 *
 * Every active `search_profile` row is represented — a malformed `scope`
 * (issue #113) surfaces as `{ok: false, id, name, issues}`, never dropped.
 * Metrics are only computed for rows that parsed (`{ok: true, ...}`): a
 * profile whose scope can't be parsed has no meaningful "matched candidates"
 * concept to aggregate.
 *
 * ## Query shape (one statement, LATERAL-joined, each subquery bounded)
 *
 *   - `match_stats`: one LATERAL per profile scanning its own
 *     `profile_listing_state WHERE matched = true` rows (bounded by that
 *     profile's real matched-candidate count — the legitimate cost driver,
 *     not an accidental O(N); indexed via
 *     `idx_profile_listing_state_profile_matched`). Computes matched/new
 *     counts, price min/median/max, cold-start/trained counts, and (when the
 *     profile has a `rent_assumption`) the gross-yield median — all in one
 *     pass over the same joined property/listing rows, rather than four
 *     separate LATERALs each re-scanning the same set.
 *   - `feedback_counts`: ONE CTE covering every profile (last-write-wins per
 *     (profile_id, property_id), same semantics as `getCurrentState` in
 *     lib/db/feedback.ts, batched) — not a LATERAL, since feedback_event
 *     already carries profile_id directly and a plain GROUP BY answers every
 *     profile's counts in one scan.
 *   - `profile_scoring_model`: plain join on its primary key (profile_id) —
 *     O(1) per profile.
 *   - `flag_stats`: one LATERAL per profile, bounded to that profile's
 *     matched properties, reusing the same `DISTINCT ON (property_id)`
 *     most-recent-assessment rule as `lib/candidates.ts`'s `loadFlags`.
 *   - `thumbnails`: one LATERAL per profile bounded to `LIMIT 4`
 *     (top-4-by-score), each resolving exactly one lead photo via a bounded
 *     `unnest(...) WITH ORDINALITY ... LIMIT 1` with no ORDER BY inside that
 *     LATERAL — same discipline #167's review established for
 *     `lib/candidates.ts`'s photo query (an ORDER BY there would force
 *     Postgres to materialize and sort every photo of every listing before
 *     truncating, the exact O(total photos) cost #167 fixed).
 *
 * See the PR body for `EXPLAIN (ANALYZE, BUFFERS)` output against a
 * representative multi-profile, hundreds-of-matched-candidates dataset.
 */

import { sql } from "@/lib/db-write";
import { toProfileListEntry, type ProfileListEntry, type SearchProfileRawRow } from "./profiles";
import { MIN_TRAINING_EXAMPLES } from "@/lib/scoring/pipeline";
import type { ProfileThumbnail, ProfileOverviewMetrics, ProfileOverviewEntry } from "@/lib/profile-overview-types";

export type { ProfileThumbnail, ProfileOverviewMetrics, ProfileOverviewEntry } from "@/lib/profile-overview-types";

/**
 * Occupancy caveat codes that render as a tone='warn' badge — must mirror
 * `CAVEAT_LABELS`'s keys in lib/candidates.ts exactly (every occupancy
 * caveat there is tone='warn'; 'condition' assessments are all
 * tone='neutral', so they're excluded from this aggregate on purpose, not by
 * oversight). Duplicated here (rather than shared) because that file is a
 * TS module and this is a SQL literal; if lib/candidates.ts's vocabulary
 * changes, update this list too.
 */
const WARN_CAVEAT_CODES = [
  "tenanted",
  "occupied_illegally",
  "venta_deuda",
  "nuda_propiedad",
  "usufructo",
  "proindiviso",
  "derecho_superficie",
];

interface RawOverviewRow extends SearchProfileRawRow {
  matched_count: number;
  new_count: number;
  accepted_count: number;
  rejected_count: number;
  starred_count: number;
  min_price: string | null;
  median_price: string | null;
  max_price: string | null;
  cold_start_count: number;
  trained_count: number;
  training_example_count: number | null;
  gross_yield_median_pct: string | null;
  flagged_count: number;
  thumbnails: ProfileThumbnail[];
}

/**
 * Exported (not just for `fetchOverviewRows` below) so the integration test
 * suite can run `EXPLAIN (ANALYZE, BUFFERS) <this text>` against a
 * representative dataset without hand-copying the query — see
 * lib/db/__tests__/profile-overview.integration.test.ts. One SQL statement
 * for every active profile — both the raw scope/thesis_params
 * `toProfileListEntry` (issue #113) needs to decide ok/not-ok, AND the full
 * metrics bundle, in a single round trip (issue #192's "no per-profile
 * round trip from application code" contract — this includes not issuing a
 * second whole-table round trip for the base profile list either). See
 * module docstring for the per-LATERAL cost/bound rationale.
 */
export const OVERVIEW_QUERY_SQL = `WITH feedback_current AS (
       SELECT DISTINCT ON (profile_id, property_id) profile_id, property_id, feedback_type
       FROM feedback_event
       WHERE feedback_type IN ('accept', 'reject', 'star')
       ORDER BY profile_id, property_id, created_at DESC, id DESC
     ),
     feedback_counts AS (
       SELECT profile_id,
              COUNT(*) FILTER (WHERE feedback_type = 'accept') AS accepted_count,
              COUNT(*) FILTER (WHERE feedback_type = 'reject') AS rejected_count,
              COUNT(*) FILTER (WHERE feedback_type = 'star')  AS starred_count
         FROM feedback_current
        GROUP BY profile_id
     )
     SELECT
       sp.id, sp.name, sp.scope, sp.thesis_params, sp.archived_at, sp.created_at,
       sp.last_materialized_at, sp.last_viewed_at,
       COALESCE(match_stats.matched_count, 0)     AS matched_count,
       COALESCE(match_stats.new_count, 0)         AS new_count,
       COALESCE(fc.accepted_count, 0)             AS accepted_count,
       COALESCE(fc.rejected_count, 0)             AS rejected_count,
       COALESCE(fc.starred_count, 0)              AS starred_count,
       match_stats.min_price::text                AS min_price,
       match_stats.median_price::text              AS median_price,
       match_stats.max_price::text                AS max_price,
       COALESCE(match_stats.cold_start_count, 0)  AS cold_start_count,
       COALESCE(match_stats.trained_count, 0)     AS trained_count,
       psm.training_example_count,
       match_stats.gross_yield_median_pct::text   AS gross_yield_median_pct,
       COALESCE(flag_stats.flagged_count, 0)      AS flagged_count,
       COALESCE(thumb.thumbnails, '[]'::json)     AS thumbnails
     FROM search_profile sp
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) AS matched_count,
         COUNT(*) FILTER (
           WHERE p.created_at >= COALESCE(sp.last_viewed_at, sp.created_at - interval '1 day')
         ) AS new_count,
         MIN(cand.min_price) AS min_price,
         MAX(cand.min_price) AS max_price,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cand.min_price) AS median_price,
         COUNT(*) FILTER (WHERE pls.score_kind = 'cold_start') AS cold_start_count,
         COUNT(*) FILTER (WHERE pls.score_kind = 'trained')    AS trained_count,
         CASE
           WHEN sp.thesis_params #>> '{rent_assumption,eur_per_m2_month}' IS NOT NULL THEN
             PERCENTILE_CONT(0.5) WITHIN GROUP (
               ORDER BY
                 (sp.thesis_params #>> '{rent_assumption,eur_per_m2_month}')::numeric * 12 * p.m2_built
                 / cand.min_price * 100
             ) FILTER (WHERE cand.min_price IS NOT NULL AND p.m2_built IS NOT NULL AND p.m2_built > 0)
           ELSE NULL
         END AS gross_yield_median_pct
       FROM profile_listing_state pls
       JOIN property p ON p.id = pls.property_id
       CROSS JOIN LATERAL (
         SELECT MIN(l.current_price) AS min_price
           FROM listing l
          WHERE l.property_id = p.id AND l.status = 'active'
       ) cand
       WHERE pls.profile_id = sp.id AND pls.matched = true
     ) match_stats ON true
     LEFT JOIN feedback_counts fc ON fc.profile_id = sp.id
     LEFT JOIN profile_scoring_model psm ON psm.profile_id = sp.id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS flagged_count
       FROM (
         SELECT DISTINCT ON (aa.property_id) aa.property_id, aa.result
           FROM ai_assessment aa
           JOIN profile_listing_state pls3
             ON pls3.property_id = aa.property_id AND pls3.profile_id = sp.id AND pls3.matched = true
          WHERE aa.assessment_type = 'occupancy'
          ORDER BY aa.property_id, aa.generated_at DESC NULLS LAST, aa.id DESC
       ) latest_occupancy
       WHERE EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(COALESCE(latest_occupancy.result -> 'caveats', '[]'::jsonb)) AS code
          WHERE code.value = ANY($1::text[])
       )
     ) flag_stats ON true
     LEFT JOIN LATERAL (
       SELECT json_agg(
                json_build_object('property_id', top4.property_id, 'photo_url', lead.photo_url)
                ORDER BY top4.rn
              ) AS thumbnails
       FROM (
         SELECT pls4.property_id,
                ROW_NUMBER() OVER (ORDER BY pls4.score DESC NULLS LAST, pls4.property_id DESC) AS rn
           FROM profile_listing_state pls4
          WHERE pls4.profile_id = sp.id AND pls4.matched = true
          ORDER BY pls4.score DESC NULLS LAST, pls4.property_id DESC
          LIMIT 4
       ) top4
       LEFT JOIN LATERAL (
         SELECT lp.photo_url
           FROM listing l5
           CROSS JOIN LATERAL (
             SELECT uu.photo_url
               FROM unnest(array_remove(l5.photo_urls, NULL)) WITH ORDINALITY AS uu(photo_url, ord)
              LIMIT 1
           ) lp
          WHERE l5.property_id = top4.property_id
            AND l5.status = 'active'
            AND l5.photo_urls IS NOT NULL
            AND array_length(array_remove(l5.photo_urls, NULL), 1) > 0
          ORDER BY l5.source
          LIMIT 1
       ) lead ON true
     ) thumb ON true
     WHERE sp.archived_at IS NULL
     ORDER BY sp.created_at DESC`;

async function fetchOverviewRows(): Promise<RawOverviewRow[]> {
  return sql<RawOverviewRow>(OVERVIEW_QUERY_SQL, [WARN_CAVEAT_CODES]);
}

function toNum(value: string | null): number | null {
  return value !== null ? Number(value) : null;
}

/**
 * Every active profile's overview row (issue #192) — malformed-scope
 * profiles included as `{ok: false, ...}` (issue #113), never dropped. One
 * query total (see fetchOverviewRows); `toProfileListEntry` (lib/db/
 * profiles.ts) is the same ScopeSchema/ThesisParamsSchema validation
 * `listActiveProfiles`/`GET /api/profiles` use, applied here to the raw rows
 * this query already fetched, so there is exactly one source of truth for
 * "is this profile's scope valid".
 */
export async function listProfileOverviews(): Promise<ProfileOverviewEntry[]> {
  const rawRows = await fetchOverviewRows();

  const result: ProfileOverviewEntry[] = [];
  for (const raw of rawRows) {
    const entry = toProfileListEntry(raw);
    if (!entry.ok) {
      result.push(entry);
      continue;
    }
    const metrics: ProfileOverviewMetrics = {
      matched_count: raw.matched_count,
      new_count: raw.new_count,
      accepted_count: raw.accepted_count,
      rejected_count: raw.rejected_count,
      starred_count: raw.starred_count,
      min_price: toNum(raw.min_price),
      median_price: toNum(raw.median_price),
      max_price: toNum(raw.max_price),
      cold_start_count: raw.cold_start_count,
      trained_count: raw.trained_count,
      training_example_count: raw.training_example_count,
      model_trained: (raw.training_example_count ?? 0) >= MIN_TRAINING_EXAMPLES,
      gross_yield_median_pct: toNum(raw.gross_yield_median_pct),
      flagged_count: raw.flagged_count,
      thumbnails: raw.thumbnails ?? [],
    };
    result.push({ ok: true, profile: entry.profile, metrics });
  }
  return result;
}

export { WARN_CAVEAT_CODES };
export type { ProfileListEntry };
