/**
 * Worklist sitemap-seed trigger — the dashboard's write side of the
 * `capture_worklist_seed_trigger` queue table (issue #260).
 *
 * The worklist page can't run a sitemap sweep in-process (it's Python, in a
 * separate container), so "Refrescar sitemap" signals a run by inserting a row
 * here; `etl/worklist_seed.py`'s poll loop picks it up, fetches the portal's
 * public sitemap (discovery-only), and upserts pending worklist rows. Same
 * "queue table, not synchronous HTTP" reasoning — and the same shape — as the
 * ad-hoc connector-run trigger (lib/db/manual-trigger.ts).
 */

import { sql } from "@/lib/db-write";

/** Postgres unique_violation — the single-pending-per-portal partial index tripped. */
export const PG_UNIQUE_VIOLATION = "23505";

export type WorklistSeedStatus = "pending" | "running" | "done" | "failed";

export interface WorklistSeedTriggerRow {
  id: number;
  source_portal: string;
  status: WorklistSeedStatus;
  added_count: number | null;
  error_msg: string | null;
  triggered_by: string | null;
  requested_at: string;
  picked_up_at: string | null;
  finished_at: string | null;
}

/**
 * Insert a pending seed request for one portal and return its id. Throws the
 * raw pg error on a unique-violation (the single-pending-per-portal index) so
 * the route can report the already-queued request instead of failing loudly.
 */
export async function createWorklistSeedTrigger(
  portal: string,
  triggeredBy = "dashboard",
): Promise<number> {
  const rows = await sql<{ id: number }>(
    `INSERT INTO capture_worklist_seed_trigger (source_portal, status, triggered_by)
     VALUES ($1, 'pending', $2)
     RETURNING id`,
    [portal, triggeredBy],
  );
  return rows[0].id;
}

/** The currently-pending seed request for a portal, if any (at most one). */
export async function getPendingWorklistSeedTrigger(
  portal: string,
): Promise<WorklistSeedTriggerRow | null> {
  const rows = await sql<WorklistSeedTriggerRow>(
    `SELECT id, source_portal, status, added_count, error_msg, triggered_by,
            requested_at, picked_up_at, finished_at
       FROM capture_worklist_seed_trigger
      WHERE source_portal = $1 AND status = 'pending'
      ORDER BY requested_at, id
      LIMIT 1`,
    [portal],
  );
  return rows[0] ?? null;
}
