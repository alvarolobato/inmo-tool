/**
 * POST /api/anomaly-check — Z-score anomaly detection for KPI values.
 *
 * Accepts: { sql: string }
 *   The sql must return N rows of single-column numeric values.
 *   Row 0 = current period value; rows 1..N-1 = historical values.
 *
 * Returns one of:
 *   { isAnomaly: false }  — insufficient data (<4 historical values), normal
 *                            range, zero stddev, or invalid current value
 *   {
 *     isAnomaly: boolean,
 *     currentValue: number,
 *     mean: number,
 *     stddev: number,
 *     zScore: number,
 *     direction: "high" | "low" | "normal",
 *     explanation: string,  // Spanish
 *   }
 * Note: additional fields (mean, stddev, etc.) may also be present on
 * non-anomaly results when stddev > 0 and data is sufficient.
 *
 * Anomaly threshold: |z-score| > 2.0
 *
 * Error codes:
 *   400 — Missing sql or validation error
 *   403 — Write operation rejected
 *   408 — Query timeout
 *   503 — DB connection error
 *   500 — Unexpected error
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
import { computeAnomaly } from "@/lib/anomaly";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo JSON no válido.", "VALIDATION", undefined, requestId),
      { status: 400 }
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      formatApiError(
        "El cuerpo JSON debe ser un objeto.",
        "VALIDATION",
        undefined,
        requestId
      ),
      { status: 400 }
    );
  }

  const { sql } = body as { sql?: string };

  if (!sql || typeof sql !== "string" || !sql.trim()) {
    return NextResponse.json(
      formatApiError(
        "Falta el campo 'sql' o está vacío.",
        "VALIDATION",
        undefined,
        requestId
      ),
      { status: 400 }
    );
  }

  try {
    validateReadOnly(sql);
  } catch (err) {
    if (err instanceof SqlValidationError) {
      return NextResponse.json(
        formatApiError(
          "La consulta contiene operaciones no permitidas (solo se permiten consultas de lectura).",
          "VALIDATION",
          sanitizeErrorMessage(err),
          requestId
        ),
        { status: 403 }
      );
    }
    throw err;
  }

  try {
    const result = await query(sql);

    if (result.rows.length === 0) {
      return NextResponse.json({ isAnomaly: false });
    }

    // Parse row 0 as the current period value — must be valid numeric.
    // Rows 1..N-1 are historical: nulls/non-numeric are filtered out.
    // We preserve positional alignment so row 0 is always current.
    const currentRaw = result.rows[0][0];
    if (currentRaw === null || currentRaw === undefined) {
      return NextResponse.json({ isAnomaly: false });
    }
    const currentNum = Number(currentRaw);
    if (isNaN(currentNum)) {
      return NextResponse.json({ isAnomaly: false });
    }

    const historical: number[] = [];
    for (const row of result.rows.slice(1)) {
      const raw = row[0];
      if (raw !== null && raw !== undefined) {
        const num = Number(raw);
        if (!isNaN(num)) historical.push(num);
      }
    }

    const values = [currentNum, ...historical];
    const anomaly = computeAnomaly(values);
    return NextResponse.json(anomaly);
  } catch (err) {
    if (err instanceof QueryTimeoutError) {
      console.error(`[${requestId}] Timeout en anomaly-check:`, err);
      return NextResponse.json(
        formatApiError(
          "La consulta excedió el tiempo máximo de espera.",
          "TIMEOUT",
          sanitizeErrorMessage(err),
          requestId
        ),
        { status: 408 }
      );
    }
    if (err instanceof ConnectionError) {
      console.error(`[${requestId}] Error de conexión en anomaly-check:`, err);
      return NextResponse.json(
        formatApiError(
          "No se pudo conectar a la base de datos.",
          "DB_CONNECTION",
          sanitizeErrorMessage(err),
          requestId
        ),
        { status: 503 }
      );
    }

    const pgErr = err as { code?: string };
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
          requestId
        ),
        { status: 400 }
      );
    }

    console.error(`[${requestId}] Error inesperado en anomaly-check:`, err);
    return NextResponse.json(
      formatApiError(
        "Error inesperado al ejecutar la consulta.",
        "UNKNOWN",
        sanitizeErrorMessage(err),
        requestId
      ),
      { status: 500 }
    );
  }
}
