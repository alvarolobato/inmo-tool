/**
 * GET /api/profiles/[id]/properties/[propertyId]/adjacent — the property
 * ranked immediately before/after this one in the profile's candidate
 * ordering (#152), so the detail page can offer prev/next without sending
 * the user back to the list.
 *
 * Kept as its own route rather than folded into the property-detail response:
 * adjacency is a property of *this profile's ranking*, not of the property
 * (`PropertyDetail` is deliberately profile-agnostic — see
 * lib/property-detail.ts), and this way the detail page renders as soon as
 * the property loads instead of waiting on two extra keyset queries.
 *
 * Error codes:
 *   400 — Invalid profile id or property id
 *   404 — Profile not found/archived
 *   500 — Unexpected error
 *
 * A property that isn't a matched candidate is NOT a 404 here: it returns
 * `{ prev: null, next: null }`. The detail route already enforces
 * membership; duplicating that check would only turn "no neighbours" into a
 * spurious error banner on a page that loaded fine.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdjacentCandidates } from "@/lib/candidates";
import { getProfileById } from "@/lib/db/profiles";
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

    const { prevPropertyId, nextPropertyId } = await getAdjacentCandidates(profileId, propertyId);
    return NextResponse.json({ prevPropertyId, nextPropertyId });
  } catch (err) {
    console.error(`[${requestId}] Error al calcular los candidatos adyacentes:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron calcular los candidatos adyacentes.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
