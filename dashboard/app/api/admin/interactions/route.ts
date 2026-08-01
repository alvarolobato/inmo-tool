/**
 * GET /api/admin/interactions
 *
 * Returns up to 50 of the most recent LLM interactions.
 * Accepts optional query parameters:
 *   - endpoint: "generate" | "modify" | "analyze"
 *   - status:   "running"  | "completed" | "error"
 *   - dashboard_id: number
 *
 * Protected by x-admin-key / Bearer token.
 *
 * 200 — { interactions: InteractionRow[], returned: number }
 * 401 — unauthorized
 */

import { NextRequest, NextResponse } from "next/server";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { sql } from "@/lib/db-write";
import type { InteractionRow } from "@/app/api/dashboard/[id]/interactions/route";
import { formatApiError, generateRequestId } from "@/lib/errors";

const VALID_ENDPOINTS = ["generate", "modify", "analyze"] as const;
const VALID_STATUSES = ["running", "completed", "error"] as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();

  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  const { searchParams } = request.nextUrl;
  const endpoint = searchParams.get("endpoint");
  const status = searchParams.get("status");
  const dashboardIdParam = searchParams.get("dashboard_id");

  // Validate filters using the standard error shape
  if (
    endpoint !== null &&
    !(VALID_ENDPOINTS as readonly string[]).includes(endpoint)
  ) {
    return NextResponse.json(
      formatApiError(
        `El filtro 'endpoint' no es válido. Valores permitidos: ${VALID_ENDPOINTS.join(", ")}.`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }
  if (
    status !== null &&
    !(VALID_STATUSES as readonly string[]).includes(status)
  ) {
    return NextResponse.json(
      formatApiError(
        `El filtro 'status' no es válido. Valores permitidos: ${VALID_STATUSES.join(", ")}.`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  let dashboardId: number | null = null;
  if (dashboardIdParam !== null) {
    const n = Number(dashboardIdParam);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json(
        formatApiError(
          "El filtro 'dashboard_id' debe ser un entero positivo.",
          "VALIDATION",
          undefined,
          requestId,
        ),
        { status: 400 },
      );
    }
    dashboardId = n;
  }

  // Build WHERE clauses
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (endpoint !== null) {
    conditions.push(`endpoint = $${paramIdx++}`);
    params.push(endpoint);
  }
  if (status !== null) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(status);
  }
  if (dashboardId !== null) {
    conditions.push(`dashboard_id = $${paramIdx++}`);
    params.push(dashboardId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let rows: InteractionRow[];
  try {
    rows = await sql<InteractionRow>(
      `SELECT
         id, request_id, endpoint, dashboard_id,
         prompt, final_output, lines,
         llm_provider, llm_driver,
         started_at, finished_at, status
       FROM llm_interactions
       ${where}
       ORDER BY started_at DESC
       LIMIT 50`,
      params,
    );
  } catch (err) {
    console.error("[admin/interactions GET]", err);
    return NextResponse.json(
      { error: "db_error", message: "No se pudieron cargar las interacciones." },
      { status: 500 },
    );
  }

  return NextResponse.json({ interactions: rows, returned: rows.length });
}
