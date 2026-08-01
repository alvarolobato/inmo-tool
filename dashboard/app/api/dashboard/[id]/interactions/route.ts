/**
 * GET /api/dashboard/[id]/interactions
 *
 * Returns the 20 most recent LLM interactions for a given dashboard,
 * ordered by started_at DESC.
 * Each row includes request_id, endpoint, prompt, final_output, lines, status,
 * llm_provider, llm_driver, started_at, finished_at.
 *
 * The `lines` field is a JSONB array of InteractionLine objects.
 *
 * 200 — { interactions: InteractionRow[], has_more: boolean }
 * 400 — invalid id
 * 500 — unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db-write";
import { formatApiError, generateRequestId } from "@/lib/errors";
import type { InteractionLine } from "@/lib/db-write";

type RouteContext = { params: Promise<{ id: string }> };

export interface InteractionRow {
  id: string;
  request_id: string;
  endpoint: "generate" | "modify" | "analyze";
  dashboard_id: number | null;
  prompt: string;
  final_output: string | null;
  lines: InteractionLine[];
  llm_provider: string | null;
  llm_driver: string | null;
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "error";
}

function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
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
      formatApiError(
        "El identificador del dashboard no es válido (debe ser un entero positivo).",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const LIMIT = 20;
  try {
    const rows = await sql<InteractionRow>(
      `SELECT
         id, request_id, endpoint, dashboard_id,
         prompt, final_output, lines,
         llm_provider, llm_driver,
         started_at, finished_at, status
       FROM llm_interactions
       WHERE dashboard_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [id, LIMIT + 1],
    );
    const has_more = rows.length > LIMIT;
    return NextResponse.json({ interactions: rows.slice(0, LIMIT), has_more });
  } catch (err) {
    console.error(`[${requestId}] GET /api/dashboard/${id}/interactions failed:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar las interacciones del panel.",
        "DB_QUERY",
        undefined,
        requestId,
      ),
      { status: 500 },
    );
  }
}
