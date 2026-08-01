/**
 * Serialize OpenAI-style chat messages into a plain-text transcript for CLI rounds.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

function block(tag: string, body: string): string {
  return `### ${tag}\n${body.trim()}\n`;
}

export function serializeChatMessagesForCli(messages: ChatCompletionMessageParam[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system" && typeof m.content === "string") {
      parts.push(block("system", m.content));
    } else if (m.role === "user" && typeof m.content === "string") {
      parts.push(block("user", m.content));
    } else if (m.role === "assistant") {
      const c =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? JSON.stringify(m.content)
            : "";
      const tools =
        "tool_calls" in m && Array.isArray(m.tool_calls)
          ? `\n(tool_calls JSON)\n${JSON.stringify(m.tool_calls, null, 2)}`
          : "";
      parts.push(block("assistant", `${c}${tools}`));
    } else if (m.role === "tool") {
      const id = "tool_call_id" in m ? String(m.tool_call_id ?? "") : "";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      parts.push(block(`tool_result id=${id}`, content));
    } else {
      parts.push(block(String(m.role), JSON.stringify(m)));
    }
  }
  return parts.join("\n");
}
