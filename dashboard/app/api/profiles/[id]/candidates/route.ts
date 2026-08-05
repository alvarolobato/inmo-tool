/**
 * GET /api/profiles/[id]/candidates — Materialized candidate feed for a
 * profile (task 2.5, #19), one item per deduplicated `property_id` with
 * `profile_listing_state.matched = true` (task 2.4, #18).
 *
 * Query params:
 *   cursor — property_id to page after (keyset pagination, see lib/candidates.ts)
 *   limit  — page size, default 30, max 100
 *   source — portal filter (#265): narrow to candidates with an active sale
 *            listing from this source. Combines with cursor/limit. Omitted =
 *            all sources. Options come from GET .../candidate-sources.
 *   occupancy   — #310 hard filter: `occupied` | `free`.
 *   condition   — #310 hard filter: `a_reformar` | `reformado` | `obra_nueva`.
 *   renovation  — #310 hard filter (#313): `leve` | `integral` (a_reformar depth).
 *   minDiscount — #310 hard filter: keep only candidates priced at least this
 *                 PERCENT (0–100) below the pool median price/m². Sent as a
 *                 percent (e.g. `15`); converted to a fraction for the query.
 *   All #310 filters combine with each other, with `source`, and with
 *   cursor/limit. The occupancy/condition/renovation filters read AI-assessment
 *   data (empty until #316) and correctly return an empty feed until it flows;
 *   minDiscount is computed from price and works today.
 *
 * Error codes:
 *   400 — Invalid id, cursor, limit, source, or #310 filter value
 *   404 — Profile not found or archived
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import {
  CONDITION_FILTERS,
  OCCUPANCY_FILTERS,
  RENOVATION_FILTERS,
  decodeCursor,
  listCandidates,
  type ConditionFilter,
  type OccupancyFilter,
  type RenovationFilter,
} from "@/lib/candidates";
import { getProfileById } from "@/lib/db/profiles";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = parsePositiveInt(rawId);
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const { searchParams } = new URL(request.url);
  const rawCursor = searchParams.get("cursor");
  const rawLimit = searchParams.get("limit");
  const rawSource = searchParams.get("source");

  // Source (portal) filter (#265). Bounded token — source values are
  // connector slugs (lowercase letters/digits/underscore, e.g.
  // `milanuncios_rental`), so anything outside that shape is a malformed
  // request, not a source that simply matched nothing. An empty string means
  // "no filter" (the client sends none, but tolerate it) and passes through
  // as null; the query narrows nothing.
  let source: string | null = null;
  if (rawSource !== null && rawSource !== "") {
    if (!/^[a-z0-9_]{1,40}$/.test(rawSource)) {
      return NextResponse.json(
        formatApiError("Fuente (portal) no válida.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    source = rawSource;
  }

  // #310 hard filters. Each is an optional closed-vocabulary token or a bounded
  // percent; a value outside the vocabulary is a malformed request (400), never
  // silently ignored (which would show an unfiltered feed the user didn't ask
  // for). Absent/empty = filter off.
  const rawOccupancy = searchParams.get("occupancy");
  let occupancy: OccupancyFilter | null = null;
  if (rawOccupancy !== null && rawOccupancy !== "") {
    if (!(OCCUPANCY_FILTERS as readonly string[]).includes(rawOccupancy)) {
      return NextResponse.json(
        formatApiError("Filtro de ocupación no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    occupancy = rawOccupancy as OccupancyFilter;
  }

  const rawCondition = searchParams.get("condition");
  let condition: ConditionFilter | null = null;
  if (rawCondition !== null && rawCondition !== "") {
    if (!(CONDITION_FILTERS as readonly string[]).includes(rawCondition)) {
      return NextResponse.json(
        formatApiError("Filtro de estado no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    condition = rawCondition as ConditionFilter;
  }

  const rawRenovation = searchParams.get("renovation");
  let renovation: RenovationFilter | null = null;
  if (rawRenovation !== null && rawRenovation !== "") {
    if (!(RENOVATION_FILTERS as readonly string[]).includes(rawRenovation)) {
      return NextResponse.json(
        formatApiError("Filtro de reforma no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    renovation = rawRenovation as RenovationFilter;
  }

  // minDiscount arrives as a PERCENT (0–100); the query wants a fraction.
  let minBelowMarketPct: number | null = null;
  const rawMinDiscount = searchParams.get("minDiscount");
  if (rawMinDiscount !== null && rawMinDiscount !== "") {
    const pct = Number(rawMinDiscount);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return NextResponse.json(
        formatApiError(
          "Descuento mínimo no válido (0–100).",
          "VALIDATION",
          undefined,
          requestId,
        ),
        { status: 400 },
      );
    }
    minBelowMarketPct = pct / 100;
  }

  // Cursor is an opaque string (encodes a compound score+id keyset key, see
  // lib/candidates.ts) — validate it decodes, but don't parse it ourselves.
  let cursor: string | null = null;
  if (rawCursor !== null) {
    if (decodeCursor(rawCursor) === null) {
      return NextResponse.json(
        formatApiError("Cursor no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    cursor = rawCursor;
  }

  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = parsePositiveInt(rawLimit);
    if (parsed === null) {
      return NextResponse.json(
        formatApiError("Límite de página no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    limit = parsed;
  }

  try {
    const profile = await getProfileById(id);
    if (!profile || profile.archived_at !== null) {
      return NextResponse.json(
        formatApiError(
          "Perfil de búsqueda no encontrado o archivado.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }

    const page = await listCandidates(id, {
      cursor,
      limit,
      source,
      occupancy,
      condition,
      renovation,
      minBelowMarketPct,
    });
    return NextResponse.json(page);
  } catch (err) {
    console.error(`[${requestId}] Error al listar candidatos del perfil:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron listar los candidatos del perfil.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
