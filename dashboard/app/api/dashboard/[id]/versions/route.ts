/**
 * GET /api/dashboard/[id]/versions — List saved spec versions (newest first).
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db-write";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** `pg` may return int8 as string without custom parsers — normalize for JSON. */
function toVersionNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return 1;
  return n;
}

function toWidgetCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
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

  try {
    const dash = await sql<{ id: number }>(
      `SELECT id FROM dashboards WHERE id = $1`,
      [id],
    );
    if (dash.length === 0) {
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

    const rows = await sql<{
      id: number;
      version_number: number | string;
      prompt: string | null;
      widget_count: number | string;
      created_at: Date;
    }>(
      `WITH ranked AS (
         SELECT id,
                spec,
                prompt,
                created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY dashboard_id ORDER BY created_at ASC, id ASC
                ) AS version_number
         FROM dashboard_versions
         WHERE dashboard_id = $1
       )
       SELECT id,
              version_number::int AS version_number,
              prompt,
              CASE
                WHEN jsonb_typeof(spec -> 'widgets') = 'array'
                  THEN jsonb_array_length(spec -> 'widgets')
                ELSE 0
              END::int AS widget_count,
              created_at
       FROM ranked
       ORDER BY created_at DESC, id DESC`,
      [id],
    );

    const payload = rows.map((r) => ({
      id: r.id,
      version_number: toVersionNumber(r.version_number),
      prompt: r.prompt,
      widget_count: toWidgetCount(r.widget_count),
      created_at:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : String(r.created_at),
    }));

    return NextResponse.json(payload);
  } catch (err) {
    console.error(`[${requestId}] Error al listar versiones del dashboard ${id}:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el historial de versiones. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
