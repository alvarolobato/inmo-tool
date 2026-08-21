/**
 * POST /api/profiles/scope-preview — for a DRAFT scope (not yet saved),
 * report how many properties it would match AND how many of those would
 * become newly eligible for AI assessment — before the owner commits to it
 * (issue #659, M1 from the #665 review).
 *
 * Why this exists: an unfiltered "novedades" profile
 * (`geography:{type:"everywhere"}` / `property_types:"all"`) is meant for a
 * SMALL, deliberately-scoped connector selection (#660). A full-pool
 * everywhere+all profile is a different thing entirely, and #663 (the
 * per-profile assessment opt-out) hasn't landed yet to guard against it.
 * This route is the one thing this PR CAN do about that risk without
 * building #660/#663 early: let ProfileForm show the owner real numbers for
 * a sentinel-carrying draft BEFORE they save it.
 *
 * The owner's LLM access is a Claude Max subscription, not a per-token
 * bill (D-102/D-103) — so the number that matters is NOT euros, it's
 * assessment QUEUE TIME: `eligibility.ts`'s `assessmentEligibleClause`
 * gates purely on `profile_listing_state.matched` under an active profile
 * (D-052's scheduler drains whatever is matched+pending), so saving a
 * wide-open profile immediately queues every property it newly matches
 * that isn't already eligible via some other active profile.
 * `newly_eligible_count` is exactly that delta — draft-scope matches, minus
 * whatever is already eligible today — and `projected_days` reuses the
 * SAME backlog-projection arithmetic `/etl/salud`'s LLM panel uses
 * (`projectBacklogSeconds`, `loadSchedulerConfig`), so the two numbers can
 * never drift apart.
 *
 * Read-only, reuses buildScopeWhereClause + the shared eligibility
 * predicates — no new query shape, no write. Never called for a scope with
 * neither sentinel (the existing radius+explicit-types case doesn't need
 * this warning).
 *
 * Error codes:
 *   400 — invalid body / scope fails ScopeSchema
 *   500 — unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ScopeSchema } from "@/lib/profiles-schema";
import { buildScopeWhereClause } from "@/lib/filtering/scope-query";
import {
  DISABLED_SOURCES_CTE,
  assessmentEligibleClause,
  missingCurrentVerdictClause,
  selectionFlowValues,
} from "@/lib/ai-assessment/eligibility";
import { activeSourceClause } from "@/lib/db/source-active";
import { loadSchedulerConfig } from "@/lib/ai-assessment/scheduler";
import { projectBacklogSeconds } from "@/lib/llm-health";
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

    // Stage 2a alone (readable listing from an ACTIVE source) — the same
    // fragment assessmentEligibleClause bundles with stage 1, but here it
    // gates the FILTER independently so "NOT assessmentEligibleClause"
    // below correctly reduces to "not already matched by an existing
    // active profile" (stage 2a is already asserted true in this branch).
    const readableFromActiveSource = `EXISTS (
        SELECT 1 FROM listing l
         WHERE l.property_id = property.id
           AND l.status = 'active'
           AND COALESCE(TRIM(l.description), '') <> ''
           AND ${activeSourceClause("l")}
      )`;

    const { valuesSql, params: flowParams } = selectionFlowValues(params.length + 1);
    const allParams = [...params, ...flowParams];

    const rows = await sql<{ total_count: number; newly_eligible_count: number }>(
      `WITH ${DISABLED_SOURCES_CTE}
       SELECT
         COUNT(*) AS total_count,
         COUNT(*) FILTER (
           WHERE ${readableFromActiveSource}
             AND ${missingCurrentVerdictClause("property", valuesSql)}
             AND NOT (${assessmentEligibleClause("property")})
         ) AS newly_eligible_count
       FROM property
       WHERE ${whereSql}`,
      allParams,
    );

    const totalCount = rows[0]?.total_count ?? 0;
    const newlyEligibleCount = rows[0]?.newly_eligible_count ?? 0;

    const scheduler = loadSchedulerConfig();
    const projectedSeconds = projectBacklogSeconds(
      newlyEligibleCount,
      scheduler.batchSize,
      scheduler.intervalSeconds,
    );
    const projectedDays = projectedSeconds === null ? null : Math.ceil(projectedSeconds / 86400);

    return NextResponse.json({
      count: totalCount,
      newlyEligibleForAssessment: newlyEligibleCount,
      projectedAssessmentDays: projectedDays,
    });
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
