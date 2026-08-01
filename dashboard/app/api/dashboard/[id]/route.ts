/**
 * GET    /api/dashboard/[id] — Load a single dashboard by ID.
 * PUT    /api/dashboard/[id] — Update dashboard spec (saves old spec as version).
 * DELETE /api/dashboard/[id] — Delete dashboard and its versions (cascade).
 *
 * Error codes:
 *   400 — Invalid ID or body
 *   404 — Dashboard not found
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { sql, updateDashboardSpecWithVersion } from "@/lib/db-write";
import { validateSpec } from "@/lib/schema";
import { lintDashboardSpec } from "@/lib/sql-heuristics";
import { ZodError } from "zod";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Parse and validate the ID parameter as a positive integer.
 * Returns the numeric ID or null if invalid.
 */
function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ─── GET: Load dashboard ──────────────────────────────────────────────────

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

  try {
    const rows = await sql(
      `SELECT id, name, description, spec, created_at, updated_at
       FROM dashboards WHERE id = $1`,
      [id],
    );

    if (rows.length === 0) {
      return NextResponse.json(
        formatApiError(
          "Dashboard no encontrado.",
          "NOT_FOUND",
          `No existe ningún dashboard con ID ${id}.`,
          requestId,
        ),
        { status: 404 },
      );
    }

    return NextResponse.json(rows[0]);
  } catch (err) {
    console.error(`[${requestId}] Error al cargar dashboard ${id}:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el dashboard. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

// ─── PUT: Update dashboard ────────────────────────────────────────────────

interface UpdateBody {
  spec?: unknown;
  prompt?: string;
  name?: string;
  skipVersion?: boolean;
}

export async function PUT(
  request: NextRequest,
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

  let body: UpdateBody;
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

  const { spec, prompt, name, skipVersion } = body;

  // Validate name type if provided
  if (name !== undefined && name !== null) {
    if (typeof name !== "string" || name.trim() === "") {
      return NextResponse.json(
        formatApiError(
          "El campo 'name' debe ser texto no vacío.",
          "VALIDATION",
          undefined,
          requestId,
        ),
        { status: 400 },
      );
    }
  }

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

  // Validate prompt type
  if (prompt !== undefined && prompt !== null && typeof prompt !== "string") {
    return NextResponse.json(
      formatApiError(
        "El campo 'prompt' debe ser texto.",
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

  const normalizedPrompt =
    typeof prompt === "string" ? prompt.trim() || null : null;
  const trimmedName = typeof name === "string" ? name.trim() : null;

  // Single versioned writer: snapshot previous spec + update, atomically.
  try {
    const updateResult = await updateDashboardSpecWithVersion(
      id,
      validatedSpec,
      normalizedPrompt,
      { name: trimmedName, skipVersion: skipVersion === true },
    );

    if (updateResult === null) {
      return NextResponse.json(
        formatApiError(
          "Dashboard no encontrado.",
          "NOT_FOUND",
          `No existe ningún dashboard con ID ${id}.`,
          requestId,
        ),
        { status: 404 },
      );
    }

    return NextResponse.json(updateResult);
  } catch (err) {
    console.error(`[${requestId}] Error al actualizar dashboard ${id}:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo actualizar el dashboard. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

// ─── DELETE: Delete dashboard ─────────────────────────────────────────────

export async function DELETE(
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

  try {
    const rows = await sql(
      `DELETE FROM dashboards WHERE id = $1 RETURNING id`,
      [id],
    );

    if (rows.length === 0) {
      return NextResponse.json(
        formatApiError(
          "Dashboard no encontrado.",
          "NOT_FOUND",
          `No existe ningún dashboard con ID ${id}.`,
          requestId,
        ),
        { status: 404 },
      );
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error(`[${requestId}] Error al eliminar dashboard ${id}:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo eliminar el dashboard. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
