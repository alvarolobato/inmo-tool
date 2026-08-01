/**
 * Central LLM request assembler and executor.
 *
 * `assembleRequest(flow, vars, conversationId, userMessage, opts)` is the
 * single entry point for all LLM calls in the dashboard.  It:
 *  1. Builds the system prompt via `buildSystemPrompt(flow, vars)`
 *  2. Loads conversation history via `buildHistory(conversationId, opts)`
 *  3. Resolves the tool catalog via `toolsForFlow(flow)`
 *  4. Loads provider config and determines model + agentic mode
 *  5. Executes via `runAgenticChat` (agentic) or `llmComplete` (single-shot)
 *  6. Returns `{ text, usage, model }`
 *
 * All imports of `llmComplete` and `runAgenticChat` in the dashboard must go
 * through this file.  CI enforces this via `dashboard/scripts/check-llm-context.sh`.
 */

import {
  llmComplete,
  buildCachedSystemMessage,
  createDashboardAgenticAdapter,
} from "@/lib/llm-client";
import { runAgenticChat } from "@/lib/llm-tools/runner";
import { callWithCircuitBreaker } from "@/lib/llm-circuit-breaker";
import {
  loadDashboardLlmConfig,
  getEffectiveDashboardModel,
  getEffectiveOpenRouterProvider,
} from "@/lib/llm-provider/config";
import { isAgenticToolsEnabled } from "@/lib/llm-tools/config";
import type { LlmAgenticContext, AgenticProgressEvent } from "@/lib/llm-tools/types";
import type { NormalizedUsage } from "@/lib/llm-client";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { buildSystemPrompt } from "./system-prompt";
import { buildHistory, type HistoryMessage } from "./history";
import { toolsForFlow } from "./tools";
import type { FlowVars } from "./types";

// ── Public types ──────────────────────────────────────────────────────────────

export type { FlowVars, HistoryMessage };

export interface AssembleResult {
  text: string;
  usage: NormalizedUsage;
  /** The model identifier used for this request (useful for telemetry). */
  model: string;
}

export interface AssembleExecutionOpts {
  /** Pre-loaded prior messages (skips DB load when provided). */
  priorMessages?: HistoryMessage[];
  /**
   * Mutable agentic context. Tool handlers write side-channel results back to
   * ctx (ctx.modifyResult, ctx.analyzeResult, ctx.reviewResult). The caller
   * reads these AFTER assembleRequest() returns.
   * When omitted a minimal context is constructed from requestId + endpoint.
   */
  ctx?: LlmAgenticContext;
  temperature?: number;
  maxOutputTokens?: number;
  requestId?: string | null;
  endpoint?: string;
  /** Streaming callback — invoked per text delta for OpenRouter streaming. */
  onTextDelta?: (chars: number, totalChars: number) => void;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Assemble and execute an LLM request for a named flow.
 *
 * @param flow           - Flow name: "generate" | "modify" | "analyze" | "suggest" |
 *                         "gap" | "weekly" | "chat" | "summary" | string
 * @param vars           - Per-flow input variables (currentSpec, serializedData, etc.)
 * @param conversationId - Conversation ID for history loading (null → no history)
 * @param userMessage    - The user message to append to history
 * @param opts           - Execution options (ctx, temperature, tokens, streaming)
 */
export async function assembleRequest(
  flow: string,
  vars: FlowVars,
  conversationId: string | null,
  userMessage: string,
  opts?: AssembleExecutionOpts,
): Promise<AssembleResult> {
  // 1. Build system prompt
  const { stable, volatile } = buildSystemPrompt(flow, vars);

  // 2. Load history (capped; summarisation routes through this flow's model)
  const history = await buildHistory(conversationId, {
    priorMessages: opts?.priorMessages,
    flow,
  });

  // 3. Resolve execution config
  const cfg = loadDashboardLlmConfig();
  const model = getEffectiveDashboardModel(cfg, flow as Parameters<typeof getEffectiveDashboardModel>[1]);
  const openRouterProvider = getEffectiveOpenRouterProvider(cfg, flow as Parameters<typeof getEffectiveOpenRouterProvider>[1]);

  const requestId = opts?.requestId ?? null;
  const endpoint = opts?.endpoint ?? flow;
  const temperature = opts?.temperature ?? 0.2;
  const maxOutputTokens = opts?.maxOutputTokens ?? 8192;

  // Normalise prior messages for OpenRouter/agentic runner
  const priorMessages: ChatCompletionMessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // 4. Resolve tools + the exact system prompt that will be sent. Single-shot
  // flows (suggest/gap/summary/title/weekly) return [] from toolsForFlow and
  // must stay on the llmComplete path to preserve strict JSON-only outputs.
  const tools = toolsForFlow(flow);
  const fullSystemPrompt = volatile ? `${stable}\n\n${volatile}` : stable;

  // Surface the exact request being sent to the LLM (system prompt + tools) so
  // the conversation UI can render "Contexto original" and persist it for resume.
  // This is the single capture point now that every flow routes through
  // assembleRequest — callers wire ctx.onSystemPromptReady to emit/persist a
  // "context" turn event. Must run for BOTH execution paths and never throw.
  if (opts?.ctx?.onSystemPromptReady) {
    const toolSchemas = tools
      .filter(
        (t): t is Extract<ChatCompletionTool, { type: "function" }> =>
          t.type === "function",
      )
      .map((t) => ({
        name: t.function.name,
        schema: t.function as unknown as Record<string, unknown>,
      }));
    try {
      opts.ctx.onSystemPromptReady(fullSystemPrompt, toolSchemas);
    } catch {
      /* context emission is best-effort — never break the LLM call */
    }
  }

  // 5. Execute — only route through agentic when the flow has tools.
  if (isAgenticToolsEnabled() && tools.length > 0) {
    const adapter = createDashboardAgenticAdapter();

    // Build the ctx, falling back to a minimal one if the caller didn't provide it
    const agenticCtx: LlmAgenticContext = opts?.ctx ?? {
      requestId: requestId ?? "req_local",
      endpoint: endpoint as LlmAgenticContext["endpoint"],
    };

    // Wire provider info into ctx (same as the old attachTelemetry pattern)
    agenticCtx.llmProvider = cfg.provider;
    agenticCtx.llmDriver = cfg.provider === "cli" ? cfg.cliDriver : null;

    // Build system message with prompt caching support (OpenRouter)
    const cachedMsg =
      cfg.provider === "openrouter"
        ? buildCachedSystemMessage(stable, volatile)
        : undefined;

    const { content, usage } = await callWithCircuitBreaker(() =>
      runAgenticChat({
        adapter,
        model,
        openRouterProvider,
        systemPrompt: fullSystemPrompt,
        cachedSystemMessage: cachedMsg,
        userContent: userMessage,
        ctx: agenticCtx,
        temperature,
        maxTokens: maxOutputTokens,
        priorMessages,
        tools,
      }),
    );

    // Normalise AgenticUsageTotals → NormalizedUsage
    const normalizedUsage: NormalizedUsage = {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
    };

    return { text: content, usage: normalizedUsage, model };
  }

  // Non-agentic path: single-shot llmComplete
  const onTextDelta = opts?.onTextDelta;

  // Emit model_step_start via ctx if available and onAgenticProgress is set
  if (opts?.ctx?.onAgenticProgress) {
    try {
      opts.ctx.onAgenticProgress({
        type: "model_step_start",
        round: 1,
        provider: cfg.provider,
        driver: cfg.provider === "cli" ? cfg.cliDriver : null,
      } as AgenticProgressEvent);
    } catch {
      /* ignore */
    }
  }

  const resp = await llmComplete({
    flow,
    systemPrompt: { stable, volatile },
    messages: [...history, { role: "user" as const, content: userMessage }],
    temperature,
    maxOutputTokens,
    requestId,
    endpoint,
    onTextDelta: onTextDelta
      ? onTextDelta
      : opts?.ctx?.onAgenticProgress
        ? (chars: number, totalChars: number) => {
            try {
              opts.ctx!.onAgenticProgress!({
                type: "model_text_delta",
                round: 1,
                chars,
                totalChars,
                text: "",
              } as AgenticProgressEvent);
            } catch {
              /* ignore */
            }
          }
        : undefined,
  });

  return { text: resp.text, usage: resp.usage, model };
}
