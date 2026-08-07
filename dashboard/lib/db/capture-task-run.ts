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
 *
 * `resultCount` (issue #376): the real harvested count for this run, when the
 * flow knows it (the extension-path counterpart to the server connectors'
 * per-scope discovered_count). Persisted to `last_result_count`; passing
 * `null`/`undefined` clears it to NULL so a re-run without a count doesn't
 * carry a stale one forward.
 */
export async function recordTaskRun(
  profileId: number,
  taskId: string,
  resultCount?: number | null,
): Promise<string> {
  const count =
    typeof resultCount === "number" && Number.isFinite(resultCount)
      ? Math.max(0, Math.trunc(resultCount))
      : null;
  const rows = await sql<{ last_run_at: string | Date }>(
    `INSERT INTO capture_task_run (profile_id, task_id, last_run_at, last_result_count)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (profile_id, task_id)
     DO UPDATE SET last_run_at = NOW(), last_result_count = EXCLUDED.last_result_count
     RETURNING last_run_at`,
    [profileId, taskId, count],
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

/**
 * PER-PROFILE × CONNECTOR captured counts (issue #430).
 *
 * `getPortalCaptureActivity` above is portal-GLOBAL: it counts every
 * `extension_capture` row for a portal, regardless of which profile the
 * property matches. The Captura page's per-profile view wants "how many of
 * THIS profile's properties were captured on THIS connector", which needs the
 * property↔profile link that `profile_listing_state(profile_id, property_id,
 * matched)` provides.
 *
 * A successful capture (`extension_capture.status='done'`) carries a
 * `property_id`; joining that to `profile_listing_state` (matched=true) buckets
 * the capture under every profile the property matches. We count DISTINCT
 * `property_id` per (profile_id, connector_name) so a property re-captured
 * several times still counts once ("this profile has that property captured"),
 * matching the "N propiedades capturadas" framing of the UI.
 *
 * SEMANTIC CAVEAT (documented in the UI too): captures are NOT exclusive to one
 * profile. A property that matches profiles A and B counts under BOTH — the
 * correct reading of "this profile has that one captured". So the sum across
 * profiles can exceed the portal-global count.
 *
 * `property_id IS NULL` captures (a 'done' row never resolved to a property)
 * match no `profile_listing_state` row and therefore count for nobody — exactly
 * the required behaviour, guaranteed by the INNER JOIN.
 *
 * Bounded, params bound: the query is scoped to the profile ids AND connector
 * names currently on screen (`= ANY($1)` / `= ANY($2)`), never a full-table
 * scan. Empty inputs short-circuit with no query. Returns a nested map
 * `profileId → { [connectorName]: count }`; a (profile, connector) pair with no
 * captures is simply absent (the caller defaults it to 0).
 */
export async function getProfileConnectorCaptured(
  profileIds: readonly number[],
  connectors: readonly string[],
): Promise<Map<number, Record<string, number>>> {
  const out = new Map<number, Record<string, number>>();
  const ids = Array.from(new Set(profileIds.filter((n) => Number.isFinite(n))));
  const names = Array.from(new Set(connectors.filter((s) => typeof s === "string" && s.length > 0)));
  if (ids.length === 0 || names.length === 0) return out;

  const rows = await sql<{ profile_id: number; connector_name: string; captured: number | string }>(
    `SELECT pls.profile_id,
            ec.connector_name,
            COUNT(DISTINCT ec.property_id) AS captured
       FROM extension_capture ec
       JOIN profile_listing_state pls ON pls.property_id = ec.property_id
      WHERE ec.status = 'done'
        AND ec.property_id IS NOT NULL
        AND ec.connector_name = ANY($2)
        AND pls.matched = true
        AND pls.profile_id = ANY($1)
      GROUP BY pls.profile_id, ec.connector_name`,
    [ids, names],
  );

  for (const r of rows) {
    const n = typeof r.captured === "number" ? r.captured : Number(r.captured);
    const bucket = out.get(r.profile_id) ?? {};
    bucket[r.connector_name] = Number.isFinite(n) ? n : 0;
    out.set(r.profile_id, bucket);
  }
  return out;
}
