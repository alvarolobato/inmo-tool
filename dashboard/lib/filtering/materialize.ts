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

export interface MaterializeResult {
  profileId: number;
  matched: number;
  unmatched: number;
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

  return withTransaction(async (client: PoolClient) => {
    const matchedRows = await client.query<{ id: number }>(
      `SELECT property.id FROM property WHERE ${whereSql}`,
      params,
    );
    const matchedIds = matchedRows.rows.map((r) => r.id);

    let matchedCount = 0;
    if (matchedIds.length > 0) {
      const upsert = await client.query(
        `INSERT INTO profile_listing_state (profile_id, property_id, matched)
         SELECT $1, unnest($2::bigint[]), true
         ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = true
         RETURNING property_id`,
        [profileId, matchedIds],
      );
      matchedCount = upsert.rowCount ?? 0;
    }

    // Flip previously-matched rows that are no longer in the matching set.
    // `<> ALL($2::bigint[])` on an empty array is vacuously true for every
    // row — correct: a profile that now matches zero properties should
    // unmatch everything it previously matched.
    const unmatch = await client.query(
      `UPDATE profile_listing_state
       SET matched = false
       WHERE profile_id = $1 AND matched = true AND property_id <> ALL($2::bigint[])`,
      [profileId, matchedIds],
    );

    return {
      profileId,
      matched: matchedCount,
      unmatched: unmatch.rowCount ?? 0,
    };
  });
}

/**
 * Re-materializes every active (non-archived) profile. The "simplest v1"
 * approach issue #18 names for the after-new-listings-land trigger — cheap
 * enough at this project's current data volumes (issue #18 Technical
 * approach item 4), not yet wired to run automatically on a schedule.
 */
export async function materializeAllProfiles(): Promise<MaterializeResult[]> {
  const profiles = await listActiveProfiles();
  const results: MaterializeResult[] = [];
  for (const profile of profiles) {
    const result = await materializeProfile(profile.id);
    if (result) results.push(result);
  }
  return results;
}

