/**
 * POST /api/dashboard/gaps
 *
 * Returns LLM-generated coverage gap analysis for the existing set of dashboards.
 *
 * Request body:
 *   {
 *     existingDashboards: {
 *       title: string,
 *       description: string,
 *       widgetTitles: string[]
 *     }[]
 *   }
 *
 * Success response (200):
 *   { gaps: { area: string, description: string, suggestedPrompt: string }[] }
 *
 * Error responses:
 *   400 (VALIDATION: missing/invalid fields)
 *   400 (LLM_INVALID_RESPONSE: LLM returned invalid JSON or a non-array value)
 *   429 (LLM_RATE_LIMIT)
 *   500 (LLM_ERROR)
 */

import { NextResponse } from "next/server";
import { analyzeGaps, BudgetExceededError } from "@/lib/llm";
import { extractJson } from "@/lib/llm-json";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = generateRequestId();

  // --- Parse request body ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo JSON no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  // --- Validate input ---
  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      formatApiError(
        "El cuerpo de la petición debe ser un objeto JSON.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.existingDashboards)) {
    return NextResponse.json(
      formatApiError(
        "El campo 'existingDashboards' es obligatorio y debe ser un array (puede estar vacío).",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const existingDashboards = (b.existingDashboards as unknown[])
    .map((d) => {
      if (typeof d !== "object" || d === null) return null;
      const item = d as Record<string, unknown>;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const description =
        typeof item.description === "string" ? item.description.trim() : "";
      return {
        // Truncate long titles/descriptions/widget names to keep prompt size bounded
        title: title.slice(0, 120),
        description: description.slice(0, 200),
        widgetTitles: Array.isArray(item.widgetTitles)
          ? (item.widgetTitles as unknown[])
              .filter((w) => typeof w === "string")
              .map((w) => (w as string).trim().slice(0, 80))
              .filter(Boolean)
              .slice(0, 20)
          : [],
      };
    })
    // Remove invalid entries with empty title to avoid noisy tokens in LLM prompt
    .filter(
      (d): d is { title: string; description: string; widgetTitles: string[] } =>
        d !== null && d.title.length > 0,
    )
    // Cap to avoid prompt bloat
    .slice(0, 30);

  // --- Call LLM ---
  let rawResponse: string;
  try {
    rawResponse = await analyzeGaps(existingDashboards, { requestId });
  } catch (err: unknown) {
    if (err instanceof BudgetExceededError) {
      return NextResponse.json(
        formatApiError(err.message, "LLM_BUDGET_EXCEEDED", undefined, requestId),
        { status: 429 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    const normalizedMessage = message.toLowerCase();
    console.error(`[${requestId}] Error al analizar gaps con el LLM:`, err);

    const isRateLimit =
      normalizedMessage.includes("rate limit") ||
      normalizedMessage.includes("ratelimit") ||
      normalizedMessage.includes("429");

    return NextResponse.json(
      formatApiError(
        isRateLimit
          ? "Límite de uso del modelo de IA alcanzado. Inténtalo en unos minutos."
          : "Error al analizar la cobertura. Inténtalo de nuevo.",
        isRateLimit ? "LLM_RATE_LIMIT" : "LLM_ERROR",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: isRateLimit ? 429 : 500 },
    );
  }

  // --- Parse JSON from LLM output ---
  const jsonStr = extractJson(rawResponse);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error(
      `[${requestId}] El LLM devolvió JSON inválido en gaps (${jsonStr.length} chars)`,
    );
    return NextResponse.json(
      formatApiError(
        "El modelo de IA devolvió una respuesta con formato incorrecto.",
        "LLM_INVALID_RESPONSE",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  // --- Validate and normalise gaps array ---
  if (!Array.isArray(parsed)) {
    return NextResponse.json(
      formatApiError(
        "El modelo de IA devolvió una respuesta inesperada (se esperaba un array).",
        "LLM_INVALID_RESPONSE",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const gaps = parsed
    .map((item: unknown) => {
      const g = (typeof item === "object" && item !== null
        ? item
        : {}) as Record<string, unknown>;
      return {
        area: typeof g.area === "string" ? g.area.trim() : "",
        description: typeof g.description === "string" ? g.description.trim() : "",
        suggestedPrompt:
          typeof g.suggestedPrompt === "string" ? g.suggestedPrompt.trim() : "",
      };
    })
    // Filter out invalid entries that would render empty gap cards, missing descriptions, or trigger no-op generation
    .filter(
      (g) =>
        g.area.trim().length > 0 &&
        g.description.trim().length > 0 &&
        g.suggestedPrompt.trim().length > 0,
    )
    // Enforce maximum to match the prompt contract (3-5 gaps)
    .slice(0, 5);

  return NextResponse.json({ gaps }, { status: 200 });
}
