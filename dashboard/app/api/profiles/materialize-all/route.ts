/**
 * POST /api/profiles/materialize-all — Re-run the hard-filter engine
 * (task 2.4, #18) for every active (non-archived) profile.
 *
 * The "simplest v1" trigger issue #18 names for the after-new-listings-land
 * case: cheap enough at this project's current data volumes to re-run for
 * all profiles rather than target only the ones a specific connector run
 * might have affected. Not yet wired to run automatically after a connector
 * cycle (Phase 1.3's orchestrator is a separate Python process/container) —
 * a manual or future-scheduled call for now; see materialize.ts's docstring.
 *
 * Error codes:
 *   500 — Unexpected error
 */

import { NextResponse } from "next/server";
import { materializeAllProfiles } from "@/lib/filtering/materialize";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

export async function POST(): Promise<NextResponse> {
  const requestId = generateRequestId();
  try {
    const results = await materializeAllProfiles();
    return NextResponse.json({ profiles: results });
  } catch (err) {
    console.error(`[${requestId}] Error al recalcular candidatos de todos los perfiles:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron recalcular los candidatos de los perfiles.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
