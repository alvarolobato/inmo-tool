/**
 * Runs a profile's scope filter (lib/filtering/scope-query.ts) against the
 * live `property` pool and materializes the result into
 * `profile_listing_state` (task 2.4, #18).
 *
 * Server-only: imports lib/db-write (the `pg` client) — same reasoning as
 * lib/db/profiles.ts, never import this from a client component.
 *
 * Trigger points (issue #18's "implementer's call, document the choice"):
 *   - Explicit, on demand: POST /api/profiles/[id]/materialize (called from
 *     the client after a create/edit, see ProfileForm.tsx) and
 *     POST /api/profiles/materialize-all (all active profiles at once).
 *   - NOT wired automatically into POST/PATCH /api/profiles — see that
 *     route's tests (task 2.3) which assert exact `mockQuery` call counts;
 *     coupling profile-CRUD success to filter-materialization success (and
 *     to those tests' call-count assumptions) isn't worth it for what a
 *     client-side follow-up call achieves identically from the user's POV.
 *   - NOT wired into the connector orchestrator (task 1.3, Python) after new
 *     listings land — that would mean a Python process calling into this
 *     TypeScript module or hitting this container's HTTP API cross-service.
 *     Deferred as a documented follow-up (candidate: the orchestrator POSTs
 *     `/api/profiles/materialize-all` on the dashboard's exposed port at the
 *     end of each connector-runner cycle) rather than built speculatively
 *     here without a real scheduler task driving it yet.
 */

import { withTransaction } from "@/lib/db-write";
import type { PoolClient } from "pg";
import { buildScopeWhereClause } from "./scope-query";
import { getProfileById, listActiveProfiles } from "@/lib/db/profiles";
import { scoreNewCandidates } from "@/lib/scoring/pipeline";

export interface MaterializeResult {
  profileId: number;
  /** Total properties currently matching this profile's scope (a snapshot, not a delta). */
  matchedCount: number;
  /** Total properties with a preserved-but-unmatched row for this profile (a snapshot, not a delta). */
  unmatchedCount: number;
}

/**
 * Re-evaluates one profile's hard filters against the current `property`
 * pool and updates `profile_listing_state` accordingly:
 *   - a newly-matching property gets a row (matched=true), or an existing
 *     row's matched flag flips back to true — score/pipeline_stage/notes are
 *     never touched here, this task only determines pass/fail (Phase 3 owns
 *     scoring).
 *   - a property that no longer matches has matched flipped to false, never
 *     deleted (a row can carry feedback/notes/pipeline_stage by then, and
 *     deleting would silently destroy that history — see data-model.md).
 * Returns null if the profile doesn't exist or is archived.
 */
export async function materializeProfile(profileId: number): Promise<MaterializeResult | null> {
  const profile = await getProfileById(profileId);
  if (!profile || profile.archived_at !== null) {
    return null;
  }

  const { whereSql, params } = buildScopeWhereClause(profile.scope);

  const result = await withTransaction(async (client: PoolClient) => {
    const matchedRows = await client.query<{ id: number }>(
      `SELECT property.id FROM property WHERE ${whereSql}`,
      params,
    );
    // `property.id` is BIGSERIAL — arrives as a real JS number via the
    // driver-level int8 type parser (db-shared.ts, #155). Task 3.4 (#23)
    // added a real in-memory Number-keyed lookup consumer (scoreNewCandidates)
    // that a silent string/number mismatch defeats entirely — reproduced
    // directly while building that wiring, not hypothetical — which is why
    // this is asserted as `number` here rather than re-coerced ad hoc.
    const matchedIds = matchedRows.rows.map((r) => r.id);

    if (matchedIds.length > 0) {
      await client.query(
        `INSERT INTO profile_listing_state (profile_id, property_id, matched)
         SELECT $1, unnest($2::bigint[]), true
         ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = true`,
        [profileId, matchedIds],
      );
    }

    // Flip previously-matched rows that are no longer in the matching set.
    // `<> ALL($2::bigint[])` on an empty array is vacuously true for every
    // row — correct: a profile that now matches zero properties should
    // unmatch everything it previously matched.
    await client.query(
      `UPDATE profile_listing_state
       SET matched = false
       WHERE profile_id = $1 AND matched = true AND property_id <> ALL($2::bigint[])`,
      [profileId, matchedIds],
    );

    // Both fields are current totals (a snapshot after this run), not
    // this-run deltas — matchedCount from the WHERE-clause result itself
    // (not a driver-reported rowCount, which reflects rows affected by the
    // upsert, a subtly different thing), unmatchedCount from a fresh count
    // so it reflects the true total including rows unmatched by an earlier
    // run, not just the ones this run just flipped (Opus review, PR #57 —
    // the original version mixed a total with a this-run delta in the same
    // response shape under confusingly similar field names).
    const unmatchedTotal = await client.query<{ count: number }>(
      `SELECT COUNT(*) FROM profile_listing_state WHERE profile_id = $1 AND matched = false`,
      [profileId],
    );

    return {
      profileId,
      matchedCount: matchedIds.length,
      unmatchedCount: unmatchedTotal.rows[0].count,
      matchedIds,
    };
  });

  // Task 3.4 (#23): close the "materialized after the last retrain stays
  // score=NULL forever" gap `retrain.ts` documents. Runs after (not inside)
  // the materialize transaction — it's a separate scoring concern with its
  // own advisory lock (see scoreNewCandidates), and scoring never needs to
  // roll back if it fails after a successful materialize; a candidate that
  // matched but isn't scored yet degrades gracefully in the UI (task 3.3),
  // it isn't a correctness problem the way a partially-materialized match
  // set would be. Passing every matched id (not just ones this run flipped
  // from unmatched->matched) is deliberate and safe, not wasteful in any
  // way that matters: scoring is a pure function of a candidate's own data
  // plus the profile's current model/cold-start state, so re-scoring an
  // already-correctly-scored candidate reproduces the same number — this
  // also mops up any pre-existing never-scored rows for the profile, not
  // just ones this specific run just matched.
  //
  // Isolated in its own try/catch (Fable phase-3 review): a scoring failure
  // here previously propagated straight out of materializeProfile, turning
  // an already-committed successful match into a 500 from the single-profile
  // route, and into a misreported "error" outcome from materializeAllProfiles
  // — in both cases contradicting this comment's own "isn't a correctness
  // problem" claim. Mirrors the feedback route's existing log-and-swallow
  // pattern for the equivalent retrainAndRescoreProfile call.
  if (result.matchedIds.length > 0) {
    try {
      await scoreNewCandidates(profileId, result.matchedIds);
    } catch (err) {
      console.error(
        `[materializeProfile] No se pudieron puntuar los candidatos nuevos del perfil ${profileId}:`,
        err,
      );
    }
  }

  return { profileId: result.profileId, matchedCount: result.matchedCount, unmatchedCount: result.unmatchedCount };
}

/** One profile's outcome from {@link materializeAllProfiles} — success or isolated failure. */
export type MaterializeAllOutcome =
  | ({ status: "ok" } & MaterializeResult)
  | { status: "error"; profileId: number; error: string };

/**
 * Re-materializes every active (non-archived) profile. The "simplest v1"
 * approach issue #18 names for the after-new-listings-land trigger — cheap
 * enough at this project's current data volumes (issue #18 Technical
 * approach item 4), not yet wired to run automatically on a schedule.
 *
 * One profile's failure does not abort the batch or hide the others'
 * success: each profile is isolated in its own try/catch, and the caller
 * gets a per-profile status rather than an all-or-nothing 500 that would
 * misrepresent already-committed successful materializations as if nothing
 * had happened (Opus review, PR #57).
 */
export async function materializeAllProfiles(): Promise<MaterializeAllOutcome[]> {
  const profiles = await listActiveProfiles();
  const results: MaterializeAllOutcome[] = [];
  for (const profile of profiles) {
    try {
      const result = await materializeProfile(profile.id);
      if (result) results.push({ status: "ok", ...result });
    } catch (err) {
      results.push({
        status: "error",
        profileId: profile.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

