/**
 * Capture task-run ledger persistence (issue #289) — server-only (imports
 * lib/db-write, the `pg` client). Never import from a client component; use
 * lib/captura-tasks.ts for the client-safe types/helpers instead.
 *
 * Backs the task-driven `/captura` page: one row per (profile_id, task_id)
 * recording when the operator last executed that capture task. The page reads
 * the whole set for a profile on load (to compute the staleness/grey state) and
 * upserts one row each time a task's button is pressed.
 */

import { sql } from "@/lib/db-write";
import { CAPTURE_PORTALS, portalForUrl } from "@/lib/worklist";
import type { PortalCaptureActivity } from "@/lib/captura-tasks";

/** A recorded task run, as read back for a profile. `pg` may hand back a
 * `Date` for a `timestamptz` column, so widen the type and normalise to ISO. */
export interface CaptureTaskRunRow {
  task_id: string;
  last_run_at: string | Date;
}

/**
 * All task-run rows for one profile, as a `{ [task_id]: last_run_at }` map —
 * the exact shape the Captura page indexes by task id. Absent tasks (never
 * run) are simply not keys.
 */
export async function getTaskRuns(profileId: number): Promise<Record<string, string>> {
  const rows = await sql<CaptureTaskRunRow>(
    `SELECT task_id, last_run_at
       FROM capture_task_run
      WHERE profile_id = $1`,
    [profileId],
  );
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.task_id] =
      r.last_run_at instanceof Date
        ? (r.last_run_at as Date).toISOString()
        : String(r.last_run_at);
  }
  return out;
}

/**
 * Record (upsert) that a capture task was just run: sets `last_run_at = NOW()`
 * for (profile_id, task_id). Idempotent per press — re-running the same task
 * simply bumps the timestamp. Returns the stored `last_run_at` (ISO string).
 */
export async function recordTaskRun(profileId: number, taskId: string): Promise<string> {
  const rows = await sql<{ last_run_at: string | Date }>(
    `INSERT INTO capture_task_run (profile_id, task_id, last_run_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (profile_id, task_id)
     DO UPDATE SET last_run_at = NOW()
     RETURNING last_run_at`,
    [profileId, taskId],
  );
  const v = rows[0]?.last_run_at;
  if (v instanceof Date) return (v as Date).toISOString();
  return v ? String(v) : new Date().toISOString();
}

/**
 * REAL per-portal capture activity — what actually landed in the pipeline,
 * from `extension_capture` rows that reached 'done', keyed to a portal by URL
 * host (the SAME host-suffix logic as etl/capture.py / `portalForUrl`).
 *
 * This is the fix for "the page reads empty even though captures are working":
 * captures made by opening detail pages one by one seed NO `capture_worklist`
 * row, so a worklist-only progress shows nothing. `extension_capture` is the
 * ground truth of what was captured, whether via a batch harvest or one by one.
 *
 * Bounded + precise: the SQL prefilters to rows whose URL contains a capture
 * host suffix (so a huge history of unrelated captures isn't dragged in), then
 * `portalForUrl` does the exact host-suffix match in JS. Returns one entry per
 * capture portal (0 / null when it has no captures yet), in CAPTURE_PORTALS
 * order.
 */
export async function getPortalCaptureActivity(): Promise<PortalCaptureActivity[]> {
  // One ILIKE '%<suffix>%' clause per capture portal, parameterised.
  const clauses = CAPTURE_PORTALS.map((_, i) => `url ILIKE $${i + 1}`);
  const params = CAPTURE_PORTALS.map((p) => `%${p.hostSuffix}%`);

  const rows =
    clauses.length === 0
      ? []
      : await sql<{ url: string; created_at: string | Date }>(
          `SELECT url, created_at
             FROM extension_capture
            WHERE status = 'done'
              AND (${clauses.join(" OR ")})`,
          params,
        );

  const acc = new Map<string, { captured: number; last: number }>();
  for (const { portal } of CAPTURE_PORTALS) acc.set(portal, { captured: 0, last: 0 });

  for (const r of rows) {
    const portal = portalForUrl(r.url);
    if (portal === null) continue; // ILIKE matched but not a real host — skip.
    const bucket = acc.get(portal);
    if (!bucket) continue;
    bucket.captured += 1;
    const t = r.created_at instanceof Date ? r.created_at.getTime() : new Date(r.created_at).getTime();
    if (!Number.isNaN(t) && t > bucket.last) bucket.last = t;
  }

  return CAPTURE_PORTALS.map(({ portal }) => {
    const b = acc.get(portal)!;
    return {
      portal,
      captured: b.captured,
      lastCapturedAt: b.last > 0 ? new Date(b.last).toISOString() : null,
    };
  });
}
