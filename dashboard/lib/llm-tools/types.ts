/**
 * Shared types for the agentic LLM tool layer.
 */

import type { DashboardCliDriverId, DashboardLlmProviderId } from "@/lib/llm-provider/types";
import type { DashboardSpec } from "@/lib/schema";
import type { ReviewLlmOutput } from "@/lib/review-schema";

/** High-level events from the tool loop (UI streaming + server logs). */
export type AgenticProgressEvent =
  | { type: "round"; round: number; maxRounds: number }
  | { type: "model_step_start"; round: number; provider: DashboardLlmProviderId; driver: DashboardCliDriverId | null }
  | {
      type: "model_text_delta";
      round: number;
      chars: number;
      totalChars: number;
      /**
       * Cumulative text streamed so far this step.
       * Populated so the UI can show the model's response as it streams.
       * During tool-calling rounds this is typically JSON tool-call arguments
       * (not human prose); during the final round it is the actual response.
       * Consumers that only want the character counter may ignore this field.
       */
      text?: string;
    }
  | {
      type: "model_thinking_delta";
      round: number;
      chars: number;
      totalChars: number;
      /** Full extended-thinking text streamed so far this step (cumulative). */
      text?: string;
    }
  | { type: "assistant_tools"; round: number; tools: string[] }
  | { type: "tool_start"; round: number; name: string; toolCallId: string; argsPreview?: string }
  | {
      type: "tool_done";
      round: number;
      name: string;
      toolCallId: string;
      ok: boolean;
      ms: number;
      errorCode?: string | null;
      argsPreview?: string;
    }
  | { type: "finalizing"; messageChars: number };

/**
 * A single tool round-trip captured during an agentic run. Collected by the
 * runner into `ctx.toolCalls` so the caller can persist the "interesting part"
 * (which tool ran, with what arguments, and the result the model saw) on the
 * assistant message — preserving it as conversation context for later turns.
 * `result` is the already-truncated payload the model received.
 */
export interface AgenticToolCallRecord {
  id: string;
  name: string;
  /** Raw JSON arguments string as emitted by the model. */
  arguments: string;
  /** Tool result payload the model received (already truncated to maxResultChars). */
  result: string;
  ok: boolean;
  ms: number;
}

export interface LlmAgenticContext {
  /** API correlation id (also sent to the model in tool error payloads). */
  requestId: string;
  /** `logUsage` / telemetry endpoint key, e.g. generateDashboard. */
  endpoint: string;
  /** Optional saved dashboard id (analyze flow) for dashboard-scoped tools. */
  dashboardId?: number;
  /** Optional conversation id (free-chat flow) for the start_dashboard_generation tool. */
  conversationId?: string;
  /** Optional hook for NDJSON streaming UI and diagnostics. */
  onAgenticProgress?: (event: AgenticProgressEvent) => void;
  /** Called once the system prompt is assembled, before the first LLM call. */
  onSystemPromptReady?: (
    systemPrompt: string,
    tools?: Array<{ name: string; schema: Record<string, unknown> }>,
  ) => void;
  /** Telemetry: active LLM transport (OpenRouter HTTP vs local CLI). */
  llmProvider?: DashboardLlmProviderId;
  /** When `llmProvider` is `cli`, which driver binary/protocol is used. */
  llmDriver?: DashboardCliDriverId | null;

  // ── Publish-tool side-channel slots ────────────────────────────────────────
  // These slots are populated by the publish-tool handlers and read by the
  // route AFTER the agentic loop returns. Handlers MUST only stage results
  // here — they MUST NOT persist directly to the database (dashboards /
  // weekly_reviews). The route is the single point of persistence.

  /**
   * Staged result for the `apply_dashboard_modification` tool.
   * Set by `handleApplyDashboardModification`; read by the modify route.
   * The LAST call wins — the route always uses the final value after the loop.
   */
  modifyResult?: { spec: DashboardSpec; summary: string } | null;

  /**
   * Staged result for the `submit_dashboard_analysis` tool.
   * Set by `handleSubmitDashboardAnalysis`; read by the analyze route.
   */
  analyzeResult?: { markdown: string; summary: string } | null;

  /**
   * Staged result for the `submit_weekly_review` tool.
   * Set by `handleSubmitWeeklyReview`; read by the review/generate route.
   */
  reviewResult?: { content: ReviewLlmOutput; summary: string } | null;

  /**
   * Tool calls captured during the agentic run, in execution order. Populated
   * by the runner; read by the caller AFTER the run to persist the tool context
   * on the assistant message so later turns can see what was queried. The runner
   * appends to this array — callers should not pre-populate it.
   */
  toolCalls?: AgenticToolCallRecord[];
}

export interface AgenticUsageTotals {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Tokens written to Anthropic prompt cache across all steps. NULL when provider doesn't report caching. */
  cache_creation_input_tokens: number | null;
  /** Tokens read from Anthropic prompt cache across all steps. NULL when provider doesn't report caching. */
  cache_read_input_tokens: number | null;
}

export function emptyUsage(): AgenticUsageTotals {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
  };
}

export function addUsage(
  acc: AgenticUsageTotals,
  u: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  } | null | undefined,
): void {
  if (!u) return;
  acc.prompt_tokens += u.prompt_tokens ?? 0;
  acc.completion_tokens += u.completion_tokens ?? 0;
  acc.total_tokens += u.total_tokens ?? 0;
  // Accumulate cache tokens only when the backend provides them.
  // Use null (not 0) for "not supported"; once we see a non-null value,
  // subsequent nulls are treated as zero (the provider reported no activity).
  if (u.cache_creation_input_tokens != null) {
    acc.cache_creation_input_tokens = (acc.cache_creation_input_tokens ?? 0) + u.cache_creation_input_tokens;
  }
  if (u.cache_read_input_tokens != null) {
    acc.cache_read_input_tokens = (acc.cache_read_input_tokens ?? 0) + u.cache_read_input_tokens;
  }
}
