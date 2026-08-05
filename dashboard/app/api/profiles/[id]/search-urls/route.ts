/**
 * GET /api/profiles/[id]/search-urls — PRE-FILTERED search TASKS for a
 * profile's scope (issue #267; task-list restructure #277).
 *
 * The guided-capture UI calls this to open each searchable section already
 * filtered to the profile (zone/price/type/size). A profile fans out into a
 * flat list of discrete tasks — one openable URL per (portal × section), since
 * both portals search one section at a time. Each task carries a stable `id`, a
 * human `label`, the `url`, and any `loosened` constraints the portal's URL
 * grammar could not express exactly (always broadened, never silently dropped —
 * see lib/search-url).
 *
 * Response 200: { profileId, name, tasks: SearchTask[] }
 * Error codes:
 *   400 — Invalid id
 *   404 — Profile not found
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { getProfileById } from "@/lib/db/profiles";
import { buildSearchUrls } from "@/lib/search-url";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const profile = await getProfileById(id);
    if (!profile) {
      return NextResponse.json(
        formatApiError("Perfil de búsqueda no encontrado.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }

    return NextResponse.json({
      profileId: profile.id,
      name: profile.name,
      tasks: buildSearchUrls(profile.scope),
    });
  } catch (error) {
    return NextResponse.json(
      formatApiError(
        sanitizeErrorMessage(error),
        "UNKNOWN",
        undefined,
        requestId,
      ),
      { status: 500 },
    );
  }
}
