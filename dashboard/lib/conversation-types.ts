/**
 * Shared TypeScript types for the conversations feature.
 *
 * These types match the shape returned by /api/conversations and
 * /api/conversations/:id routes (built by Task 2, issue #537).
 */

import type { AgenticErrorDiagnostic } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Core conversation types
// ---------------------------------------------------------------------------

export type ConversationMode =
  | "generate"
  | "modify"
  | "analyze"
  | "suggest"
  | "gap"
  | "summary"
  | "title"
  | string;

export type ContextKind = "dashboard" | "home" | "admin" | "global";

export interface InitialContext {
  model: string;
  provider: string;
  driver?: string | null;
  seed_prompt?: string | null;
  system_prompt_stable?: string;
  system_prompt_volatile?: string;
  tools?: Array<{ name: string; schema: Record<string, unknown> }>;
  prior_messages?: number;
  prior_messages_history?: Array<{ role: string; content: string }>;
  config?: {
    flow?: string;
    maxOutputTokens?: number;
    tool_rounds_max?: number;
    tool_calls_max?: number;
    tool_timeout_ms?: number;
    [key: string]: unknown;
  };
}

export interface Conversation {
  id: string;
  mode: ConversationMode;
  title: string | null;
  first_user_prompt: string | null;
  context_url: string | null;
  context_kind: ContextKind;
  context_ref: string | null;
  created_at: string;
  last_interaction_at: string;
  archived_at: string | null;
  last_status: "ok" | "error" | null;
  llm_provider: string | null;
  llm_driver: string | null;
  initial_context: InitialContext | null;
  last_read_at: string | null;
}

// ---------------------------------------------------------------------------
// Message content types
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  duration_ms?: number;
  success?: boolean;
}

export interface AssistantMessageContent {
  text?: string;
  tool_calls?: ToolCallRecord[];
  is_error?: boolean;
  error_detail?: AgenticErrorDiagnostic;
  /** Agentic round number this message belongs to (1-based). */
  round?: number;
  /**
   * Final extended-thinking text for the turn that produced this message.
   * Persisted here (durable) because the transient `thinking` turn_events are
   * pruned once a turn completes — see pruneStreamEvents / issue #825.
   */
  thinking?: string;
}

export type MessageContent =
  | AssistantMessageContent
  | { tool_call_id: string; tool_name: string; content: unknown }
  | string; // legacy: older persisted rows may have been stored as plain strings

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "tool";
  content: MessageContent;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_creation?: number | null;
  logs?: unknown[] | null;
  created_at: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: ConversationMessage[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getConversationDisplayTitle(conv: Pick<Conversation, "title" | "first_user_prompt">): string {
  return (
    conv.title?.trim() ||
    (conv.first_user_prompt ? conv.first_user_prompt.slice(0, 60) : "Sin título")
  );
}

export function isAssistantContent(content: MessageContent): content is AssistantMessageContent {
  // Must not have tool_call_id (that marks a tool-result message, not an assistant turn).
  return (
    typeof content === "object" &&
    content !== null &&
    !("tool_call_id" in content) &&
    ("text" in content || "tool_calls" in content || "is_error" in content)
  );
}

export function isToolResultContent(
  content: MessageContent,
): content is { tool_call_id: string; tool_name: string; content: unknown } {
  return (
    typeof content === "object" &&
    content !== null &&
    "tool_call_id" in content
  );
}

export function getMessageText(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (isAssistantContent(content)) return content.text ?? "";
  return "";
}
