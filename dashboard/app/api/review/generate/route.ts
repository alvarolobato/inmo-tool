/**
 * POST /api/review/generate — Generate or regenerate a weekly business review (v2).
 *
 * Body (JSON, optional):
 *   week_start?: "YYYY-MM-DD" (default: last completed ISO week)
 *   regenerate?: boolean (default false)
 *   mode?: "refresh_data" | "alternate_angle" (required when regenerate=true)
 *   stream?: boolean (default true — set false for non-streaming JSON response)
 *
 * Streaming response (stream=true): application/x-ndjson
 *   { type: "meta", requestId, message, weekStart, generationMode }
 *   { type: "phase", message: "Ejecutando consultas SQL" }
 *   { type: "phase", message: "X/N consultas listas", index, total }
 *   { type: "phase", message: "Construyendo prompt" }
 *   { type: "phase", message: "Llamando al modelo" }
 *   { type: "progress", event: AgenticProgressEvent }  — from LLM streaming
 *   { type: "phase", message: "Validando JSON" }
 *   { type: "phase", message: "Guardando revisión" }
 *   { type: "result", review }
 *   { type: "error", httpStatus, error, code, ... }
 *
 * Non-streaming response (stream=false): JSON (same shape as before).
 */

import { NextRequest, NextResponse } from "next/server";
import { query, ConnectionError, QueryTimeoutError } from "@/lib/db";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
  type ErrorCode,
} from "@/lib/errors";
import { executeReviewQueries, formatAllResults, type ReviewQueryResult } from "@/lib/review-queries";
import { generateReview, generateReviewWithProgress, BudgetExceededError, AgenticRunnerError } from "@/lib/llm";
import type { AgenticProgressEvent } from "@/lib/llm";
import { buildAgenticErrorDiagnostic, persistAgenticError } from "@/lib/llm-tools/diagnostic";
import { loadDashboardLlmConfig } from "@/lib/llm-provider/config";
import {
  formatCliRunnerError,
  isCliRunnerError,
} from "@/lib/llm-client";
import {
  getLatestReviewIdForWeek,
  getMaxRevisionForWeek,
  saveReview,
} from "@/lib/review-db";
import { replaceActionsFromReviewContent } from "@/lib/review-actions-db";
import { sql } from "@/lib/db-write";
import { addDaysIso } from "@/lib/review-dashboard-links";
import { getOrCreateReviewDashboardId } from "@/lib/review-dashboard-seed";
import { buildDashboardReviewHref } from "@/lib/review-dashboard-links";
import { enrichReviewContent, computeQueryFailureRate } from "@/lib/review-evidence";
import type { ReviewContent } from "@/lib/review-schema";
import { REVIEW_DASHBOARD_KEYS } from "@/lib/review-schema";

export const maxDuration = 90;

interface GenerateBody {
  week_start?: string;
  regenerate?: boolean;
  mode?: "refresh_data" | "alternate_angle";
  stream?: boolean;
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Core review generation logic shared by streaming and non-streaming paths.
 * Returns the saved review or throws.
 */
async function generateAndSaveReview(params: {
  weekStartStr: string;
  weekEndExclusiveStr: string;
  weekEndSundayStr: string;
  generationMode: "initial" | "refresh_data" | "alternate_angle";
  regenerate: boolean;
  latestId: number | null;
  requestId: string;
  onPhase?: (message: string, extra?: Record<string, unknown>) => void;
  onProgress?: (event: AgenticProgressEvent) => void;
}): Promise<{
  reviewId: number;
  content: ReviewContent;
  nextRevision: number;
  /** Freeform Spanish chat message from the model (new). Empty string when using legacy path. */
  message: string;
}> {
  const {
    weekStartStr,
    weekEndExclusiveStr,
    weekEndSundayStr,
    generationMode,
    regenerate,
    latestId,
    requestId,
    onPhase,
    onProgress,
  } = params;
  const helperStartedMs = Date.now();

  onPhase?.("Ejecutando consultas SQL");

  const queryResults: ReviewQueryResult[] = await executeReviewQueries(
    (sqlStr, sqlParams) => query(sqlStr, sqlParams),
    weekStartStr,
    weekEndExclusiveStr,
  );

  onPhase?.(`${queryResults.length}/${queryResults.length} consultas listas`, {
    index: queryResults.length,
    total: queryResults.length,
  });

  const failureRate = computeQueryFailureRate(queryResults);
  const failedNames = queryResults.filter((r) => r.error || !r.result).map((r) => r.query.name);

  const formattedResults = formatAllResults(queryResults);

  onPhase?.("Construyendo prompt");

  const reviewedWeekDescription =
    `Los resultados corresponden a la **semana ISO cerrada** del **${weekStartStr}** (lunes) al **${weekEndSundayStr}** (domingo). ` +
    `La semana en curso no se incluye (sigue en progreso).`;

  const reviewVars = {
    queryResults: formattedResults,
    reviewedWeekDescription,
    generationMode,
  };

  onPhase?.("Llamando al modelo");

  // generateReviewWithProgress and generateReview now return { content, message }.
  // In the agentic path, `content` comes from ctx.reviewResult (staged by submit_weekly_review)
  // and `message` is the model's freeform chat reply. In the legacy path, message is "".
  let llmResult: { content: import("@/lib/review-schema").ReviewLlmOutput; message: string };
  if (onProgress) {
    llmResult = await generateReviewWithProgress(reviewVars, { requestId, onAgenticProgress: onProgress });
  } else {
    llmResult = await generateReview(reviewVars, { requestId });
  }

  onPhase?.("Validando JSON");

  const llmOut = llmResult.content;
  const reviewMessage = llmResult.message;

  const generatedAt = llmOut.generated_at || new Date().toISOString();

  let content: ReviewContent = {
    review_schema_version: 2,
    executive_summary: llmOut.executive_summary,
    sections: llmOut.sections.map((s) => ({ ...s })),
    action_items: llmOut.action_items.map((a) => ({
      ...a,
      owner_name: "",
    })),
    data_quality_notes: [...llmOut.data_quality_notes],
    generated_at: generatedAt,
    quality_status: failureRate > 0.3 ? "degraded" : "ok",
  };

  if (failureRate > 0.3) {
    content.data_quality_notes.push(
      `Calidad degradada: ${Math.round(failureRate * 100)}% de consultas fallaron o sin resultado (${failedNames.join(", ") || "n/a"}).`,
    );
  }

  onPhase?.("Enriqueciendo revisión");

  const dashboardUrls: Record<string, string> = {};
  for (const key of REVIEW_DASHBOARD_KEYS) {
    const dashId = await getOrCreateReviewDashboardId(key);
    dashboardUrls[key] = buildDashboardReviewHref(dashId, weekStartStr, weekEndSundayStr);
  }

  content = enrichReviewContent(content, queryResults, dashboardUrls);

  onPhase?.("Guardando revisión");

  const nextRevision = (await getMaxRevisionForWeek(weekStartStr)) + 1;
  const supersedes = regenerate ? latestId : null;

  console.info(
    JSON.stringify({
      event: "review_generate",
      requestId,
      week_start: weekStartStr,
      revision: nextRevision,
      mode: generationMode,
      regenerate,
      query_failures: failedNames.length,
      query_total: queryResults.length,
      duration_ms: Date.now() - helperStartedMs,
    }),
  );

  let reviewId: number | null = null;
  try {
    reviewId = await saveReview({
      weekStart: weekStartStr,
      windowStart: weekStartStr,
      windowEnd: weekEndSundayStr,
      revision: nextRevision,
      generationMode,
      supersedesReviewId: supersedes,
      content,
    });
    await replaceActionsFromReviewContent(reviewId, content);
  } catch (err) {
    if (reviewId != null) {
      try {
        await sql(`DELETE FROM weekly_reviews WHERE id = $1`, [reviewId]);
      } catch (cleanupErr) {
        console.error(`[${requestId}] Failed to delete orphan weekly_reviews row:`, cleanupErr);
      }
    }
    throw Object.assign(
      new Error("La revisión se generó, pero no se pudo guardar."),
      { cause: err, code: "REVIEW_PERSISTENCE" },
    );
  }

  return { reviewId: reviewId!, content, nextRevision, message: reviewMessage };
}

export async function POST(request: NextRequest): Promise<NextResponse | Response> {
  const requestId = generateRequestId();
  const started = Date.now();

  let body: GenerateBody = {};
  try {
    body = (await request.json()) as GenerateBody;
  } catch {
    body = {};
  }

  const regenerate = Boolean(body.regenerate);
  const mode = body.mode;
  if (regenerate && (mode !== "refresh_data" && mode !== "alternate_angle")) {
    return NextResponse.json(
      formatApiError(
        "Si regenerate=true, mode debe ser refresh_data o alternate_angle.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  // stream defaults to true when unspecified (callers can pass stream:false for legacy behaviour).
  const wantStream = body.stream !== false;

  try {
    let weekStartStr: string;
    if (body.week_start) {
      if (!isIsoDate(body.week_start)) {
        return NextResponse.json(
          formatApiError("week_start debe ser YYYY-MM-DD.", "VALIDATION", undefined, requestId),
          { status: 400 },
        );
      }
      weekStartStr = body.week_start;
    } else {
      const boundsRes = await query(
        `SELECT TO_CHAR((DATE_TRUNC('week', CURRENT_DATE::timestamp) - INTERVAL '7 days')::date, 'YYYY-MM-DD') AS week_start`,
      );
      weekStartStr = String(boundsRes.rows[0]?.[0] ?? "");
      if (!weekStartStr) {
        return NextResponse.json(
          formatApiError("No se pudo calcular la semana de análisis.", "UNKNOWN", undefined, requestId),
          { status: 500 },
        );
      }
    }

    const weekEndSundayStr = addDaysIso(weekStartStr, 6);
    const weekEndExclusiveStr = addDaysIso(weekStartStr, 7);

    const latestId = await getLatestReviewIdForWeek(weekStartStr);

    if (!regenerate && latestId != null) {
      return NextResponse.json(
        {
          ...formatApiError(
            "Ya existe una revisión para esa semana. Use regenerate=true para crear una nueva versión.",
            "REVIEW_EXISTS",
            undefined,
            requestId,
          ),
          existing_id: latestId,
          week_start: weekStartStr,
        },
        { status: 409 },
      );
    }

    if (regenerate && latestId == null) {
      return NextResponse.json(
        formatApiError(
          "No existe ninguna revisión previa para esa semana; no se puede regenerar.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }

    const generationMode: "initial" | "refresh_data" | "alternate_angle" = regenerate
      ? (mode as "refresh_data" | "alternate_angle")
      : "initial";

    if (wantStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (obj: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
          };

          send({
            type: "meta",
            requestId,
            message: "Generación de revisión iniciada",
            weekStart: weekStartStr,
            generationMode,
          });

          const onPhase = (message: string, extra?: Record<string, unknown>) => {
            send({ type: "phase", requestId, message, ...extra });
          };

          const onProgress = (event: AgenticProgressEvent) => {
            send({ type: "progress", requestId, event });
          };

          try {
            const { reviewId, content, nextRevision, message } = await generateAndSaveReview({
              weekStartStr,
              weekEndExclusiveStr,
              weekEndSundayStr,
              generationMode,
              regenerate,
              latestId,
              requestId,
              onPhase,
              onProgress,
            });

            send({
              type: "result",
              requestId,
              message,
              review: {
                ...content,
                id: reviewId,
                week_start: weekStartStr,
                revision: nextRevision,
                generation_mode: generationMode,
              },
            });
          } catch (err) {
            let httpStatus = 500;
            let errCode: ErrorCode = "UNKNOWN";
            let errMessage = "Error inesperado al generar la revisión.";
            let diagnostic: import("@/lib/errors").AgenticErrorDiagnostic | undefined;

            if (err instanceof AgenticRunnerError) {
              const cfg = loadDashboardLlmConfig();
              const diag = buildAgenticErrorDiagnostic(err, cfg);
              persistAgenticError("review", err, diag);
              httpStatus = 500;
              errCode = "AGENTIC_RUNNER";
              errMessage = "El flujo de IA alcanzó un límite o no pudo completarse. Inténtalo de nuevo.";
              diagnostic = diag;
            } else if (err instanceof BudgetExceededError) {
              httpStatus = 429;
              errCode = "LLM_BUDGET_EXCEEDED";
              errMessage = err.message;
            } else if (isCliRunnerError(err)) {
              const formatted = formatCliRunnerError(
                err,
                "Error al generar la revisión con el modelo de IA.",
              );
              httpStatus = 502;
              errCode = "LLM_ERROR";
              errMessage = formatted.error;
            } else if (err instanceof ConnectionError) {
              httpStatus = 503;
              errCode = "DB_CONNECTION";
              errMessage = "No se pudo conectar a la base de datos.";
            } else if (err instanceof QueryTimeoutError) {
              httpStatus = 503;
              errCode = "TIMEOUT";
              errMessage = "Las consultas tardaron demasiado.";
            } else if (err instanceof Error && (err as NodeJS.ErrnoException & { code?: string }).code === "REVIEW_PERSISTENCE") {
              httpStatus = 503;
              errCode = "REVIEW_PERSISTENCE";
              errMessage = "La revisión se generó, pero no se pudo guardar.";
            } else {
              console.error(`[${requestId}] Unexpected error in streaming review generation:`, err);
              errMessage = "Error inesperado al generar la revisión.";
            }

            const errPayload = formatApiError(errMessage, errCode, sanitizeErrorMessage(err), requestId, diagnostic);
            send({
              type: "error",
              httpStatus,
              ...errPayload,
            });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Request-Id": requestId,
        },
      });
    }

    // Non-streaming path (stream:false): legacy JSON response.
    try {
      const { reviewId, content, nextRevision, message } = await generateAndSaveReview({
        weekStartStr,
        weekEndExclusiveStr,
        weekEndSundayStr,
        generationMode,
        regenerate,
        latestId,
        requestId,
      });

      const durationMs = Date.now() - started;
      console.info(
        JSON.stringify({
          event: "review_generate_non_stream",
          requestId,
          week_start: weekStartStr,
          revision: nextRevision,
          mode: generationMode,
          duration_ms: durationMs,
        }),
      );

      return NextResponse.json(
        {
          message,
          review: {
            ...content,
            id: reviewId,
            week_start: weekStartStr,
            revision: nextRevision,
            generation_mode: generationMode,
          },
        },
        { status: 200 },
      );
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return NextResponse.json(
          formatApiError(err.message, "LLM_BUDGET_EXCEEDED", undefined, requestId),
          { status: 429 },
        );
      }
      if (isCliRunnerError(err)) {
        const formatted = formatCliRunnerError(
          err,
          "Error al generar la revisión con el modelo de IA. Inténtalo de nuevo.",
        );
        return NextResponse.json(
          formatApiError(formatted.error, "LLM_ERROR", formatted.details, requestId),
          { status: 502 },
        );
      }
      if (err instanceof Error && (err as NodeJS.ErrnoException & { code?: string }).code === "REVIEW_PERSISTENCE") {
        return NextResponse.json(
          formatApiError(
            "La revisión se generó, pero no se pudo guardar. Inténtalo de nuevo más tarde.",
            "REVIEW_PERSISTENCE",
            sanitizeErrorMessage(err),
            requestId,
          ),
          { status: 503 },
        );
      }
      console.error(`[${requestId}] Error in non-stream review generation:`, err);
      return NextResponse.json(
        formatApiError(
          "Error al generar la revisión.",
          "LLM_ERROR",
          sanitizeErrorMessage(err),
          requestId,
        ),
        { status: 500 },
      );
    }
  } catch (err) {
    if (err instanceof ConnectionError) {
      console.error(`[${requestId}] DB connection error:`, err);
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
    if (err instanceof QueryTimeoutError) {
      console.error(`[${requestId}] Query timeout:`, err);
      return NextResponse.json(
        formatApiError(
          "Las consultas tardaron demasiado. Inténtalo de nuevo.",
          "TIMEOUT",
          sanitizeErrorMessage(err),
          requestId,
        ),
        { status: 503 },
      );
    }

    console.error(`[${requestId}] Unexpected error in review generation:`, err);
    return NextResponse.json(
      formatApiError(
        "Error inesperado al generar la revisión.",
        "UNKNOWN",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
