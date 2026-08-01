/**
 * Shared LLM error classification and payload building helpers.
 *
 * Centralises the error-type → HTTP status + error code mapping and the
 * AgenticRunnerError diagnostic path so the three API routes (generate,
 * modify, analyze) stay in lock-step without duplicating logic.
 */

import {
  AgenticRunnerError,
  BudgetExceededError,
  CircuitBreakerOpenError,
} from "@/lib/llm";
import {
  formatApiError,
  sanitizeErrorMessage,
  type ErrorCode,
  type ApiErrorResponse,
} from "@/lib/errors";
import type { DashboardLlmConfig } from "@/lib/llm-provider/types";
import {
  buildAgenticErrorDiagnostic,
  persistAgenticError,
} from "@/lib/llm-tools/diagnostic";

interface ClassifiedLlmError {
  status: number;
  code: ErrorCode;
  userMessage: string;
}

/**
 * Classify an unknown LLM error into an HTTP status code, a machine-readable
 * error code, and a user-facing Spanish message.
 *
 * The `requestId` parameter is accepted for call-site consistency but is not
 * used directly here; the caller is responsible for threading it into the
 * `formatApiError()` call.
 *
 * NOTE: AgenticRunnerError is handled upstream in buildLlmErrorPayload before
 * this function is called, so it is not handled here.
 */
function classifyLlmError(
  err: unknown,
  _requestId: string,
): ClassifiedLlmError {
  if (err instanceof BudgetExceededError) {
    return {
      status: 429,
      code: "LLM_BUDGET_EXCEEDED",
      userMessage: err.message,
    };
  }

  if (err instanceof CircuitBreakerOpenError) {
    return {
      status: 503,
      code: "LLM_CIRCUIT_OPEN",
      userMessage: err.message,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  const normalizedMessage = message.toLowerCase();
  // Use specific phrases to avoid matching unrelated words ("generate", "moderate").
  const isRateLimit =
    normalizedMessage.includes("rate limit") ||
    normalizedMessage.includes("ratelimit") ||
    normalizedMessage.includes("429");

  if (isRateLimit) {
    return {
      status: 429,
      code: "LLM_RATE_LIMIT",
      userMessage:
        "Límite de uso del modelo de IA alcanzado. Inténtalo en unos minutos.",
    };
  }

  return {
    status: 500,
    code: "LLM_ERROR",
    userMessage: "Error del modelo de IA. Inténtalo de nuevo.",
  };
}

const AGENTIC_USER_MESSAGES: Record<"generate" | "modify" | "analyze", string> = {
  generate:
    "El flujo de IA con herramientas alcanzó un límite o no pudo completarse. Reformula el prompt o inténtalo de nuevo.",
  modify:
    "El flujo de IA con herramientas alcanzó un límite o no pudo completarse. Reformula el cambio o inténtalo de nuevo.",
  analyze:
    "El flujo de IA con herramientas alcanzó un límite o no pudo completarse. Inténtalo de nuevo.",
};

/**
 * Build the LLM error response payload (ApiErrorResponse shape) and the HTTP
 * status that should accompany it. Shared by the generate, modify, and analyze
 * routes so their error-handling logic stays in lock-step.
 *
 * For AgenticRunnerError: builds and persists the full diagnostic, then returns
 * the flow-specific user message. For all other errors: delegates to
 * classifyLlmError and formats with sanitized details.
 */
export function buildLlmErrorPayload(
  err: unknown,
  requestId: string,
  cfg: DashboardLlmConfig,
  flow: "generate" | "modify" | "analyze",
): { status: number; payload: ApiErrorResponse } {
  if (err instanceof AgenticRunnerError) {
    const diagnostic = buildAgenticErrorDiagnostic(err, cfg);
    persistAgenticError(flow, err, diagnostic);
    return {
      status: 500,
      payload: formatApiError(
        AGENTIC_USER_MESSAGES[flow],
        "AGENTIC_RUNNER",
        diagnostic.subError,
        err.requestId,
        diagnostic,
      ),
    };
  }
  const { status, code, userMessage } = classifyLlmError(err, requestId);
  return {
    status,
    payload: formatApiError(
      userMessage,
      code as Parameters<typeof formatApiError>[1],
      sanitizeErrorMessage(err),
      requestId,
    ),
  };
}
