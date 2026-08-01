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
import { FREE_CHAT_TOOLS } from "@/lib/llm-tools/catalog";
import { getAgenticConfig } from "@/lib/llm-tools/config";
import { buildStableKnowledgePart } from "@/lib/prompts";
import { loadDashboardLlmConfig, getEffectiveDashboardModel } from "@/lib/llm-provider/config";
import type { InitialContext } from "@/lib/conversation-types";

export interface FreeChatContext {
  systemPrompt: { stable: string };
  tools: ChatCompletionTool[];
}

const FREE_CHAT_PREAMBLE =
  "Eres un asistente analítico de PowerShop Analytics. " +
  "Tienes acceso a herramientas para inspeccionar el modelo de datos, ejecutar consultas de solo lectura y explorar dashboards guardados. " +
  "Cuando el usuario pida crear un dashboard, usa la herramienta `start_dashboard_generation`. " +
  "En tu primera respuesta de cada conversación nueva, llama a la herramienta `set_title` con un título conciso de 5-7 palabras en español que resuma el tema.\n\n";

/**
 * Build the system prompt and tool catalog for a free-chat conversation
 * (context_kind='global'). Returns the stable knowledge bundle prefixed with
 * a Spanish preamble plus the FREE_CHAT_TOOLS catalog.
 */
export function buildFreeChatContext(): FreeChatContext {
  return {
    systemPrompt: { stable: FREE_CHAT_PREAMBLE + buildStableKnowledgePart() },
    tools: FREE_CHAT_TOOLS,
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
