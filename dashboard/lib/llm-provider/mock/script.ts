/**
 * Scripted mock LLM — deterministic responses for e2e tests (DASHBOARD_LLM_PROVIDER=mock).
 *
 * Unlike `e2e-stub` (which short-circuits turn-background.ts BEFORE any LLM
 * code runs and returns a canned string), the mock provider flows through the
 * ENTIRE real pipeline: assembleRequest → buildSystemPrompt → runAgenticChat →
 * tool dispatch (real SQL against the seeded Postgres) → persistence. Only the
 * network call to the model is replaced.
 *
 * The script is driven off the assembled system prompt so the mock emits what
 * each flow's caller expects:
 *   - chat        → one execute_query round, then prose embedding the result
 *   - assessments → a single-shot JSON object matching that flow's schema
 *
 * Determinism: no randomness, no time — same input → same output, so e2e
 * assertions are stable.
 *
 * #24 replaced the dashboard flows (generate/modify/analyze) and their terminal
 * publish tools with the real-estate assessment flows; this script follows.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AgenticStepResult } from "@/lib/llm-tools/runner-types";

export type MockFlow =
  | "occupancy"
  | "condition"
  | "redflags"
  | "extract"
  | "compare"
  | "chat";

/** A query that returns exactly one row against the e2e seed (and prod). */
export const MOCK_PROBE_SQL = "SELECT COUNT(*) AS n FROM listing";

/**
 * Detect the flow from the assembled system prompt.
 *
 * Keys off each flow's unique task heading, NOT tool names: when agentic tools
 * are enabled every flow's prompt can mention the same tool catalog, so
 * matching tool names misclassifies. The headings come from
 * llm-context/system-prompt.ts and are unique per flow.
 */
export function detectMockFlow(systemPromptText: string): MockFlow {
  // Coupled to buildOccupancyPrompt's heading in llm-context/system-prompt.ts.
  // It stopped saying "estado de ocupación" in #145, when the flow widened from
  // occupancy alone to occupancy + venta de deuda + venta parcial.
  if (systemPromptText.includes("Tarea: ¿qué se compra exactamente"))
    return "occupancy";
  if (systemPromptText.includes("Tarea: estado de conservación")) return "condition";
  if (systemPromptText.includes("Tarea: señales de alerta")) return "redflags";
  if (systemPromptText.includes("Tarea: extracción de campos")) return "extract";
  if (systemPromptText.includes("Tarea: comparativa de candidatos")) return "compare";
  return "chat";
}

/** Canned, schema-shaped JSON answer per assessment flow. */
function mockAssessmentJson(flow: Exclude<MockFlow, "chat">): string {
  switch (flow) {
    case "occupancy":
      // Three independent axes since #145. Kept as the clean/default case so
      // e2e assertions stay simple; the interesting combinations are unit-
      // tested against parseOccupancyResult rather than driven through here.
      return JSON.stringify({
        occupancy: {
          status: "vacant",
          confidence: 0.9,
          evidence: "se entrega libre de inquilinos",
          // #25 keys assessments on the property and feeds the model every
          // merged listing, so a verdict has to name which advert it read.
          evidence_source: "fotocasa",
        },
        transaction: {
          kind: "compraventa",
          confidence: 0.7,
          evidence: "",
          evidence_source: null,
        },
        ownership: {
          extent: "pleno_dominio",
          share_pct: null,
          confidence: 0.7,
          evidence: "",
          evidence_source: null,
        },
        reasoning: "El anuncio indica entrega libre (mock e2e).",
      });
    case "condition":
      return JSON.stringify({
        condition: "reformado",
        confidence: 0.8,
        issues: [],
        evidence: "reformado en 2023",
        // #25 keys assessments on the property and feeds the model every
        // merged listing (#26 followed occupancy's pattern), so a verdict
        // has to name which advert it read.
        evidence_source: "fotocasa",
        reasoning: "El anuncio menciona una reforma reciente (mock e2e).",
      });
    case "redflags":
      return JSON.stringify({
        flags: [],
        confidence: 0.7,
        reasoning: "El anuncio no menciona ninguna señal de alerta (mock e2e).",
      });
    case "extract":
      // Schema per #28's real prompt (system-prompt.ts's buildExtractPrompt):
      // per-field confidence, not one scalar — see that file's doc for why.
      return JSON.stringify({
        m2_built: 90,
        m2_useful: null,
        rooms: 3,
        bathrooms: 2,
        floor: "3",
        has_elevator: true,
        confidence_per_field: {
          m2_built: 0.85,
          rooms: 0.9,
          bathrooms: 0.9,
          floor: 0.7,
          has_elevator: 0.8,
        },
        reasoning: "El anuncio da metros, habitaciones, baños, planta y ascensor (mock e2e).",
      });
    case "compare":
      return JSON.stringify({
        ranking: [
          { property_id: 1, rank: 1, rationale: "Mejor precio por m² (mock e2e)." },
          { property_id: 2, rank: 2, rationale: "Más caro a igualdad de estado (mock e2e)." },
        ],
        dimensions: [
          { name: "precio_por_m2", verdict: "El candidato 1 es más barato por m²." },
        ],
        caveats: ["Datos simulados por el proveedor mock."],
        confidence: 0.6,
      });
  }
}

/** Number of tool-result messages already in the transcript = completed rounds. */
function completedToolRounds(messages: ChatCompletionMessageParam[]): number {
  return messages.filter((m) => m.role === "tool").length;
}

/** Concatenate every system message's text so detectMockFlow can scan it. */
export function systemPromptTextOf(messages: ChatCompletionMessageParam[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** Pull the COUNT(*) value back out of the execute_query tool result.
 *  Scans ALL tool messages (newest first). Handles both result shapes: row
 *  objects (`"n":"6284"`) and the tool payload's columns/rows arrays
 *  (`"rows":[["6284"]]`). */
function probeResultValue(messages: ChatCompletionMessageParam[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const objMatch = raw.match(/"n"\s*:\s*"?(\d+)"?/);
    if (objMatch) return objMatch[1];
    const rowsMatch = raw.match(/"rows"\s*:\s*\[\s*\[\s*"?(\d+)"?/);
    if (rowsMatch) return rowsMatch[1];
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
 * Decide the mock model's next step given the running transcript.
 * Single source of truth shared by the agentic adapter (runStep) and
 * llmComplete's single-shot mock path.
 */
export function mockRunStep(messages: ChatCompletionMessageParam[]): AgenticStepResult {
  const sys = systemPromptTextOf(messages);
  const flow = detectMockFlow(sys);

  // Assessment flows are single-shot by construction (toolsForFlow returns [])
  // so they never reach the agentic loop — but answer correctly if called
  // directly, since mockSingleShotText delegates here.
  if (flow !== "chat") {
    return finalText(mockAssessmentJson(flow));
  }

  // chat, round 0: probe the real database so the tool path is genuinely
  // exercised against the seeded schema.
  if (completedToolRounds(messages) === 0) {
    return nextToolCall("execute_query", { sql: MOCK_PROBE_SQL });
  }

  // chat, round ≥1: prose embedding the real probe result, proving the tool
  // executed against the seeded database.
  const n = probeResultValue(messages);
  return finalText(
    n !== null
      ? `Hay ${n} anuncios en el sistema.`
      : "Listo. He completado la acción solicitada.",
  );
}

/** Single-shot mock text (title generation, assessments, etc.). */
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
