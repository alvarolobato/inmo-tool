/**
 * GET /api/profiles/[id]/properties/[propertyId] — full detail for one
 * deduplicated property (task 2.8, #44), reached from a profile's candidate
 * list (task 2.5, #19) or map (task 2.7, #43).
 *
 * Error codes:
 *   400 — Invalid profile id or property id
 *   404 — Profile not found/archived, or property is not a matched
 *         candidate for this profile (task 2.4's profile_listing_state)
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { getPropertyDetail, isPropertyMatchedForProfile } from "@/lib/property-detail";
import { getPropertyMarketSignals, getPropertyInvestorScore } from "@/lib/candidates";
import { getProfileById } from "@/lib/db/profiles";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = {
  params: Promise<{ id: string; propertyId: string }> | { id: string; propertyId: string };
};

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
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

    const detail = await getPropertyDetail(propertyId);
    if (!detail) {
      return NextResponse.json(
        formatApiError("Propiedad no encontrada.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }

    // #448 F: profile-scoped price rating + BAJADA/SUBIDA, merged in next to
    // the profile-agnostic detail. Best-effort — a failure here (or a property
    // that isn't a ranked candidate) leaves the signals off the response and
    // the header simply renders no adornments, never an error.
    // #452: the investor score is resolved from the same ranked CTE, in
    // parallel and best-effort — a failure leaves it off the response and the
    // detail page simply renders no "Puntuación inversora" section.
    const [signals, investorScore] = await Promise.all([
      getPropertyMarketSignals(profileId, propertyId).catch(() => null),
      getPropertyInvestorScore(profileId, propertyId).catch(() => null),
    ]);

    return NextResponse.json({
      ...detail,
      ...(signals ?? {}),
      ...(investorScore ? { investor_score: investorScore } : {}),
    });
  } catch (err) {
    console.error(`[${requestId}] Error al cargar el detalle de la propiedad:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el detalle de la propiedad.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
