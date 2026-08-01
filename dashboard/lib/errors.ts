/**
 * Shared error utilities for the Dashboard App API layer.
 *
 * Provides:
 *   - ErrorCode enum for all known error categories
 *   - ApiErrorResponse — the standard shape returned by all API error responses
 *   - formatApiError() — builds a standard error response object
 *   - generateRequestId() — produces a short correlation ID for log tracing
 */

import type { DashboardLlmProviderId } from "./llm-provider/types";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "DB_CONNECTION"
  | "DB_QUERY"
  | "DB_ERROR"
  | "LLM_ERROR"
  | "LLM_RATE_LIMIT"
  | "LLM_BUDGET_EXCEEDED"
  | "LLM_CIRCUIT_OPEN"
  | "LLM_INVALID_RESPONSE"
  | "VALIDATION"
  | "INVALID_BODY"
  | "MISSING_MODE"
  | "INVALID_MODE"
  | "INVALID_ROLE"
  | "MISSING_CONTENT"
  | "CONTENT_TOO_LONG"
  | "CONVERSATION_ARCHIVED"
  | "TURN_IN_PROGRESS"
  | "SQL_LINT"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "COST_LIMIT"
  | "REVIEW_EXISTS"
  | "REVIEW_PERSISTENCE"
  | "UNKNOWN"
  | "AGENTIC_RUNNER"
  | "METHOD_NOT_ALLOWED";

/**
 * Rich diagnostic payload attached to AGENTIC_RUNNER errors so the UI
 * "Detalles" modal can show provider/driver, CLI exit code + sanitized
 * stdout/stderr tails, the last tool call, and the configured limits.
 *
 * All string fields here MUST be sanitized server-side before being put
 * on the wire; see `lib/llm-provider/sanitize.ts`.
 */
export interface AgenticErrorDiagnostic {
  /** Inner LLM/CLI failure code (e.g. LLM_CLI_AUTH, LLM_CLI_EXIT). */
  subError: string;
  /** LLM provider that produced this error (never "e2e-stub" — coerced to "openrouter" before emit). */
  provider: Exclude<DashboardLlmProviderId, "e2e-stub">;
  /** CLI driver id (claude_code) when provider=cli, else null. */
  driver: string | null;
  /** Effective model id sent to the upstream backend. */
  model: string;
  /**
   * Coarse-grained phase the runner failed in.
   * `cli_spawn` / `cli_exit` are CLI-only.
   */
  phase: "tool_call" | "tool_response" | "final" | "cli_spawn" | "cli_exit" | "limits";
  /** Wall-clock ms from runner start to failure. */
  durationMs: number;
  /** Number of completed adapter rounds (0-based count of finished rounds). */
  toolRoundsUsed: number;
  /** Total tool calls attempted across all rounds. */
  toolCallsUsed: number;
  /** Last tool the runner started (if any) — name + truncated args. */
  lastToolCall?: { name: string; argumentsTruncated: string };
  /** Present only when provider === "cli". */
  cli?: {
    exitCode: number | null;
    /** argv[0] + flags as the runner spawned them (sanitized — no secrets). */
    command?: string[];
    /** Last ~4 KB of stderr (sanitized). */
    stderrTail?: string;
    /** Last ~4 KB of stdout (sanitized). */
    stdoutTail?: string;
    /** Inner code from the CLI envelope (e.g. api_error_status: 401). */
    innerErrorCode?: string | number | null;
  };
  /** Limits in effect when the runner failed. */
  limitsAtFailure: {
    maxRounds: number;
    maxToolCalls: number;
    toolTimeoutMs: number;
    executeRowLimit: number;
    payloadCharLimit: number;
  };
}

// ---------------------------------------------------------------------------
// Standard API error response shape
// ---------------------------------------------------------------------------

export interface ApiErrorResponse {
  /** User-facing message in Spanish. */
  error: string;
  /** Machine-readable error code. */
  code: ErrorCode;
  /** Sanitized technical detail — no credentials, no PII. */
  details?: string;
  /** ISO timestamp of the error. */
  timestamp: string;
  /** Correlation ID for matching frontend error to server log. */
  requestId: string;
  /** When code is REVIEW_EXISTS — id of the saved review for that week. */
  existing_id?: number;
  /** When code is REVIEW_EXISTS — Monday (YYYY-MM-DD) of the reviewed week. */
  week_start?: string;
  /** Rich diagnostic payload for AGENTIC_RUNNER failures (sanitized). */
  diagnostic?: AgenticErrorDiagnostic;
}

// ---------------------------------------------------------------------------
// generateRequestId
// ---------------------------------------------------------------------------

/**
 * Generates a short request ID suitable for log correlation.
 * Uses crypto.randomUUID() (Node 19+ / browsers) when available,
 * falling back to Math.random() to avoid breaking test environments.
 * Example: "req_a3f2c9b8"
 */
export function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }
  // Fallback for environments where crypto.randomUUID is unavailable
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// formatApiError
// ---------------------------------------------------------------------------

/**
 * Builds a standard API error response object.
 *
 * @param error  - User-facing Spanish message (always visible to the user).
 * @param code   - Machine-readable error code.
 * @param details - Sanitized technical context (optional, no credentials/PII).
 * @param requestId - Correlation ID (auto-generated if omitted).
 */
export function formatApiError(
  error: string,
  code: ErrorCode,
  details?: string,
  requestId?: string,
  diagnostic?: AgenticErrorDiagnostic,
): ApiErrorResponse {
  return {
    error,
    code,
    ...(details !== undefined ? { details } : {}),
    timestamp: new Date().toISOString(),
    requestId: requestId ?? generateRequestId(),
    ...(diagnostic !== undefined ? { diagnostic } : {}),
  };
}

// ---------------------------------------------------------------------------
// isApiErrorResponse — type guard
// ---------------------------------------------------------------------------

/**
 * Type guard: returns true only when the value looks like a well-formed
 * ApiErrorResponse (has all required string fields).
 * Use this instead of loose `"code" in obj` checks to avoid false positives.
 */
export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.error === "string" &&
    typeof v.code === "string" &&
    typeof v.timestamp === "string" &&
    typeof v.requestId === "string" &&
    // details must be absent or a string (never an object/array)
    (v.details === undefined || typeof v.details === "string") &&
    (v.existing_id === undefined || typeof v.existing_id === "number") &&
    (v.week_start === undefined || typeof v.week_start === "string") &&
    // diagnostic must be absent or a non-array object
    (v.diagnostic === undefined ||
      (typeof v.diagnostic === "object" &&
        v.diagnostic !== null &&
        !Array.isArray(v.diagnostic)))
  );
}

// ---------------------------------------------------------------------------
// sanitizeErrorMessage
// ---------------------------------------------------------------------------

/**
 * Returns a sanitized version of an error message suitable for `details`.
 * Strips connection strings, passwords, API keys, email-like patterns,
 * and other potentially sensitive content.
 *
 * NOTE: This sanitization is best-effort. For errors that may contain PII
 * (e.g. DB query errors that echo back SQL parameters), prefer passing
 * `undefined` as details rather than this helper.
 */
export function sanitizeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    // Redact DSN/connection strings (postgresql:// and postgres://)
    .replace(/postgres(?:ql)?:\/\/[^\s]*/gi, "[DSN redacted]")
    // Redact password fields
    .replace(/password=[^\s&]*/gi, "password=[redacted]")
    // Redact user:pass@host patterns
    .replace(/:[^@\s]*@/g, ":[redacted]@")
    // Redact Bearer/API tokens
    .replace(/\bbearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[a-zA-Z0-9]+/g, "[API key redacted]")
    // Redact email addresses
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email redacted]")
    .slice(0, 300);
}
