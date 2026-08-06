/**
 * Tool catalog lookup by flow.
 *
 * Only `chat` gets tools. The single-shot assessment flows (occupancy,
 * condition, redflags, location, extract, compare) are structured-output tasks: they
 * read a listing the caller already loaded and return a fixed JSON shape.
 * Handing them a tool loop would add rounds, cost and non-determinism to a task
 * that has none of the ambiguity a tool loop exists to resolve.
 *
 * Because `toolsForFlow()` returns `[]` for those flows, assemble.ts routes
 * them down the single-shot `llmComplete` path automatically — the tool
 * catalog *is* the switch between the two execution paths.
 */

import { CHAT_TOOLS } from "@/lib/llm-tools/catalog";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { SINGLE_SHOT_FLOWS } from "./types";

/**
 * Return the tool catalog for a given LLM flow.
 *
 * - "chat" → CHAT_TOOLS (read-only data inspection + set_title)
 * - every assessment flow → [] (single-shot, no tools)
 * - unknown flow → [] (fail closed: an unrecognised flow must not silently
 *   inherit a tool catalog it was never reviewed against)
 */
export function toolsForFlow(flow: string): ChatCompletionTool[] {
  if (flow === "chat") return CHAT_TOOLS;
  if (SINGLE_SHOT_FLOWS.has(flow)) return [];
  return [];
}
