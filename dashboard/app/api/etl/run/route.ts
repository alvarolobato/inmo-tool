/**
 * POST /api/etl/run
 *
 * Disabled (Phase 1 phase-level review, task 1.6/#14 follow-up): this
 * route used to insert into `etl_manual_trigger`, which the source
 * project's ETL (`check_and_consume_trigger` in etl/db/postgres.py)
 * polled to pick up a manual/force-full resync. The new connector
 * orchestrator (etl/orchestrator.py, Phase 1) has no equivalent polling —
 * it only runs on its own schedule (immediately on startup, then hourly)
 * or via `ps connector run <name>`. Before this fix, POST here returned a
 * confident `202 { trigger_id }` and silently never ran anything — worse
 * than a visible error, since an operator had no way to know the click
 * did nothing. Returns 501 until either the orchestrator gains manual-
 * trigger polling, or this route (and the PowerShop-specific
 * ForceResyncDialog UI that calls it — its table checkboxes are literally
 * "Artículos"/"Clientes"/"Ventas", meaningless in this domain) is replaced
 * by whatever Phase 2's dashboard rewrite needs instead.
 */

import { NextResponse } from "next/server";

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "not_implemented",
      detail:
        "Manual ETL trigger is disabled — the connector orchestrator does not " +
        "poll for it yet. Use `ps connector run <name>` instead.",
    },
    { status: 501 },
  );
}
