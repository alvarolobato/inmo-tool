/**
 * GET /api/data-health — Query ETL watermarks for data freshness.
 *
 * Returns:
 *   {
 *     tables: { name: string, lastSync: string, isStale: boolean }[],
 *     overallStale: boolean,
 *     stalestTable: { name: string, lastSync: string } | null,
 *   }
 *
 * A table is stale when last_sync_at is more than 36 hours ago.
 * If etl_watermarks does not exist or the query fails, returns empty result (graceful degradation).
 *
 * Error codes:
 *   200 — Always returns 200 (empty result on error for graceful degradation)
 */

import { NextResponse } from "next/server";
import { query, ConnectionError } from "@/lib/db";

// Always evaluate per-request — without this, Next.js 14 renders the route
// statically at build time (when Postgres is unreachable) and serves the empty
// fallback forever.
export const dynamic = "force-dynamic";

const STALE_THRESHOLD_HOURS = 36;

/**
 * Tables that the headline freshness indicator (`stalestTable`,
 * `overallStale`) ignores. The list MUST stay in sync with the
 * full-refresh-only set in etl/main.py's run_full_sync orchestration
 * (the `_s(name, fn)` calls without `wm=True`).
 *
 * Why: the hourly delta cron only runs watermark-backed (delta-capable)
 * syncs. Tables here are full-only by design — either small lookups
 * that almost never change, or transactional tables whose 4D source
 * doesn't expose a usable `FechaModifica` so they can only be
 * truncate-and-reinserted in a full pass. Their freshness is bounded
 * by the nightly cron at 02:00 (or a manual "Forzar resync"), so they
 * spend most of the day at 8–24h "old" by definition.
 *
 * If we let them drive the headline, the TopBar pins itself at "hace
 * Xh" within an hour of every deploy — masking the fact that the
 * delta-capable set (ventas, stock, articulos, …) is minutes-fresh.
 * The `tables` array still includes them; only the headline filters.
 */
const HEADLINE_FRESHNESS_EXCLUDED = new Set<string>([
  // Lookups — refresh on nightly / container restart only
  "catalogos",
  "tiendas",
  "proveedores",
  "gc_comerciales",
  // Wholesale workflow — full-only because rows can be deleted in 4D
  "gc_pedidos",
  "gc_lin_pedidos",
  // Purchasing — full-only because the 4D source has no FechaModifica
  "compras",
  "lineas_compras",
  "albaranes",
  "facturas_compra",
]);

export interface TableFreshness {
  name: string;
  lastSync: string;
  isStale: boolean;
}

export interface DataHealthResponse {
  tables: TableFreshness[];
  overallStale: boolean;
  stalestTable: { name: string; lastSync: string } | null;
}

const EMPTY_RESPONSE: DataHealthResponse = {
  tables: [],
  overallStale: false,
  stalestTable: null,
};

export async function GET(): Promise<NextResponse> {
  try {
    const result = await query(
      "SELECT table_name, last_sync_at, status FROM etl_watermarks ORDER BY last_sync_at ASC"
    );

    if (result.rows.length === 0) {
      return NextResponse.json(EMPTY_RESPONSE);
    }

    const now = new Date();
    const thresholdMs = STALE_THRESHOLD_HOURS * 60 * 60 * 1000;

    const tables: TableFreshness[] = result.rows.map((row) => {
      const name = String(row[0]);
      const lastSyncRaw = row[1];
      const lastSync =
        lastSyncRaw instanceof Date
          ? lastSyncRaw.toISOString()
          : String(lastSyncRaw);
      const lastSyncDate = new Date(lastSync);
      const isStale = now.getTime() - lastSyncDate.getTime() > thresholdMs;
      return { name, lastSync, isStale };
    });

    // Headline indicator (stalestTable + overallStale) reflects transactional
    // freshness only — see HEADLINE_FRESHNESS_EXCLUDED. The full `tables`
    // list is preserved above so the banner can still show every watermark.
    const headlineTables = tables.filter(
      (t) => !HEADLINE_FRESHNESS_EXCLUDED.has(t.name),
    );
    const overallStale = headlineTables.some((t) => t.isStale);

    // stalestTable = first entry of the headline set (already sorted ASC).
    // Falls back to the full set if every transactional table was excluded
    // (defensive — shouldn't happen in practice).
    const stalest = headlineTables[0] ?? tables[0];
    const stalestTable = stalest
      ? { name: stalest.name, lastSync: stalest.lastSync }
      : null;

    const response: DataHealthResponse = {
      tables,
      overallStale,
      stalestTable,
    };

    return NextResponse.json(response);
  } catch (err) {
    // If the table doesn't exist or connection fails, return empty (graceful degradation)
    const pgErr = err as { code?: string };
    const isTableMissing =
      pgErr.code === "42P01" || // undefined_table
      err instanceof ConnectionError;

    if (isTableMissing) {
      return NextResponse.json(EMPTY_RESPONSE);
    }

    // For any other error (e.g. unknown DB error in dev), also degrade gracefully
    // so the banner doesn't crash the dashboard
    console.error("[data-health] Unexpected error querying etl_watermarks:", err);
    return NextResponse.json(EMPTY_RESPONSE);
  }
}
