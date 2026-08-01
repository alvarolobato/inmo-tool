/**
 * GET  /api/dashboards — List all dashboards (id, name, description, updated_at).
 * POST /api/dashboards — Create a new dashboard.
 *
 * Error codes:
 *   400 — Invalid body or spec validation failure
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db-write";
import { validateSpec } from "@/lib/schema";
import { lintDashboardSpec } from "@/lib/sql-heuristics";
import { ZodError } from "zod";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";

// ─── GET: List dashboards ─────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();
  try {
    const rows = await sql(
      `SELECT id, name, description, updated_at
       FROM dashboards
       ORDER BY updated_at DESC`,
    );
    return NextResponse.json(rows);
  } catch (err) {
    console.error(`[${requestId}] Error al listar dashboards:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar los dashboards. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

// ─── POST: Create dashboard ───────────────────────────────────────────────

interface CreateBody {
  name?: string;
  description?: string;
  spec?: unknown;
  /**
   * Optional: request_id from the generate interaction.
   * When provided, the backend will link the interaction to this dashboard by
   * setting `llm_interactions.dashboard_id = <new dashboard id>`.
   */
  generateRequestId?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo JSON no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      formatApiError(
        "El cuerpo JSON debe ser un objeto.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const { name, description, spec, generateRequestId: genReqId } = body;

  // Validate name
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json(
      formatApiError(
        "Falta el campo 'name' o está vacío.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  // Validate description type
  if (description !== undefined && description !== null && typeof description !== "string") {
    return NextResponse.json(
      formatApiError(
        "El campo 'description' debe ser texto.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  // Validate spec
  if (spec === undefined || spec === null) {
    return NextResponse.json(
      formatApiError(
        "Falta el campo 'spec'.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  let validatedSpec: ReturnType<typeof validateSpec>;
  try {
    validatedSpec = validateSpec(spec);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        formatApiError(
          "La especificación del dashboard no es válida.",
          "VALIDATION",
          err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          requestId,
        ),
        { status: 400 },
      );
    }
    throw err;
  }

  const sqlLint = lintDashboardSpec(validatedSpec);
  if (sqlLint.length > 0) {
    return NextResponse.json(
      formatApiError(
        "Las consultas SQL contienen patrones inválidos para PostgreSQL.",
        "SQL_LINT",
        sqlLint.join(" | "),
        requestId,
      ),
      { status: 400 },
    );
  }

  // Insert
  try {
    const rows = await sql(
      `INSERT INTO dashboards (name, description, spec)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, spec, created_at, updated_at`,
      [name.trim(), description?.trim() || null, JSON.stringify(validatedSpec)],
    );
    const newDashboard = rows[0];

    // If a generate request_id was provided, link the interaction to this dashboard.
    if (newDashboard && genReqId && typeof genReqId === "string" && genReqId.trim()) {
      await sql(
        `UPDATE llm_interactions
            SET dashboard_id = $1
          WHERE request_id = $2
            AND endpoint = 'generate'
            AND dashboard_id IS NULL`,
        [newDashboard.id, genReqId.trim()],
      ).catch((e) => {
        console.error(`[${requestId}] Failed to link interaction to dashboard:`, e);
      });
    }

    return NextResponse.json(newDashboard, { status: 201 });
  } catch (err) {
    console.error(`[${requestId}] Error al crear dashboard:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo crear el dashboard. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
