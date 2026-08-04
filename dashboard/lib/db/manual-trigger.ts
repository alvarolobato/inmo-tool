/**
 * Ad-hoc ETL execution: the `etl_manual_trigger` queue table (issue #244).
 *
 * The dashboard can't run a connector sweep in-process — the orchestrator is
 * Python, in a separate container. It signals a run by inserting a row here;
 * `etl/manual_trigger.py`'s poll loop picks it up, runs `run_all_connectors`
 * (all connectors, or one when `connector_name` is set), and writes the
 * outcome back. This module is the dashboard's read/write side of that table.
 *
 * Same "queue table, not synchronous HTTP" reasoning as the extension-capture
 * path (dashboard/app/api/extension/capture) — see docs/architecture/connectors.md.
 */

import { sql } from "@/lib/db-write";

/** Postgres unique_violation — the single-pending-row partial index tripped. */
export const PG_UNIQUE_VIOLATION = "23505";

export type ManualTriggerStatus = "pending" | "picked_up" | "running" | "done" | "failed";

export interface ManualTriggerRow {
  id: number;
  status: ManualTriggerStatus;
  connector_name: string | null;
  connector_run_id: number | null;
  error_msg: string | null;
  triggered_by: string | null;
  requested_at: string;
  picked_up_at: string | null;
  finished_at: string | null;
}

/**
 * Insert a pending trigger and return its id.
 *
 * `connectorName === null` means a full sweep (every enabled connector),
 * matching the ETL poll loop's NULL convention. Throws the raw pg error on a
 * unique-violation (the single-pending-row index) so the caller can decide
 * whether to report the existing pending run — see `getPendingTrigger`.
 */
export async function createManualTrigger(
  connectorName: string | null,
  triggeredBy = "dashboard",
): Promise<number> {
  const rows = await sql<{ id: number }>(
    `INSERT INTO etl_manual_trigger (status, connector_name, triggered_by)
     VALUES ('pending', $1, $2)
     RETURNING id`,
    [connectorName, triggeredBy],
  );
  return rows[0].id;
}

/** The one currently-pending trigger, if any (there can be at most one). */
export async function getPendingTrigger(): Promise<ManualTriggerRow | null> {
  const rows = await sql<ManualTriggerRow>(
    `SELECT id, status, connector_name, connector_run_id, error_msg, triggered_by,
            requested_at, picked_up_at, finished_at
       FROM etl_manual_trigger
      WHERE status = 'pending'
      ORDER BY requested_at, id
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Status of one trigger by id, or null when it doesn't exist. */
export async function getManualTriggerStatus(id: number): Promise<ManualTriggerRow | null> {
  const rows = await sql<ManualTriggerRow>(
    `SELECT id, status, connector_name, connector_run_id, error_msg, triggered_by,
            requested_at, picked_up_at, finished_at
       FROM etl_manual_trigger
      WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
