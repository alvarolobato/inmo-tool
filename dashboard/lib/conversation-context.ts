/**
 * Free-chat conversation context helpers.
 *
 * Builds the system prompt and tool catalog for free-chat conversations
 * (`context_kind='global'`) via `buildFreeChatContext()`, and the
 * InitialContext snapshot persisted at conversation creation.
 *
 * History loading/capping for ALL conversation flows lives in
 * `@/lib/llm-context/history` (buildHistory / capHistory) — the legacy
 * loadPriorTurns/summariseOldTurns helpers were removed together with the
 * retired /api/dashboard/{modify,analyze} routes.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { getAgenticConfig } from "@/lib/llm-tools/config";
import { buildSystemPrompt, toolsForFlow } from "@/lib/llm-context";
import { loadDashboardLlmConfig, getEffectiveDashboardModel } from "@/lib/llm-provider/config";
import type { InitialContext } from "@/lib/conversation-types";

export interface FreeChatContext {
  systemPrompt: { stable: string };
  tools: ChatCompletionTool[];
}

/**
 * Build the system prompt and tool catalog for a free-chat conversation
 * (`context_kind='global'`).
 *
 * Delegates to the `chat` flow's builders rather than assembling a second
 * prompt of its own: this snapshot is shown to the user as "Contexto original",
 * so if it drifted from what assembleRequest actually sends, the UI would be
 * lying about the request. One source of truth, per #24.
 */
export function buildFreeChatContext(): FreeChatContext {
  const { stable } = buildSystemPrompt("chat", {});
  return {
    systemPrompt: { stable },
    tools: toolsForFlow("chat"),
  };
}

/**
 * Build the InitialContext snapshot for a free-chat conversation. Called at
 * creation time (POST /api/conversations). The legacy fallback on the
 * messages endpoint is gone — that route was removed (issue #831).
 */
export function buildFreeChatInitialContextSnapshot(): InitialContext {
  const freeChatCtx = buildFreeChatContext();
  const cfg = loadDashboardLlmConfig();
  const agenticCfg = getAgenticConfig();
  return {
    model: getEffectiveDashboardModel(cfg),
    provider: cfg.provider,
    driver: cfg.provider === "cli" ? cfg.cliDriver : null,
    system_prompt_stable: freeChatCtx.systemPrompt.stable,
    tools: freeChatCtx.tools
      .filter((t): t is Extract<ChatCompletionTool, { type: "function" }> => t.type === "function")
      .map((t) => ({
        name: t.function.name,
        schema: t.function as unknown as Record<string, unknown>,
      })),
    config: {
      flow: "chat",
      tool_rounds_max: agenticCfg.maxToolRounds,
      tool_calls_max: agenticCfg.maxToolCalls,
      tool_timeout_ms: agenticCfg.toolTimeoutMs,
    },
  };
}
