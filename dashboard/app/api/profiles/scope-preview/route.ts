/**
 * POST /api/profiles/scope-preview — count how many properties a DRAFT scope
 * (not yet saved) would match, before the owner commits to it (issue #659).
 *
 * Why this exists: an unfiltered "novedades" profile
 * (`geography:{type:"everywhere"}` / `property_types:"all"`) is meant for a
 * SMALL, deliberately-scoped connector selection (#660) — the small-portal
 * plan is ~1,185 properties / ~$20-35 of one-time LLM backlog. A full-pool
 * everywhere+all profile is a different thing entirely (11.6k properties,
 * $180-320, ~19 days at the assessment scheduler cap — see issue #658's
 * judgement comment) and #663 (the per-profile assessment opt-out) hasn't
 * landed yet to guard against that. This route is the one thing this PR CAN
 * do about that risk without building #660/#663 early: let ProfileForm show
 * the owner a real number for a sentinel-carrying draft BEFORE they save it,
 * so "how big is this" is visible rather than discovered after the fact.
 *
 * Read-only (a single COUNT), reuses buildScopeWhereClause — no new query
 * shape, no write. Never called for a scope with neither sentinel (the
 * existing radius+explicit-types case doesn't need this warning).
 *
 * Error codes:
 *   400 — invalid body / scope fails ScopeSchema
 *   500 — unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ScopeSchema } from "@/lib/profiles-schema";
import { buildScopeWhereClause } from "@/lib/filtering/scope-query";
import { sql } from "@/lib/db-write";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

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

  const scopeRaw = typeof body === "object" && body !== null ? (body as { scope?: unknown }).scope : undefined;
  const parsed = ScopeSchema.safeParse(scopeRaw);
  if (!parsed.success) {
    return NextResponse.json(
      formatApiError(
        "El ámbito (scope) no es válido.",
        "VALIDATION",
        (parsed.error as ZodError).issues.map((i) => i.message).join("; "),
        requestId,
      ),
      { status: 400 },
    );
  }

  try {
    const { whereSql, params } = buildScopeWhereClause(parsed.data);
    const rows = await sql<{ count: number }>(
      `SELECT COUNT(*) AS count FROM property WHERE ${whereSql}`,
      params,
    );
    return NextResponse.json({ count: rows[0]?.count ?? 0 });
  } catch (err) {
    console.error(`[${requestId}] Error al contar candidatos del ámbito:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo calcular la vista previa del ámbito.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
