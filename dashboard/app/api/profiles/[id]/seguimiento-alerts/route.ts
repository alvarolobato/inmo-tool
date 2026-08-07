/**
 * GET /api/profiles/[id]/seguimiento-alerts — the in-app "En seguimiento"
 * indicator (issue #428, Feed phase 5). Returns the count of tracked (accept)
 * properties with a sanity-banded price DROP in the recent window
 * (`notifications.seguimiento_recent_days`, default 7). The feed already shows
 * the per-card BAJADA badge (#420); this backs a small count/notice next to the
 * "En seguimiento" toggle so the owner sees at a glance that something he
 * tracks has moved — the in-app half of the owner's "ambos" channel choice.
 *
 * Independent of the hourly watchlist pass's watermark (which advances to zero
 * right after alerting): this is a fixed recent-window count, so it stays
 * visible in the UI while the alert has already been sent.
 *
 * Response: { count: number }
 * Error codes: 400 invalid id · 404 profile not found/archived · 500 unexpected.
 */

import { NextRequest, NextResponse } from "next/server";
import { getProfileById } from "@/lib/db/profiles";
import { countSeguimientoRecentDrops, readPriceChangeBand } from "@/lib/notifications/seguimiento";
import { readPositiveInt } from "@/lib/notifications/config-read";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = parsePositiveInt(rawId);
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const profile = await getProfileById(id);
    if (!profile || profile.archived_at !== null) {
      return NextResponse.json(
        formatApiError("Perfil de búsqueda no encontrado o archivado.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }

    const recentDays = readPositiveInt(
      "notifications.seguimiento_recent_days",
      "NOTIFICATIONS_SEGUIMIENTO_RECENT_DAYS",
      7,
    );
    const since = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString();
    const count = await countSeguimientoRecentDrops(id, since, readPriceChangeBand());
    return NextResponse.json({ count });
  } catch (err) {
    console.error(`[${requestId}] Error al contar alertas de seguimiento:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron obtener las alertas de seguimiento.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
