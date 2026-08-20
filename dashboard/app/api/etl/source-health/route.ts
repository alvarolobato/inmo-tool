/**
 * GET /api/etl/source-health — the Estado board's data (issue #638).
 *
 * Per-source health derived from the `listing` table (ground truth for
 * Frescura/Volumen) plus `connector_run_results` / `extension_capture` /
 * `extension_heartbeat` (Errores signal only) — see lib/db/source-health.ts
 * for the aggregation and lib/source-health.ts for the pure status
 * derivation. Consumed by `/admin` (the board itself) and
 * `components/FreshnessContext.tsx` (the TopBar dot, repointed at this
 * endpoint's worst-of rollup instead of the old run-cycle-based one).
 *
 * Always returns 200 — on any DB error it degrades to an empty/unknown
 * result (`rollupStatus: null`, no sources) rather than a 500, so neither
 * the always-mounted TopBar pill nor the /admin board can be crashed by a
 * transient query failure. `rollupStatus: null` must be read as UNKNOWN,
 * never "all fresco" (same posture as /api/data-health's overallUnknown).
 */

import { NextResponse } from "next/server";
import { getSourceHealth } from "@/lib/db/source-health";
import type { SourceHealthResponse } from "@/lib/db/source-health";

export type { SourceHealthResponse };

// Always evaluate per-request — a statically-rendered fallback (Postgres
// unreachable at build time) would otherwise serve an empty payload forever.
export const dynamic = "force-dynamic";

const UNKNOWN_RESPONSE: SourceHealthResponse = {
  sources: [],
  rollupStatus: null,
  generatedAt: new Date(0).toISOString(),
};

export async function GET(): Promise<NextResponse> {
  try {
    const health = await getSourceHealth();
    return NextResponse.json(health);
  } catch (err) {
    console.error("[source-health] error computing source health:", err);
    return NextResponse.json(UNKNOWN_RESPONSE);
  }
}
