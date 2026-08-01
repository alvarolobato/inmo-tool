/**
 * Agentic chat loop: tools, tool results, hard limits, telemetry.
 * Model execution is delegated to an AgenticModelAdapter (OpenRouter or CLI).
 */

import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { logLlmToolCall } from "./logging";
import { DASHBOARD_AGENTIC_TOOLS } from "./catalog";
import { setConversationTitleOnce } from "@/lib/conversations";
import { getAgenticConfig } from "./config";
import {
  emptyUsage,
  addUsage,
  type AgenticUsageTotals,
  type LlmAgenticContext,
  type AgenticProgressEvent,
} from "./types";
import { stringifyToolPayload, toolError, toolOk, type ToolResponseBody } from "./tool-payload";
import {
  handleValidateQuery,
  handleExecuteQuery,
  handleExplainQuery,
  handleListPsTables,
  handleDescribePsTable,
} from "./handlers/sql";
import {
  handleListDashboards,
  handleGetDashboardSpec,
  handleGetDashboardQueries,
  handleGetDashboardWidgetRawValues,
  handleGetDashboardAllWidgetStatus,
  handleValidateDashboardSpec,
  handleApplyDashboardModification,
  handleSubmitDashboardAnalysis,
  handleSubmitWeeklyReview,
} from "./handlers/dashboards";
import { handleStartDashboardGeneration } from "./handlers/start-dashboard-generation";
import type { AgenticModelAdapter, AgenticRunStepInput } from "./runner-types";
import { CliRunnerError } from "@/lib/llm-client";
import { sanitize } from "@/lib/llm-provider/sanitize";

const ARGS_PREVIEW_MAX = 120;

/** Rich diagnostic detail attached to an AgenticRunnerError; surfaces in the
 *  "Detalles" modal and in admin telemetry. Optional fields are populated only
 *  when relevant (e.g. CLI fields are absent for OpenRouter failures). */
export interface AgenticRunnerErrorDiagnostic {
  /** Where in the loop the failure happened. */
  phase:
    | "tool_call"
    | "tool_response"
    | "final"
    | "cli_spawn"
    | "cli_exit"
    | "limits";
  toolRoundsUsed: number;
  toolCallsUsed: number;
  durationMs: number;
  lastToolCall?: { name: string; argumentsTruncated: string };
  /** CLI-specific fields, only set for `provider: cli` failures. */
  cli?: {
    exitCode: number | null;
    /** argv (file + args) the runner spawned, sanitized. */
    command?: readonly string[];
    /** Last ~4 KB of CLI stderr, sanitized. */
    stderrTail?: string;
    /** Last ~4 KB of CLI stdout, sanitized. */
    stdoutTail?: string;
    /** Inner error code surfaced by the CLI binary (e.g. api_error_status). */
    innerErrorCode?: string | number | null;
  };
  /** Limits in effect when the runner failed (helps distinguish "exhausted" vs "crash"). */
  limitsAtFailure: {
    maxRounds: number;
    maxToolCalls: number;
    toolTimeoutMs: number;
    executeRowLimit: number;
    payloadCharLimit: number;
  };
}

export class AgenticRunnerError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly diagnostic?: AgenticRunnerErrorDiagnostic;

  constructor(
    code: string,
    message: string,
    requestId: string,
    diagnostic?: AgenticRunnerErrorDiagnostic,
  ) {
    super(message);
    this.name = "AgenticRunnerError";
    this.code = code;
    this.requestId = requestId;
    this.diagnostic = diagnostic;
  }
}

export interface AgenticRunParams {
  adapter: AgenticModelAdapter;
  model: string;
  /** OpenRouter-only: `provider` routing preferences for this run. */
  openRouterProvider?: Record<string, unknown>;
  systemPrompt: string;
  /**
   * Optional pre-built system message with provider-specific extensions (e.g.
   * Anthropic cache_control blocks for prompt caching via OpenRouter).
   * When provided this replaces `{ role: "system", content: systemPrompt }`.
   */
  cachedSystemMessage?: ChatCompletionMessageParam;
  userContent: string;
  ctx: LlmAgenticContext;
  temperature: number;
  maxTokens: number;
  /** Prior conversation turns injected between the system prompt and the new user message. */
  priorMessages?: ChatCompletionMessageParam[];
  /**
   * OpenRouter adapter only: when true, adds `reasoning: { effort: "medium" }`
   * to each API request, enabling extended thinking for capable models
   * (Claude 3.7+, o3, DeepSeek R1, Gemini 3, etc.).
   * Defaults to false — opt in explicitly to avoid unexpected cost/latency.
   */
  enableReasoning?: boolean;
  /**
   * Explicit tool catalog for this run. When omitted, defaults to
   * DASHBOARD_AGENTIC_TOOLS (full catalog, backwards-compatible).
   * Use FREE_CHAT_TOOLS for free-chat flows that should only expose
   * inspection + start_dashboard_generation.
   */
  tools?: ChatCompletionTool[];
}

export interface AgenticRunResult {
  content: string;
  usage: AgenticUsageTotals;
}

/**
 * JavaScript-side deadline so the model receives `TOOL_TIMEOUT` promptly.
 * SQL tools also use PostgreSQL `SET LOCAL statement_timeout` on the mirror
 * connection (`queryReadOnlyWithStatementTimeout`) so the server can cancel
 * expensive statements. Non-SQL tools may still finish shortly after this
 * promise rejects if their backing I/O ignores cancellation.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("TOOL_TIMEOUT")), ms);
    promise.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

async function dispatchTool(
  name: string,
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  switch (name) {
    case "validate_query":
      return handleValidateQuery(rawArgs, ctx);
    case "execute_query":
      return handleExecuteQuery(rawArgs, ctx);
    case "explain_query":
      return handleExplainQuery(rawArgs, ctx);
    case "list_ps_tables":
      return handleListPsTables(rawArgs, ctx);
    case "describe_ps_table":
      return handleDescribePsTable(rawArgs, ctx);
    case "list_dashboards":
      return handleListDashboards(rawArgs, ctx);
    case "get_dashboard_spec":
      return handleGetDashboardSpec(rawArgs, ctx);
    case "get_dashboard_queries":
      return handleGetDashboardQueries(rawArgs, ctx);
    case "get_dashboard_widget_raw_values":
      return handleGetDashboardWidgetRawValues(rawArgs, ctx);
    case "get_dashboard_all_widget_status":
      return handleGetDashboardAllWidgetStatus(rawArgs, ctx);
    case "validate_dashboard_spec":
      return handleValidateDashboardSpec(rawArgs, ctx);
    case "apply_dashboard_modification":
      return handleApplyDashboardModification(rawArgs, ctx);
    case "submit_dashboard_analysis":
      return handleSubmitDashboardAnalysis(rawArgs, ctx);
    case "submit_weekly_review":
      return handleSubmitWeeklyReview(rawArgs, ctx);
    case "start_dashboard_generation":
      return handleStartDashboardGeneration(rawArgs, ctx);
    case "set_title": {
      if (!ctx.conversationId) {
        return toolError("SET_TITLE_NO_CONV", "set_title requires a conversation context", ctx);
      }
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        return toolError("SET_TITLE_INVALID_ARGS", "Invalid JSON arguments for set_title", ctx);
      }
      const title = parsedArgs.title;
      if (typeof title !== "string" || title.trim() === "") {
        return toolError("SET_TITLE_INVALID_TITLE", "title must be a non-empty string", ctx);
      }
      const trimmedTitle = title.trim().slice(0, 100);
      await setConversationTitleOnce(ctx.conversationId, trimmedTitle);
      return toolOk({ title: trimmedTitle });
    }
    default:
      return toolError("UNKNOWN_TOOL", `Unknown tool: ${name}`, ctx);
  }
}

function emitAgenticProgress(ctx: LlmAgenticContext, event: AgenticProgressEvent): void {
  try {
    ctx.onAgenticProgress?.(event);
  } catch (hookErr) {
    console.warn("[agentic] onAgenticProgress hook failed:", hookErr);
  }
  // Server logs: drop the cumulative `text` payload from streaming events
  // — it grows with every token chunk and would flood the log with redundant
  // copies of the running text. The client still receives the full text via
  // the NDJSON stream.
  const logEvent =
    (event.type === "model_thinking_delta" || event.type === "model_text_delta") && "text" in event
      ? { ...event, text: undefined }
      : event;
  console.info(`[agentic][${ctx.endpoint}][${ctx.requestId}]`, JSON.stringify(logEvent));
}

export async function runAgenticChat(params: AgenticRunParams): Promise<AgenticRunResult> {
  const {
    adapter,
    model,
    openRouterProvider,
    systemPrompt,
    cachedSystemMessage,
    userContent,
    ctx,
    temperature,
    maxTokens,
    priorMessages,
    enableReasoning,
    tools: toolsOverride,
  } = params;

  const cfg = getAgenticConfig();
  const tools: ChatCompletionTool[] = toolsOverride ?? DASHBOARD_AGENTIC_TOOLS;
  const usage = emptyUsage();

  const systemMessage: ChatCompletionMessageParam =
    cachedSystemMessage ?? { role: "system", content: systemPrompt };

  const messages: ChatCompletionMessageParam[] = [
    systemMessage,
    ...(priorMessages ?? []),
    { role: "user", content: userContent },
  ];

  let toolCallsTotal = 0;
  let lastToolName: string | null = null;
  let lastToolArgs: string | null = null;
  const startedAt = Date.now();

  // ── helpers ─────────────────────────────────────────────────────────────
  const buildLimits = () => ({
    maxRounds: cfg.maxToolRounds,
    maxToolCalls: cfg.maxToolCalls,
    toolTimeoutMs: cfg.toolTimeoutMs,
    executeRowLimit: cfg.maxRows,
    payloadCharLimit: cfg.maxResultChars,
  });
  const buildLastToolCall = () =>
    lastToolName
      ? {
          name: lastToolName,
          argumentsTruncated: (lastToolArgs ?? "").slice(0, 300),
        }
      : undefined;
  const buildBaseDiag = (phase: import("./runner").AgenticRunnerErrorDiagnostic["phase"], roundsDone: number): import("./runner").AgenticRunnerErrorDiagnostic => ({
    phase,
    toolRoundsUsed: roundsDone,
    toolCallsUsed: toolCallsTotal,
    durationMs: Date.now() - startedAt,
    lastToolCall: buildLastToolCall(),
    limitsAtFailure: buildLimits(),
  });
  const cliDiagFromError = (e: CliRunnerError) => ({
    exitCode: e.exitCode,
    command: e.details.command,
    stderrTail: e.details.stderr,
    stdoutTail: e.details.stdout,
    innerErrorCode: e.details.innerErrorCode ?? null,
  });

  for (let round = 0; round < cfg.maxToolRounds; round++) {
    emitAgenticProgress(ctx, {
      type: "round",
      round: round + 1,
      maxRounds: cfg.maxToolRounds,
    });

    emitAgenticProgress(ctx, {
      type: "model_step_start",
      round: round + 1,
      provider: ctx.llmProvider ?? "openrouter",
      driver: ctx.llmDriver ?? null,
    });

    let step;
    try {
      const stepInput: AgenticRunStepInput = {
        messages,
        tools,
        model,
        openRouterProvider,
        temperature,
        maxTokens,
        enableReasoning,
        onTextDelta: (chars, totalChars, accumulatedText) => {
          emitAgenticProgress(ctx, {
            type: "model_text_delta",
            round: round + 1,
            chars,
            totalChars,
            text: accumulatedText,
          });
        },
        onThinkingDelta: (chars, totalChars, accumulatedThinking) => {
          emitAgenticProgress(ctx, {
            type: "model_thinking_delta",
            round: round + 1,
            chars,
            totalChars,
            text: accumulatedThinking,
          });
        },
      };
      step = await adapter.runStep(stepInput);
    } catch (e) {
      if (e instanceof AgenticRunnerError) throw e;
      if (e instanceof CliRunnerError) {
        const phase: import("./runner").AgenticRunnerErrorDiagnostic["phase"] =
          e.details.phase === "spawn" ? "cli_spawn" : "cli_exit";
        throw new AgenticRunnerError(e.code, e.message, ctx.requestId, {
          ...buildBaseDiag(phase, round),
          cli: cliDiagFromError(e),
        });
      }
      throw new AgenticRunnerError(
        "AGENTIC_ADAPTER",
        e instanceof Error ? e.message : "Model step failed.",
        ctx.requestId,
        buildBaseDiag("tool_call", round),
      );
    }

    addUsage(usage, step.usage);

    if (step.kind === "error") {
      throw new AgenticRunnerError(
        step.code,
        step.message,
        ctx.requestId,
        buildBaseDiag("tool_call", round),
      );
    }

    if (step.kind === "final") {
      emitAgenticProgress(ctx, { type: "finalizing", messageChars: step.content.length });
      return { content: step.content, usage };
    }

    const toolCalls = step.tool_calls;
    if (!toolCalls?.length) {
      throw new AgenticRunnerError(
        "LLM_EMPTY",
        "The model returned no tools or final text.",
        ctx.requestId,
        buildBaseDiag("final", round),
      );
    }

    const toolNames = toolCalls.map((tc) => tc.function?.name ?? "(missing)");
    emitAgenticProgress(ctx, {
      type: "assistant_tools",
      round: round + 1,
      tools: toolNames,
    });

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      toolCallsTotal += 1;
      if (toolCallsTotal > cfg.maxToolCalls) {
        throw new AgenticRunnerError(
          "AGENTIC_MAX_TOOL_CALLS",
          `Exceeded maximum tool calls (${cfg.maxToolCalls}).`,
          ctx.requestId,
          buildBaseDiag("limits", round),
        );
      }

      const name = tc.function?.name ?? "";
      const rawArgs = tc.function?.arguments ?? "{}";
      lastToolName = name || "(missing)";
      lastToolArgs = rawArgs;
      const argsPreview = sanitize(rawArgs).slice(0, ARGS_PREVIEW_MAX);
      emitAgenticProgress(ctx, {
        type: "tool_start",
        round: round + 1,
        name: name || "(missing)",
        toolCallId: tc.id,
        argsPreview,
      });
      const t0 = Date.now();
      let body: ToolResponseBody;
      let telemetryStatus: "ok" | "error" = "ok";
      let errorCode: string | null = null;

      try {
        body = await withTimeout(dispatchTool(name, rawArgs, ctx), cfg.toolTimeoutMs);
        telemetryStatus = body.ok ? "ok" : "error";
        if (!body.ok) {
          errorCode = body.code;
        }
      } catch (e) {
        telemetryStatus = "error";
        if (e instanceof Error && e.message === "TOOL_TIMEOUT") {
          errorCode = "TOOL_TIMEOUT";
          body = toolError("TOOL_TIMEOUT", "Tool exceeded time limit.", ctx);
        } else {
          errorCode = "TOOL_EXCEPTION";
          body = toolError("TOOL_EXCEPTION", "Tool execution failed.", ctx);
        }
      }

      const payload = stringifyToolPayload(body, cfg.maxResultChars, ctx);
      const latency = Date.now() - t0;

      void logLlmToolCall({
        toolName: name || "(missing)",
        endpoint: ctx.endpoint,
        requestId: ctx.requestId,
        status: telemetryStatus,
        latencyMs: latency,
        payloadInBytes: Buffer.byteLength(rawArgs, "utf8"),
        payloadOutBytes: Buffer.byteLength(payload, "utf8"),
        errorCode,
        llmProvider: ctx.llmProvider,
        llmDriver: ctx.llmDriver ?? null,
      });

      emitAgenticProgress(ctx, {
        type: "tool_done",
        round: round + 1,
        name: name || "(missing)",
        toolCallId: tc.id,
        ok: body.ok,
        ms: latency,
        errorCode,
        argsPreview,
      });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: payload,
      });

      // Capture the round-trip so the caller can persist it as conversation
      // context for later turns (the "interesting part": tool, args, result).
      (ctx.toolCalls ??= []).push({
        id: tc.id,
        name: name || "(missing)",
        arguments: rawArgs,
        result: payload,
        ok: body.ok,
        ms: latency,
      });
    }
  }

  throw new AgenticRunnerError(
    "AGENTIC_MAX_ROUNDS",
    `Exceeded maximum tool rounds (${cfg.maxToolRounds}).`,
    ctx.requestId,
    {
      phase: "limits",
      toolRoundsUsed: cfg.maxToolRounds,
      toolCallsUsed: toolCallsTotal,
      durationMs: Date.now() - startedAt,
      lastToolCall: buildLastToolCall(),
      limitsAtFailure: buildLimits(),
    },
  );
}
