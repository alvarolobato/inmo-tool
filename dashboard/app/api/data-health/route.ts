/**
 * GET /api/data-health — connector-pipeline freshness for the TopBar pill.
 *
 * Returns per-connector freshness derived from `connector_run_results`
 * (latest successful run per crawl connector) and `extension_capture`
 * (latest successful capture per capture-only portal, issue #586),
 * enabled-state from `connector_config`, over the set of connectors in
 * `connector_registry`. See dashboard/lib/db/freshness.ts for the "fresh"
 * definition and what green now asserts.
 *
 * Historical note (issue #241): this route used to query the PowerShop-era
 * `etl_watermarks` table, which the connector pipeline never writes, so it
 * silently returned an empty result on every request. It now reads the
 * tables the real pipeline actually populates.
 *
 * Always returns 200 — on any DB error it degrades to an UNKNOWN result
 * (`overallUnknown: true`, issue #586), never a silent "nothing due", so the
 * pill can't crash the dashboard chrome AND can't read a DB outage as green.
 * (The `/api/ready` route is the one that surfaces DB failure as a non-200
 * for orchestrators.)
 */

import { NextResponse } from "next/server";
import {
  getConnectorFreshness,
  type ConnectorFreshness,
  type DataHealthResponse,
} from "@/lib/db/freshness";

// Re-export the shape so existing consumers (FreshnessContext) keep a stable
// import path.
export type { ConnectorFreshness, DataHealthResponse };

// Always evaluate per-request — without this, Next.js 14 renders the route
// statically at build time (when Postgres is unreachable) and serves the
// empty fallback forever.
export const dynamic = "force-dynamic";

// Issue #586: a query failure is UNKNOWN, never "nothing due". overallStale/
// overallRefreshing stay false alongside overallUnknown:true — there is
// nothing to assert either way — but a consumer must check overallUnknown
// FIRST, exactly as FreshnessContext.tsx does.
const UNKNOWN_RESPONSE: DataHealthResponse = {
  connectors: [],
  overallStale: false,
  overallRefreshing: false,
  overallUnknown: true,
  stalestConnector: null,
  freshestSuccessAt: null,
};

export async function GET(): Promise<NextResponse> {
  try {
    const health = await getConnectorFreshness();
    return NextResponse.json(health);
  } catch (err) {
    // Any error (tables missing, connection down, etc.) degrades to unknown
    // so the always-mounted TopBar pill never crashes the page AND never
    // renders green off a query it never actually ran.
    console.error("[data-health] error computing connector freshness:", err);
    return NextResponse.json(UNKNOWN_RESPONSE);
  }
}
