/**
 * GET /api/profiles/[id]/properties/[propertyId]/investment — Phase 5
 * investment metrics for one property under one profile's thesis (issues
 * #151/#32/#33): area price-per-m² comparison, rent estimate, and
 * gross/net yield + cash-on-cash.
 *
 * Its own route rather than folded into the property-detail response —
 * same reasoning as `adjacent/route.ts`: this is a property of *this
 * profile's thesis_params* (financing/rent assumptions), not of the
 * property alone, and a non-blocking fetch lets the core detail page
 * render immediately while this (a heavier, multi-query computation)
 * loads in behind it — same pattern the page.tsx already uses for
 * `adjacent`.
 *
 * Error codes:
 *   400 — Invalid profile id or property id
 *   404 — Profile not found/archived, or property is not a matched
 *         candidate for this profile
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { isPropertyMatchedForProfile } from "@/lib/property-detail";
import { getProfileById } from "@/lib/db/profiles";
import { getInvestmentMetrics } from "@/lib/investment-metrics";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = {
  params: Promise<{ id: string; propertyId: string }> | { id: string; propertyId: string };
};

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId, propertyId: rawPropertyId } = await context.params;
  const profileId = parsePositiveInt(rawId);
  const propertyId = parsePositiveInt(rawPropertyId);

  if (profileId === null || propertyId === null) {
    return NextResponse.json(
      formatApiError("Id de perfil o de propiedad no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const profile = await getProfileById(profileId);
    if (!profile || profile.archived_at !== null) {
      return NextResponse.json(
        formatApiError("Perfil de búsqueda no encontrado o archivado.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }

    const matched = await isPropertyMatchedForProfile(profileId, propertyId);
    if (!matched) {
      return NextResponse.json(
        formatApiError(
          "Esta propiedad no es un candidato de este perfil.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }

    const metrics = await getInvestmentMetrics(propertyId, profile.thesis_params);
    if (!metrics) {
      return NextResponse.json(
        formatApiError("Propiedad no encontrada.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }

    return NextResponse.json(metrics);
  } catch (err) {
    console.error(`[${requestId}] Error al calcular las métricas de inversión:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron calcular las métricas de inversión.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
