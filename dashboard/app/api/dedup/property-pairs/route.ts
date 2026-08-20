/**
 * GET /api/dedup/property-pairs — the dedup review queue, grouped by
 * PROPERTY pair (issue #605 Part 2 — supersedes the old
 * `/api/dedup/suggestions`, which served one row per LISTING pair and let
 * property A × 6 listings vs. property B × 7 listings ask the same
 * question up to 42 times; #600 measured 892 pending rows collapsing to
 * 669 distinct property-pair questions, one property pair alone had 38
 * identical rows).
 *
 * Same query params as the old route:
 * `?basis=photo_hash|fuzzy|phone|reference_code|address_coords|cadastral`
 * narrows to GROUPS containing at least one row of that basis (see
 * lib/dedup.ts's `listDedupPropertyPairSuggestions` docstring for why a
 * matched group's FULL evidence still comes back, not just the matching
 * rows).
 *
 * `?profile=relevant` — the "solo mis perfiles" toggle: hard-filters to
 * groups where at least one evidence row touches an active search profile.
 *
 * `?limit`/`?offset` — simple offset pagination over GROUPS, not rows.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getDedupPropertyPairCounts,
  listDedupPropertyPairSuggestions,
  MATCH_BASES,
  type MatchBasis,
} from "@/lib/dedup";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

function parseBasis(raw: string | null): MatchBasis | undefined {
  if (!raw) return undefined;
  return (MATCH_BASES as readonly string[]).includes(raw) ? (raw as MatchBasis) : undefined;
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { searchParams } = new URL(request.url);
  const basis = parseBasis(searchParams.get("basis"));
  const onlyProfileRelevant = searchParams.get("profile") === "relevant";
  const limit = Math.min(parsePositiveInt(searchParams.get("limit"), 30), 100);
  const offset = parsePositiveInt(searchParams.get("offset"), 0);

  try {
    const [items, counts] = await Promise.all([
      listDedupPropertyPairSuggestions({ basis, onlyProfileRelevant, limit, offset }),
      getDedupPropertyPairCounts(),
    ]);
    return NextResponse.json({ items, counts, nextOffset: items.length === limit ? offset + limit : null });
  } catch (err) {
    console.error(`[${requestId}] Error al listar sugerencias de duplicados agrupadas:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar las sugerencias de duplicados.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
