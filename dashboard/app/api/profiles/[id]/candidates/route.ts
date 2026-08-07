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
 *   caveat      — #386 hard filter: an occupancy caveat code (`venta_deuda` |
 *                 `nuda_propiedad` | `usufructo` | `proindiviso` |
 *                 `derecho_superficie`). Reads AI-assessment data (empty until #316).
 *   redflagType — #386 hard filter: a redflags problem type
 *                 (`unfinished_construction` | `embargo` | `litigio` |
 *                 `construccion_ilegal` | `herencia_yacente` | `deuda_comunidad` |
 *                 `structural_damage`). Reads AI-assessment data.
 *   beachProximity — #392 hard filter (MINIMUM grade): `frontline` (only primera
 *                 línea) | `sea_view` (frontline or sea_view) | `near_beach`
 *                 (any beach signal). Reads the `location` AI-assessment axis.
 *   heritageZone — #392 hard filter: `true` keeps only casco-histórico
 *                 candidates. Reads the `location` axis. Any other value = off.
 *   isVpo       — #398 hard filter (BIDIRECTIONAL): `true` keeps only VPO /
 *                 vivienda protegida candidates; `false` keeps only non-VPO
 *                 candidates; absent/empty = off. Any other value → 400. Reads
 *                 the `opportunity` AI-assessment axis.
 *   minDiscount — #310 hard filter: keep only candidates priced at least this
 *                 PERCENT (0–100) below the pool median price/m². Sent as a
 *                 percent (e.g. `15`); converted to a fraction for the query.
 *   includeRejected — #379: `true` includes candidates whose current verdict
 *                 is `reject` (the show-rejected toggle). Absent/anything else
 *                 keeps them hidden (default).
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
  BEACH_PROXIMITY_FILTERS,
  CAVEAT_FILTERS,
  CONDITION_FILTERS,
  OCCUPANCY_FILTERS,
  REDFLAG_TYPE_FILTERS,
  RENOVATION_FILTERS,
  decodeCursor,
  listCandidates,
  type BeachProximityFilter,
  type CaveatFilter,
  type ConditionFilter,
  type OccupancyFilter,
  type RedflagTypeFilter,
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

  // #386 caveat filter (Fase 1 of #385). Closed-vocabulary token — a value
  // outside CAVEAT_FILTERS is a malformed request (400), not an ignored filter.
  const rawCaveat = searchParams.get("caveat");
  let caveat: CaveatFilter | null = null;
  if (rawCaveat !== null && rawCaveat !== "") {
    if (!(CAVEAT_FILTERS as readonly string[]).includes(rawCaveat)) {
      return NextResponse.json(
        formatApiError("Filtro de gravamen no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    caveat = rawCaveat as CaveatFilter;
  }

  // #386 redflag-type filter. Closed-vocabulary token (REDFLAG_TYPE_FILTERS).
  const rawRedflagType = searchParams.get("redflagType");
  let redflagType: RedflagTypeFilter | null = null;
  if (rawRedflagType !== null && rawRedflagType !== "") {
    if (!(REDFLAG_TYPE_FILTERS as readonly string[]).includes(rawRedflagType)) {
      return NextResponse.json(
        formatApiError("Filtro de alerta no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    redflagType = rawRedflagType as RedflagTypeFilter;
  }

  // #392 beach-proximity filter (Fase 4 of #385). Closed-vocabulary token
  // (frontline / sea_view / near_beach) — a minimum grade, validated here; a
  // value outside BEACH_PROXIMITY_FILTERS is a malformed request (400), never an
  // ignored filter.
  const rawBeachProximity = searchParams.get("beachProximity");
  let beachProximity: BeachProximityFilter | null = null;
  if (rawBeachProximity !== null && rawBeachProximity !== "") {
    if (!(BEACH_PROXIMITY_FILTERS as readonly string[]).includes(rawBeachProximity)) {
      return NextResponse.json(
        formatApiError("Filtro de playa no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    beachProximity = rawBeachProximity as BeachProximityFilter;
  }

  // #392 heritage-zone toggle. Only the exact string "true" turns it on (keep
  // only casco-histórico candidates); absent/anything else leaves it off — a
  // permissive parse here can't silently narrow the feed.
  const heritageZone = searchParams.get("heritageZone") === "true";

  // #398 VPO filter — BIDIRECTIONAL, so it needs a strict tri-state parse
  // (unlike the boolean toggles above): "true" = only VPO, "false" = exclude
  // VPO, absent/empty = off. Any other value is a malformed request (400), never
  // silently ignored — an unvalidated parse could show an unfiltered feed the
  // user didn't ask for.
  const rawIsVpo = searchParams.get("isVpo");
  let isVpo: boolean | null = null;
  if (rawIsVpo !== null && rawIsVpo !== "") {
    if (rawIsVpo !== "true" && rawIsVpo !== "false") {
      return NextResponse.json(
        formatApiError("Filtro de VPO no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    isVpo = rawIsVpo === "true";
  }

  // #379: show-rejected toggle. Absent/anything-but-"true" keeps today's
  // behaviour (rejected candidates hidden). Only the exact string "true"
  // opts in — a permissive parse here can't silently surface rejected cards.
  const includeRejected = searchParams.get("includeRejected") === "true";

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
      caveat,
      redflagType,
      beachProximity,
      heritageZone,
      isVpo,
      includeRejected,
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
