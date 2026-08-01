/**
 * POST /api/dashboard/filters/options — Distinct values for a global dashboard filter.
 *
 * Body: { dashboardId, filterId, dateRange?, activeFilters? }
 * Returns: { options: { value: string, label: string }[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db-write";
import { validateSpec, type DashboardSpec } from "@/lib/schema";
import { substituteDateParams } from "@/lib/date-params";
import {
  compileGlobalFilterSql,
  type GlobalFilterValues,
} from "@/lib/sql-filters";
import { query } from "@/lib/db";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";
import { validateQueryCost, QueryTooExpensiveError } from "@/lib/query-validator";
import { ZodError, z } from "zod";

/** Values POSTed for cascading options — mirrors `GlobalFilterValues` JSON shape. */
const ActiveFilterEntrySchema = z.union([
  z.string(),
  z.number(),
  z.array(z.string()),
  z.array(z.number()),
]);

const BodySchema = z.object({
  dashboardId: z.number().int().positive(),
  filterId: z.string().min(1),
  dateRange: z
    .object({
      from: z.string().min(1),
      to: z.string().min(1),
    })
    .optional(),
  activeFilters: z.record(z.string(), ActiveFilterEntrySchema).optional(),
});

function parseDashboardId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return null;
}

function parseIsoDateRange(dr: {
  from: string;
  to: string;
}): { from: Date; to: Date } | null {
  const from = new Date(dr.from);
  const to = new Date(dr.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from, to };
}

function normalizeBody(raw: unknown): z.infer<typeof BodySchema> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = parseDashboardId(o.dashboardId);
  if (id === null) return null;
  const merged = { ...o, dashboardId: id };
  const parsed = BodySchema.safeParse(merged);
  return parsed.success ? parsed.data : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  const parsed = normalizeBody(body);
  if (!parsed) {
    return NextResponse.json(
      formatApiError(
        "Cuerpo inválido: se esperaba dashboardId, filterId y opcionalmente dateRange/activeFilters.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  let spec: DashboardSpec;
  try {
    const rows = await sql<{ spec: unknown }>(
      `SELECT spec FROM dashboards WHERE id = $1`,
      [parsed.dashboardId],
    );
    if (rows.length === 0) {
      return NextResponse.json(
        formatApiError("Dashboard no encontrado.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    spec = validateSpec(rows[0].spec);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        formatApiError(
          "El dashboard guardado tiene un spec inválido.",
          "VALIDATION",
          err.message,
          requestId,
        ),
        { status: 400 },
      );
    }
    console.error(`[${requestId}] Error al cargar spec del dashboard:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el dashboard.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }

  const filter = spec.filters?.find((f) => f.id === parsed.filterId);
  if (!filter) {
    return NextResponse.json(
      formatApiError(
        `Filtro desconocido: ${parsed.filterId}`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const active: GlobalFilterValues = { ...(parsed.activeFilters ?? {}) };
  delete active[parsed.filterId];

  let optionsSql = filter.options_sql;
  if (parsed.dateRange) {
    const dr = parseIsoDateRange(parsed.dateRange);
    if (!dr) {
      return NextResponse.json(
        formatApiError(
          "dateRange.from y dateRange.to deben ser fechas ISO válidas.",
          "VALIDATION",
          undefined,
          requestId,
        ),
        { status: 400 },
      );
    }
    optionsSql = substituteDateParams(optionsSql, { curr: dr });
  }

  let compiled;
  try {
    compiled = compileGlobalFilterSql(optionsSql, spec.filters, active, {
      excludeFilterId: parsed.filterId,
    });
  } catch (err) {
    return NextResponse.json(
      formatApiError(
        "No se pudo compilar el SQL de opciones del filtro.",
        "VALIDATION",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 400 },
    );
  }

  const forceHeader = request.headers.get("X-Query-Force") ?? undefined;
  try {
    await validateQueryCost(compiled.sql, {
      forceHeader,
      params: compiled.params,
    });
  } catch (err) {
    if (err instanceof QueryTooExpensiveError) {
      return NextResponse.json(
        { ...formatApiError(err.message, "COST_LIMIT", undefined, requestId), cost: err.cost },
        { status: 422 },
      );
    }
    throw err;
  }

  try {
    const result = await query(compiled.sql, compiled.params);
    const valueIdx = result.columns.findIndex((c) => c === "value");
    const labelIdx = result.columns.findIndex((c) => c === "label");
    if (valueIdx === -1 || labelIdx === -1) {
      return NextResponse.json(
        formatApiError(
          "options_sql debe devolver columnas nombradas value y label.",
          "VALIDATION",
          undefined,
          requestId,
        ),
        { status: 400 },
      );
    }
    const options = result.rows.map((row) => ({
      value: String(row[valueIdx] ?? ""),
      label: String(row[labelIdx] ?? ""),
    }));
    return NextResponse.json({ options });
  } catch (err) {
    console.error(`[${requestId}] Error ejecutando options_sql:`, err);
    return NextResponse.json(
      formatApiError(
        "Error al cargar opciones del filtro.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
