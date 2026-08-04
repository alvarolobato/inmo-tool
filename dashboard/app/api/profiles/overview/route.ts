/**
 * GET /api/profiles/overview — aggregate metrics + thumbnails for every
 * active profile, one call (issue #192). Backs the redesigned Perfiles list
 * page (issue #193) exclusively — additive, does not replace `GET
 * /api/profiles`'s existing plain shape (see lib/db/profile-overview.ts's
 * docstring).
 *
 * Error codes:
 *   500 — Unexpected error (the frontend falls back to the plain
 *         GET /api/profiles list + a per-row "metrics unavailable" note —
 *         see issue #193's partial-failure handling).
 */

import { NextResponse } from "next/server";
import { listProfileOverviews } from "@/lib/db/profile-overview";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

// Queries Postgres per request; never prerender at build (no DB then).
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();
  try {
    const overviews = await listProfileOverviews();
    return NextResponse.json(overviews);
  } catch (err) {
    console.error(`[${requestId}] Error al cargar el resumen de perfiles:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el resumen de perfiles. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
