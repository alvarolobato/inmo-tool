/**
 * History assembly for LLM requests.
 *
 * Loads prior conversation turns and flattens them to `{ role, content }` lines.
 * Tool calls an assistant turn made are folded into that turn as a compact block
 * (`flattenStoredMessage` / `formatToolCallsForHistory`) so the tool context — the
 * query and its truncated result — is preserved for later turns.
 */

import { loadMessages } from "@/lib/conversations";
import type { ToolCallRecord } from "@/lib/conversation-types";
import {
  loadDashboardLlmConfig,
  getEffectiveDashboardModel,
  getEffectiveOpenRouterProvider,
} from "@/lib/llm-provider/config";
import { getOpenRouterClient, openRouterChatCompletion } from "@/lib/llm-provider/openrouter";
import { claudeCliSingleShot } from "@/lib/llm-provider/cli/claude-code";
import { callWithCircuitBreaker } from "@/lib/llm-circuit-breaker";
import { logUsage } from "@/lib/llm-usage";

export type HistoryMessage = { role: "user" | "assistant"; content: string };

/** Max chars kept per tool result when folding it into history (the "interesting part"). */
const HISTORY_TOOL_RESULT_MAX = 600;
/** Max chars kept per tool argument string when folding it into history. */
const HISTORY_TOOL_ARGS_MAX = 240;
/**
 * Max prior messages sent to the LLM per request. When a conversation exceeds
 * this, older messages are summarised into one synthetic assistant message
 * (see capHistory). Same cap the retired /api/dashboard/{modify,analyze}
 * routes applied via loadPriorTurns.
 */
export const HISTORY_MAX_MESSAGES = 10;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

function compactArgs(args: unknown): string {
  let s: string;
  if (typeof args === "string") s = args;
  else {
    try {
      s = JSON.stringify(args);
    } catch {
      s = String(args);
    }
  }
  return truncate(s.replace(/\s+/g, " ").trim(), HISTORY_TOOL_ARGS_MAX);
}

function compactResult(result: unknown): string {
  if (result === undefined || result === null) return "(sin resultado)";
  const s = typeof result === "string" ? result : (() => {
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  })();
  return truncate(s.replace(/\s+/g, " ").trim(), HISTORY_TOOL_RESULT_MAX);
}

/**
 * Render the tool calls an assistant turn made into a compact, readable block so
 * later turns retain the "interesting part" — which tool ran, with what args, and
 * the (truncated) result the model saw. Returns "" when there are no tool calls.
 */
export function formatToolCallsForHistory(toolCalls: ToolCallRecord[]): string {
  if (!toolCalls || toolCalls.length === 0) return "";
  const lines = toolCalls.map((tc) => {
    const status = tc.success === false ? " [error]" : "";
    return `- ${tc.name}(${compactArgs(tc.arguments)})${status} → ${compactResult(tc.result)}`;
  });
  return `[Datos consultados con herramientas en esta respuesta]\n${lines.join("\n")}`;
}

/**
 * Flatten a stored conversation_messages row to a single history line for the LLM,
 * or null to skip it. User/assistant text is extracted from the JSONB content;
 * tool calls recorded on an assistant message are folded in as a compact block so
 * the conversational context (including tool results) is preserved across turns.
 * Standalone tool-role rows are skipped — tool context lives on the assistant row.
 */
export function flattenStoredMessage(row: {
  role: string;
  content: unknown;
}): HistoryMessage | null {
  if (row.role !== "user" && row.role !== "assistant") return null;

  const c = row.content;
  let text = "";
  let toolCalls: ToolCallRecord[] | undefined;

  if (typeof c === "string") {
    text = c;
  } else if (c !== null && typeof c === "object" && !Array.isArray(c)) {
    const obj = c as Record<string, unknown>;
    let recognized = false;
    if (typeof obj.text === "string") {
      text = obj.text;
      recognized = true;
    }
    if (Array.isArray(obj.tool_calls)) {
      toolCalls = obj.tool_calls as ToolCallRecord[];
      recognized = true;
    }
    // Only stringify genuinely unknown content shapes — an object with a known
    // (but empty) text field is an empty turn, which we skip below.
    if (!recognized) text = JSON.stringify(c);
  } else {
    text = JSON.stringify(c);
  }

  if (row.role === "assistant" && toolCalls && toolCalls.length > 0) {
    const block = formatToolCallsForHistory(toolCalls);
    text = text ? `${block}\n\n${text}` : block;
  }

  if (!text) return null;
  return { role: row.role as "user" | "assistant", content: text };
}

/**
 * Build conversation history for an LLM request, capped at
 * HISTORY_MAX_MESSAGES (older messages summarised — see capHistory).
 *
 * Priority:
 * 1. If `opts.priorMessages` is provided, cap and return them (caller pre-loaded).
 * 2. If `conversationId` is provided, load from DB, flatten, cap.
 * 3. Otherwise return [].
 *
 * Flattening: extracts `.text` from JSONB content objects, falls back to JSON.stringify.
 * Tool calls recorded on an assistant message are folded into that turn as a compact
 * block (see `flattenStoredMessage`) so tool results persist as context across turns.
 */
export async function buildHistory(
  conversationId: string | null,
  opts?: { priorMessages?: HistoryMessage[]; flow?: string },
): Promise<HistoryMessage[]> {
  if (opts?.priorMessages) return capHistory(opts.priorMessages, HISTORY_MAX_MESSAGES, opts.flow);
  if (!conversationId) return [];

  const rows = await loadMessages(conversationId);
  const messages: HistoryMessage[] = [];

  for (const row of rows) {
    const flat = flattenStoredMessage(row);
    if (flat) messages.push(flat);
  }

  return capHistory(messages, HISTORY_MAX_MESSAGES, opts?.flow);
}

// ── History capping + summarisation ───────────────────────────────────────────

/** Max chars of older user prompts fed to the summarisation LLM call (and used
 *  verbatim as the fallback summary). Keeps the bounding call itself bounded. */
const SUMMARY_INPUT_MAX_CHARS = 4_000;

/**
 * Bound the history sent to the LLM. When `messages` exceeds `maxMessages`,
 * the older ones are summarised (small LLM call) into a single synthetic
 * assistant message followed by the (maxMessages - 1) most recent messages.
 * No-op (and no LLM call) when the history is within the cap — callers may
 * invoke this redundantly without cost.
 *
 * `flow` routes the summarisation call through the same per-flow model/provider
 * overrides as the parent request (see getEffectiveDashboardModel).
 */
export async function capHistory(
  messages: HistoryMessage[],
  maxMessages: number = HISTORY_MAX_MESSAGES,
  flow?: string,
): Promise<HistoryMessage[]> {
  if (messages.length <= maxMessages) return messages;
  if (maxMessages < 2) return maxMessages <= 0 ? [] : messages.slice(-1);

  const recentCount = maxMessages - 1;
  const oldMessages = messages.slice(0, messages.length - recentCount);
  const recentMessages = messages.slice(messages.length - recentCount);

  const summary = await buildSummary(oldMessages, flow);
  return [
    {
      role: "assistant",
      content: `Earlier in this conversation the user requested: ${summary}`,
    },
    ...recentMessages,
  ];
}

/**
 * Summarise older user requests via a small LLM call. Falls back to the
 * (bounded) raw user prompts when the LLM call fails — capping must never make
 * a turn fail. Input is whitespace-normalised and capped at
 * SUMMARY_INPUT_MAX_CHARS (most recent prompts win) so the summarisation
 * request stays small regardless of conversation length.
 */
async function buildSummary(messages: HistoryMessage[], flow?: string): Promise<string> {
  // Most recent old prompts are the most relevant — accumulate from the end
  // until the char budget is spent, then restore chronological order.
  const bullets: string[] = [];
  let budget = SUMMARY_INPUT_MAX_CHARS;
  const userMessages = messages.filter((m) => m.role === "user");
  for (let i = userMessages.length - 1; i >= 0 && budget > 0; i--) {
    const line = `- ${userMessages[i].content.replace(/\s+/g, " ").trim().slice(0, 200)}`;
    bullets.push(line);
    budget -= line.length + 1;
  }
  const userPrompts = bullets.reverse().join("\n");

  const prompt = `Summarise the following prior user requests in a short bulleted list (one line each, max 300 chars total). Respond with only the bullet list, no preamble.\n\n${userPrompts}`;

  const cfg = loadDashboardLlmConfig();
  const flowArg = flow as Parameters<typeof getEffectiveDashboardModel>[1];
  const model = getEffectiveDashboardModel(cfg, flowArg);
  const provider = getEffectiveOpenRouterProvider(cfg, flowArg);

  if (cfg.provider === "cli") {
    try {
      return await callWithCircuitBreaker(() => claudeCliSingleShot({ cfg, prompt }));
    } catch {
      return userPrompts;
    }
  }

  try {
    const client = getOpenRouterClient();
    const { content, usage } = await callWithCircuitBreaker(() =>
      openRouterChatCompletion({
        client,
        model,
        messages: [{ role: "user" as const, content: prompt }],
        temperature: 0.1,
        maxTokens: 200,
        provider,
      }),
    );
    if (usage) {
      logUsage("dashboard/history/summarise", model, {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      });
    }
    return content || userPrompts;
  } catch {
    return userPrompts;
  }
}
