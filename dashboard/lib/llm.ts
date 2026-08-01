/**
 * Dashboard LLM entry points — thin wrappers around assembleRequest().
 *
 * Every public function delegates to `assembleRequest(flow, vars, ...)` in
 * `dashboard/lib/llm-context/`.  No prompt assembly or LLM calls happen here
 * directly; all of that is owned by llm-context/assemble.ts (the single
 * seam enforced by CI via check-llm-context.sh).
 *
 * This file retains:
 *  - Public API contracts (function signatures, return types)
 *  - `checkDailyBudget()` gate (not inside assembleRequest)
 *  - Re-exports consumed by routes and turn-background
 */

import { ReviewLlmOutputSchema, type ReviewLlmOutput } from "./review-schema";
import { checkDailyBudget } from "./llm-usage";
import { AgenticRunnerError } from "./llm-tools/runner";
import { resetClient } from "./llm-client";
import type { LlmAgenticContext, AgenticProgressEvent } from "./llm-tools/types";
import { assembleRequest } from "./llm-context";
import type { FlowVars } from "./llm-context";

export { BudgetExceededError } from "./llm-usage";
export { CircuitBreakerOpenError } from "./llm-circuit-breaker";
export { AgenticRunnerError };
export type { LlmAgenticContext, AgenticProgressEvent } from "./llm-tools/types";
export { resetClient };

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Generate a new dashboard from a user prompt (in Spanish).
 *
 * Returns the raw LLM response text, which should be a JSON dashboard spec.
 */
export async function generateDashboard(
  userPrompt: string,
  ctx?: LlmAgenticContext,
): Promise<string> {
  await checkDailyBudget();

  const requestCtx: LlmAgenticContext = ctx ?? {
    requestId: "req_local",
    endpoint: "generateDashboard",
  };

  const result = await assembleRequest(
    "generate",
    {},
    null,
    userPrompt,
    {
      ctx: requestCtx,
      requestId: requestCtx.requestId ?? "req_local",
      endpoint: "generateDashboard",
      temperature: 0.2,
      maxOutputTokens: 8192,
    },
  );

  if (!result.text) {
    throw new Error("LLM returned an empty response");
  }

  return result.text;
}

/**
 * Modify an existing dashboard based on a user prompt (in Spanish).
 *
 * Returns the raw LLM response text, which should be the full updated JSON spec.
 */
export async function modifyDashboard(
  currentSpec: string,
  userPrompt: string,
  ctx?: LlmAgenticContext,
  priorTurns?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
  await checkDailyBudget();

  const requestCtx: LlmAgenticContext = ctx ?? {
    requestId: "req_local",
    endpoint: "modifyDashboard",
  };

  const priorMessages = (priorTurns ?? []).map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const vars: FlowVars = { currentSpec };

  const result = await assembleRequest(
    "modify",
    vars,
    null,
    userPrompt,
    {
      ctx: requestCtx,
      priorMessages,
      requestId: requestCtx.requestId ?? "req_local",
      endpoint: "modifyDashboard",
      temperature: 0.2,
      maxOutputTokens: 8192,
    },
  );

  return result.text;
}

/**
 * Suggest dashboards for a given role, avoiding overlap with existing ones.
 *
 * Returns raw JSON string: array of {name, description, prompt}.
 */
export async function suggestDashboards(
  role: string,
  existingDashboards: { title: string; description: string }[],
  opts?: { requestId?: string },
): Promise<string> {
  await checkDailyBudget();

  const vars: FlowVars = { role, existingDashboards };

  const result = await assembleRequest(
    "suggest",
    vars,
    null,
    `Sugiere 3-4 dashboards útiles para el rol: ${role}`,
    {
      requestId: opts?.requestId ?? null,
      endpoint: "suggestDashboards",
      temperature: 0.2,
      maxOutputTokens: 8192,
    },
  );

  if (!result.text) {
    throw new Error("LLM returned an empty response");
  }
  return result.text;
}

/**
 * Analyze coverage gaps in the existing set of dashboards.
 *
 * Returns raw JSON string: array of {area, description, suggestedPrompt}.
 */
export async function analyzeGaps(
  existingDashboards: {
    title: string;
    description: string;
    widgetTitles: string[];
  }[],
  opts?: { requestId?: string },
): Promise<string> {
  await checkDailyBudget();

  const vars: FlowVars = { existingDashboards };

  const result = await assembleRequest(
    "gap",
    vars,
    null,
    "Analiza los dashboards existentes e identifica las áreas de negocio importantes que no están cubiertas.",
    {
      requestId: opts?.requestId ?? null,
      endpoint: "analyzeGaps",
      temperature: 0.2,
      maxOutputTokens: 8192,
    },
  );

  if (!result.text) {
    throw new Error("LLM returned an empty response");
  }
  return result.text;
}

/**
 * Analyze dashboard data in response to a user question (in Spanish).
 *
 * Returns the raw LLM response text, which will be markdown-formatted analysis.
 */
export async function analyzeDashboard(
  serializedData: string,
  userPrompt: string,
  action?: string,
  ctx?: LlmAgenticContext,
  priorTurns?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
  await checkDailyBudget();

  const requestCtx: LlmAgenticContext = ctx ?? {
    requestId: "req_local",
    endpoint: "analyzeDashboard",
  };

  const priorMessages = (priorTurns ?? []).map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const vars: FlowVars = {
    serializedData,
    action,
    dashboardId: requestCtx.dashboardId,
  };

  const result = await assembleRequest(
    "analyze",
    vars,
    null,
    userPrompt,
    {
      ctx: requestCtx,
      priorMessages,
      requestId: requestCtx.requestId ?? "req_local",
      endpoint: "analyzeDashboard",
      temperature: 0.3,
      maxOutputTokens: 4096,
    },
  );

  return result.text;
}

/**
 * Generate a weekly business review with optional agentic progress callbacks.
 */
export async function generateReviewWithProgress(
  vars: { queryResults: string; reviewedWeekDescription: string; generationMode: "initial" | "refresh_data" | "alternate_angle" },
  opts?: { requestId?: string; onAgenticProgress?: (ev: AgenticProgressEvent) => void },
): Promise<{ content: ReviewLlmOutput; message: string }> {
  const requestId = opts?.requestId ?? "req_local";

  await checkDailyBudget();

  // Agentic path: always use assembleRequest which dispatches to runAgenticChat
  // when isAgenticToolsEnabled() is true.
  const ctx: LlmAgenticContext = {
    requestId,
    endpoint: "generateReview",
    onAgenticProgress: opts?.onAgenticProgress,
    reviewResult: null,
  };

  const result = await assembleRequest(
    "weekly",
    vars,
    null,
    "Genera la revisión semanal ahora.",
    {
      ctx,
      requestId,
      endpoint: "generateReview",
      temperature: 0.2,
      maxOutputTokens: 4096,
    },
  );

  // Agentic path: reviewResult was staged by submit_weekly_review tool
  if (ctx.reviewResult) {
    return { content: ctx.reviewResult.content, message: result.text };
  }

  // Non-agentic path: parse JSON from result.text
  const rawContent = result.text;
  const fenced = rawContent.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonStr = fenced ? fenced[1].trim() : rawContent.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `LLM returned invalid JSON for review. Raw response: ${rawContent.slice(0, 500)}`,
    );
  }

  const z = ReviewLlmOutputSchema.safeParse(parsed);
  if (!z.success) {
    throw new Error(
      `LLM returned JSON that does not match ReviewLlmOutputSchema: ${z.error.message}`,
    );
  }
  return { content: z.data, message: "" };
}

/**
 * Generate a weekly business review from query results (in Spanish).
 */
export async function generateReview(
  vars: { queryResults: string; reviewedWeekDescription: string; generationMode: "initial" | "refresh_data" | "alternate_angle" },
  opts?: { requestId?: string },
): Promise<{ content: ReviewLlmOutput; message: string }> {
  const requestId = opts?.requestId ?? "req_local";

  await checkDailyBudget();

  const result = await assembleRequest(
    "weekly",
    vars,
    null,
    "Genera la revisión semanal ahora.",
    {
      requestId,
      endpoint: "generateReview",
      temperature: 0.2,
      maxOutputTokens: 4096,
    },
  );

  const rawContent = result.text;
  const fenced = rawContent.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonStr = fenced ? fenced[1].trim() : rawContent.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `LLM returned invalid JSON for review. Raw response: ${rawContent.slice(0, 500)}`,
    );
  }

  const z = ReviewLlmOutputSchema.safeParse(parsed);
  if (!z.success) {
    throw new Error(
      `LLM returned JSON that does not match ReviewLlmOutputSchema: ${z.error.message}`,
    );
  }
  return { content: z.data, message: "" };
}

/**
 * Generate follow-up question suggestions based on the last exchange.
 *
 * Returns an array of suggestion strings, or [] on any failure (never throws).
 */
export async function generateSuggestions(
  serializedData: string,
  lastExchange: string,
  opts?: { requestId?: string },
): Promise<string[]> {
  try {
    await checkDailyBudget();

    const vars: FlowVars = { serializedData };

    // buildSuggestionPrompt returns a plain string used as the user message
    // (no system prompt). We pass it as userMessage with flow "summary".
    const { buildSuggestionPrompt } = await import("./analyze-prompts");
    const userMessage = buildSuggestionPrompt(serializedData, lastExchange);

    const result = await assembleRequest(
      "summary",
      vars,
      null,
      userMessage,
      {
        requestId: opts?.requestId ?? null,
        endpoint: "generateSuggestions",
        temperature: 0.5,
        maxOutputTokens: 512,
      },
    );

    const content = result.text;
    const fenced = content.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const jsonStr = fenced ? fenced[1].trim() : content.trim();

    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      return parsed as string[];
    }
    return [];
  } catch {
    return [];
  }
}
