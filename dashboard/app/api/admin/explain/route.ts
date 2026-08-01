/**
 * POST /api/admin/explain — Run EXPLAIN on a user-supplied SQL query.
 *
 * Accepts: { sql: string }
 * Returns: { plan: string }
 *
 * Uses EXPLAIN (FORMAT TEXT) without ANALYZE — the query is never executed,
 * keeping this route read-only per the project policy.
 *
 * Error codes:
 *   400 — Missing/empty sql, sql starts with EXPLAIN, or PG syntax error
 *   403 — Write statement rejected (read-only policy)
 *   408 — Query timeout
 *   500 — Unexpected error
 *   503 — Database connection error
 */

import { NextRequest, NextResponse } from "next/server";
import {
  query,
  validateReadOnly,
  SqlValidationError,
  QueryTimeoutError,
  ConnectionError,
} from "@/lib/db";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  const requestId = generateRequestId();

  let body: unknown;
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
      formatApiError("El cuerpo JSON debe ser un objeto.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const { sql } = body as { sql?: unknown };

  if (!sql || typeof sql !== "string" || !sql.trim()) {
    return NextResponse.json(
      formatApiError("Falta el campo 'sql' o está vacío.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const trimmedSql = sql.trim();

  // Guard: reject write statements before wrapping with EXPLAIN
  try {
    validateReadOnly(trimmedSql);
  } catch (err) {
    if (err instanceof SqlValidationError) {
      return NextResponse.json(
        formatApiError(
          "La consulta contiene operaciones no permitidas (solo se permiten consultas de lectura).",
          "VALIDATION",
          sanitizeErrorMessage(err),
          requestId,
        ),
        { status: 403 },
      );
    }
    throw err;
  }

  // Reject SQL that already starts with EXPLAIN — wrapping it again produces
  // "EXPLAIN (FORMAT TEXT) EXPLAIN ..." which is invalid PostgreSQL syntax.
  if (/^\s*EXPLAIN\b/i.test(trimmedSql)) {
    return NextResponse.json(
      formatApiError(
        "Envía la consulta SQL sin EXPLAIN; este endpoint lo añade automáticamente.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  // EXPLAIN without ANALYZE — planner plan only, query is never executed
  const explainSql = `EXPLAIN (FORMAT TEXT) ${trimmedSql}`;

  try {
    const result = await query(explainSql);
    const plan = result.rows.map((row) => row[0] as string).join("\n");
    return NextResponse.json({ plan });
  } catch (err) {
    if (err instanceof QueryTimeoutError) {
      console.error(`[${requestId}] EXPLAIN timeout:`, err);
      return NextResponse.json(
        formatApiError(
          "La consulta EXPLAIN excedió el tiempo máximo de espera.",
          "TIMEOUT",
          sanitizeErrorMessage(err),
          requestId,
        ),
        { status: 408 },
      );
    }

    if (err instanceof ConnectionError) {
      console.error(`[${requestId}] Error de conexión a la base de datos:`, err);
      return NextResponse.json(
        formatApiError(
          "No se pudo conectar a la base de datos. Inténtalo de nuevo más tarde.",
          "DB_CONNECTION",
          sanitizeErrorMessage(err),
          requestId,
        ),
        { status: 503 },
      );
    }

    const pgErr = err as { code?: string; message?: string };
    const code = pgErr.code || "";
    const isPermissionError = code === "42501";
    const isClientError =
      !isPermissionError && (code.startsWith("22") || code.startsWith("42"));

    if (isClientError) {
      return NextResponse.json(
        formatApiError(
          "Error en la consulta SQL. Verifica la sintaxis.",
          "DB_QUERY",
          sanitizeErrorMessage(err),
          requestId,
        ),
        { status: 400 },
      );
    }

    console.error(`[${requestId}] Error inesperado al ejecutar EXPLAIN:`, err);
    return NextResponse.json(
      formatApiError(
        "Error inesperado al ejecutar EXPLAIN.",
        "UNKNOWN",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
