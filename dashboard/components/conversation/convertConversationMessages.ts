import {
  isAssistantContent,
  getMessageText,
} from "@/lib/conversation-types";
import type { MessageContent } from "@/lib/conversation-types";
import type { ChatMessage, ConversationApiMessage } from "./types";

/**
 * Convert raw API conversation messages to the simplified ChatMessage format
 * used by ChatSidebar tabs.
 *
 * Tool-role messages are filtered out; only user and assistant turns are kept.
 */
export function convertConversationMessages(
  messages: ConversationApiMessage[],
): ChatMessage[] {
  return messages
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .map((msg) => {
      const content = msg.content as MessageContent;
      const ac =
        msg.role === "assistant" && isAssistantContent(content) ? content : null;
      const isError = ac?.is_error ?? false;
      return {
        role: msg.role as "user" | "assistant",
        content:
          getMessageText(content) ||
          (isError ? "Error en la respuesta del asistente" : ""),
        timestamp: new Date(msg.created_at),
        isError,
        ...(Array.isArray(msg.logs) && msg.logs.length > 0 ? { logs: msg.logs as import("@/components/LogBlock").LogLine[] } : {}),
      };
    })
    .filter((msg) => msg.content.length > 0);
}
