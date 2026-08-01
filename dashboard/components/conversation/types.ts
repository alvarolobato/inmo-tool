/**
 * Shared types for the conversation components.
 * ChatMessage is the simplified in-memory format used by ChatSidebar tabs.
 */

import type { ApiErrorResponse } from "@/lib/errors";
import type { LogLine } from "@/components/LogBlock";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  /** Structured error detail attached to an assistant error message. */
  errorDetail?: ApiErrorResponse;
  /** True when this assistant message is an error (even without structured details). */
  isError?: boolean;
  /** Log lines captured during the API call that produced this message. */
  logs?: LogLine[];
  /**
   * Short summary from the publish tool (apply_dashboard_modification or
   * submit_dashboard_analysis). When present, a compact "Cambios aplicados"
   * chip is rendered below the chat bubble.
   */
  appliedSummary?: string;
  /**
   * Label for the chip shown when appliedSummary is set.
   * Defaults to "Cambios aplicados" for modify, "Análisis publicado" for analyze.
   */
  appliedChipLabel?: string;
}

/** Raw message shape returned by GET /api/conversations/:id */
export interface ConversationApiMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "tool";
  content: unknown; // JSONB: string | { text?: string } | { type: string; text?: string }[]
  logs?: unknown[] | null;
  created_at: string;
}
