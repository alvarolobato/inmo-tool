/**
 * Scripted mock LLM — deterministic responses for e2e tests (DASHBOARD_LLM_PROVIDER=mock).
 *
 * Unlike `e2e-stub` (which short-circuits turn-background.ts BEFORE any LLM
 * code runs and returns a canned string), the mock provider flows through the
 * ENTIRE real pipeline: assembleRequest → buildSystemPrompt → runAgenticChat →
 * tool dispatch (real SQL against the seeded Postgres) → spec validation →
 * versioned persistence. Only the network call to the model is replaced.
 *
 * The script is driven off the assembled system prompt so the mock emits the
 * terminal action each flow's handler expects:
 *   - chat     → one execute_query round, then a prose answer embedding the result
 *   - modify   → execute_query, then apply_dashboard_modification with a valid spec
 *   - analyze  → execute_query, then submit_dashboard_analysis
 *   - generate → a valid JSON dashboard spec as the final message
 *   - other    → a short prose answer (covers title generation, etc.)
 *
 * Determinism: no randomness, no time — same input → same output, so e2e
 * assertions are stable.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AgenticStepResult } from "@/lib/llm-tools/runner-types";

export type MockFlow = "modify" | "analyze" | "generate" | "chat";

/** A query that returns exactly one row against the e2e seed (and prod). */
export const MOCK_PROBE_SQL = "SELECT COUNT(*) AS n FROM ps_ventas";

/** A minimal Zod-valid dashboard spec whose widget runs against seeded data. */
export function mockDashboardSpec(title: string): Record<string, unknown> {
  return {
    title,
    description: "Generado por el proveedor LLM simulado (e2e).",
    widgets: [
      {
        type: "kpi_row",
        items: [
          {
            label: "Ventas registradas",
            sql: "SELECT COUNT(*) AS value FROM ps_ventas",
            format: "number",
          },
        ],
      },
    ],
  };
}

/**
 * Detect the flow from the assembled system prompt. Keys off each flow's unique
 * ROLE sentence, NOT tool names: when agentic tools are enabled the shared tool
 * preamble lists every tool (apply_dashboard_modification, submit_dashboard_analysis,
 * …) in every flow's prompt, so matching tool names misclassifies (e.g. generate
 * → modify → infinite tool loop). The role headers are unique per flow.
 */
export function detectMockFlow(systemPromptText: string): MockFlow {
  if (systemPromptText.includes("expert AI dashboard generator")) return "generate";
  if (systemPromptText.includes("expert AI dashboard modifier")) return "modify";
  if (systemPromptText.includes("analista de datos experto")) return "analyze";
  return "chat";
}

/** Concatenate every system message's text so detectMockFlow can scan it. */
export function systemPromptTextOf(messages: ChatCompletionMessageParam[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** Number of tool-result messages already in the transcript = completed rounds. */
function completedToolRounds(messages: ChatCompletionMessageParam[]): number {
  return messages.filter((m) => m.role === "tool").length;
}

/** Pull the COUNT(*) value back out of the execute_query tool result.
 *  Scans ALL tool messages (newest first) — in modify/analyze the most recent
 *  tool is the terminal one (apply_dashboard_modification / submit_dashboard_
 *  analysis), so we must keep looking past it to the earlier execute_query
 *  round. Handles both result shapes: row objects (`"n":"6284"`) and the tool
 *  payload's columns/rows arrays (`"rows":[["6284"]]`). */
function probeResultValue(messages: ChatCompletionMessageParam[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const objMatch = raw.match(/"n"\s*:\s*"?(\d+)"?/);
    if (objMatch) return objMatch[1];
    const rowsMatch = raw.match(/"rows"\s*:\s*\[\s*\[\s*"?(\d+)"?/);
    if (rowsMatch) return rowsMatch[1];
    // Not the probe result (e.g. an apply/submit ack) — keep scanning earlier rounds.
  }
  return null;
}

let mockCallId = 0;
function nextToolCall(name: string, args: Record<string, unknown>): AgenticStepResult {
  mockCallId += 1;
  return {
    kind: "tools",
    tool_calls: [
      {
        id: `mock_call_${mockCallId}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function finalText(content: string): AgenticStepResult {
  return {
    kind: "final",
    content,
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  };
}

/**
 * Decide the mock model's next step given the running transcript and tools.
 * This is the single source of truth shared by the agentic adapter (runStep)
 * and llmComplete's single-shot mock path.
 */
export function mockRunStep(messages: ChatCompletionMessageParam[]): AgenticStepResult {
  const sys = systemPromptTextOf(messages);
  const flow = detectMockFlow(sys);
  const rounds = completedToolRounds(messages);

  // generate: single-shot JSON spec, no tool round (the route parses the final).
  if (flow === "generate") {
    return finalText(JSON.stringify(mockDashboardSpec("Panel generado (e2e mock)")));
  }

  // Round 0: probe the real database so the tool path is genuinely exercised.
  if (rounds === 0) {
    return nextToolCall("execute_query", { sql: MOCK_PROBE_SQL });
  }

  // Round 1: emit each flow's terminal tool exactly once (modify/analyze stage
  // their result via the tool handler; the runner then asks for a final answer).
  if (rounds === 1 && flow === "modify") {
    return nextToolCall("apply_dashboard_modification", {
      spec: mockDashboardSpec("Panel modificado (e2e mock)"),
      change_summary: "He añadido un KPI con el total de ventas registradas.",
    });
  }
  if (rounds === 1 && flow === "analyze") {
    // Field names MUST match the submit_dashboard_analysis tool schema
    // (analysis_markdown / brief_summary) or the handler returns INVALID_ARGS
    // and nothing is staged — exactly the integration mismatch this mock exists
    // to catch.
    return nextToolCall("submit_dashboard_analysis", {
      analysis_markdown: "## Análisis (mock)\n\nLas ventas se mantienen estables esta semana.",
      brief_summary: "Ventas estables esta semana.",
    });
  }

  // Final answer (chat round 1, or modify/analyze round ≥2 after the terminal
  // tool ran): prose embedding the real probe result, proving the tool executed
  // against the seeded database.
  const n = probeResultValue(messages);
  return finalText(
    n !== null
      ? `Hay ${n} ventas registradas en el sistema.`
      : "Listo. He completado la acción solicitada.",
  );
}

/** Single-shot mock text (title generation, suggest/gap, etc.). */
export function mockSingleShotText(messages: ChatCompletionMessageParam[]): string {
  const sys = systemPromptTextOf(messages);
  if (sys.includes("título conciso")) return "Conversación de prueba e2e";
  const step = mockRunStep(messages);
  return step.kind === "final" ? step.content : "Respuesta simulada (mock).";
}

/** Reset the monotonic tool-call id (tests). */
export function __resetMockCallId(): void {
  mockCallId = 0;
}
