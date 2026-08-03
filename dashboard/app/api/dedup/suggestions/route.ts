/**
 * GET /api/dedup/suggestions — the dedup review queue (pending `suggested_merge`
 * rows, joined with both sides' listing + property data for a side-by-side
 * comparison view).
 *
 * `?basis=photo_hash|fuzzy|phone|reference_code|address_coords|cadastral`
 * narrows to one match_basis (the queue's filter chips) — see
 * lib/dedup.ts's `listDedupSuggestions` docstring for why the default order
 * (confidence DESC) already surfaces the high-value photo_hash/reference_code
 * rows ahead of the much larger, much weaker fuzzy tail.
 *
 * `?limit`/`?offset` — simple offset pagination (the queue is expected to be
 * worked through, not deep-linked to a specific page).
 *
 * `cadastral`/`address_coords` never actually appear here in practice (both
 * signals always auto-merge, never `suggest` — see etl/dedup/signals/) but
 * are accepted as valid filter values for forward-compatibility.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDedupSuggestionCounts, listDedupSuggestions, MATCH_BASES, type MatchBasis } from "@/lib/dedup";
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
  const limit = Math.min(parsePositiveInt(searchParams.get("limit"), 30), 100);
  const offset = parsePositiveInt(searchParams.get("offset"), 0);

  try {
    const [items, counts] = await Promise.all([
      listDedupSuggestions({ basis, limit, offset }),
      getDedupSuggestionCounts(),
    ]);
    return NextResponse.json({ items, counts, nextOffset: items.length === limit ? offset + limit : null });
  } catch (err) {
    console.error(`[${requestId}] Error al listar sugerencias de duplicados:`, err);
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
