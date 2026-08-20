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
 *                   (`triage`, #542, is the one exception — its schema IS an
 *                   array, keyed by echoed `property_id`; see
 *                   `mockTriageJson`)
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
  | "triage"
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
  // #542 — condition/location/opportunity merged into one `triage` call.
  if (systemPromptText.includes("Tarea: triage combinado")) return "triage";
  if (systemPromptText.includes("Tarea: señales de alerta")) return "redflags";
  if (systemPromptText.includes("Tarea: extracción de campos")) return "extract";
  if (systemPromptText.includes("Tarea: comparativa de candidatos")) return "compare";
  return "chat";
}

/**
 * #542 — one `### INMUEBLE property_id=<id>` / `Ejes solicitados: <axes>`
 * block per property in `triage`'s volatile payload (`triageVolatile`,
 * `lib/llm-context/system-prompt.ts`). Extracted here so the mock can echo
 * the REAL requested id(s)/axes back — `parseTriageResponse` drops any entry
 * whose `property_id` doesn't match what was actually requested, so a
 * hard-coded id would break the mock the moment a test used a property id
 * other than the one that happened to be hard-coded.
 *
 * Also captures the FIRST real `DESCRIPCIÓN` snippet in that property's own
 * block, for the SAME reason: `triage.ts`'s evidence-substring guard
 * (`parseTriageArray`) blanks any evidence quote that isn't a literal
 * substring of the property's own listing text — a hard-coded phrase like
 * "reformado en 2023" would get blanked (correctly) against any real seeded
 * fixture that doesn't happen to contain it, silently degrading every
 * integration/e2e test's condition verdict to `unclear`. Copying real text
 * back verbatim keeps the mock's `condition` slice's evidence genuinely
 * citable, exactly like a real model quoting the ad.
 */
function mockTriageRequests(
  systemPromptText: string,
): Array<{ propertyId: number; axes: string[]; evidence: string }> {
  const requests: Array<{ propertyId: number; axes: string[]; evidence: string }> = [];
  // Split into one chunk per property block so a description snippet is never
  // borrowed from a DIFFERENT property when several are present (N-capable).
  const blocks = systemPromptText.split(/(?=### INMUEBLE property_id=)/g);
  for (const block of blocks) {
    const idMatch = /### INMUEBLE property_id=(\d+)/.exec(block);
    if (!idMatch) continue;
    const axesMatch = /Ejes solicitados: ([^\n]+)/.exec(block);
    const axesRaw = axesMatch ? axesMatch[1].trim() : "";
    const axes = axesRaw === "" || axesRaw === "(ninguno)" ? [] : axesRaw.split(",").map((a) => a.trim());
    const descMatch = /DESCRIPCIÓN \(texto libre del vendedor\):\s*\n"""\s*\n([\s\S]*?)\n"""/.exec(block);
    requests.push({ propertyId: Number(idMatch[1]), axes, evidence: descMatch ? descMatch[1].trim() : "" });
  }
  return requests;
}

/**
 * Canned, schema-shaped per-axis slice for `triage`'s merged output (#542).
 * `condition`'s `evidence` is filled in per-call by `mockTriageJson` (a real
 * substring of the property's own text — see `mockTriageRequests`'s doc for
 * why a fixed phrase here would get blanked by the evidence-substring
 * guard); this fallback phrase is used ONLY when no real description could
 * be extracted (e.g. a synthetic prompt built with no listings at all).
 */
const MOCK_TRIAGE_AXIS_JSON: Record<string, unknown> = {
  condition: {
    condition: "reformado",
    // #313: null because the mock verdict is `reformado`, not `a_reformar` —
    // severity only applies to `a_reformar`.
    renovation_severity: null,
    confidence: 0.8,
    issues: [],
    evidence: "reformado en 2023",
    // #25 keys assessments on the property and feeds the model every merged
    // listing (#26 followed occupancy's pattern), so a verdict has to name
    // which advert it read.
    evidence_source: "fotocasa",
    reasoning: "El anuncio menciona una reforma reciente (mock e2e).",
  },
  location: {
    beach_proximity: "none",
    beach_evidence: "",
    beach_evidence_source: null,
    heritage_zone: false,
    heritage_evidence: "",
    heritage_evidence_source: null,
    confidence: 0.6,
    reasoning: "El anuncio no menciona playa ni casco histórico (mock e2e).",
  },
  opportunity: {
    is_vpo: false,
    vpo_evidence: "",
    vpo_evidence_source: null,
    tourist_license: false,
    tourist_license_evidence: "",
    tourist_license_evidence_source: null,
    confidence: 0.6,
    reasoning: "El anuncio no menciona VPO ni licencia turística (mock e2e).",
  },
};

/**
 * `triage`'s output is a JSON ARRAY keyed by echoed `property_id` (#542), not
 * a single object like every other assessment flow — see
 * `lib/ai-assessment/triage.ts::parseTriageResponse`. Falls back to a single
 * `property_id: 0` entry answering all three axes when the prompt carries no
 * `### INMUEBLE` block at all (defensive — every real call has at least one).
 */
function mockTriageJson(systemPromptText: string): string {
  const requests = mockTriageRequests(systemPromptText);
  const effective: Array<{ propertyId: number; axes: string[]; evidence: string }> =
    requests.length > 0
      ? requests
      : [{ propertyId: 0, axes: ["condition", "location", "opportunity"], evidence: "" }];

  const array = effective.map(({ propertyId, axes, evidence }) => {
    const entry: Record<string, unknown> = { property_id: propertyId };
    for (const axis of axes) {
      if (axis !== "condition" && axis !== "location" && axis !== "opportunity") continue;
      const slice = MOCK_TRIAGE_AXIS_JSON[axis] as Record<string, unknown>;
      entry[axis] =
        axis === "condition"
          ? { ...slice, evidence: evidence || slice.evidence }
          : slice;
    }
    return entry;
  });
  return JSON.stringify(array);
}

/** Canned, schema-shaped JSON answer per assessment flow. */
function mockAssessmentJson(flow: Exclude<MockFlow, "chat">, systemPromptText: string): string {
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
    case "triage":
      return mockTriageJson(systemPromptText);
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
/**
 * Extract the real text out of one system message's `content`, whichever
 * shape the active provider built it in:
 *
 *   - a plain string — the CLI path (`buildMessagesPlain`, stable+volatile
 *     already concatenated with real newlines).
 *   - an array of `{type:"text", text, cache_control?}` blocks — the
 *     OpenRouter/mock path (`buildCachedSystemMessage`), used to apply
 *     `cache_control` to the stable block only.
 *
 * Blindly `JSON.stringify`-ing the array shape (an earlier version of this
 * function) technically produced SOME string, but every real newline inside
 * `stable`/`volatile` came back as the two-character escape sequence `\n`,
 * not an actual newline byte — harmless for `detectMockFlow`'s plain
 * `.includes()` checks (which don't care about newlines), but silently broke
 * any REGEX here that depends on real line structure (#542's
 * `mockTriageRequests`, which needs `### INMUEBLE …` / `Ejes solicitados: …`
 * to be on their own lines to extract the real per-property id/axes/evidence
 * text). Joining the blocks' `.text` fields with a real `\n\n` (mirroring
 * `assembleSystemPrompt`'s own `${stable}\n\n${volatile}` convention) gives
 * every caller the SAME real text regardless of which provider shape it came
 * from.
 */
function textOfContent(content: ChatCompletionMessageParam["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" && block !== null && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .join("\n\n");
  }
  return content === null || content === undefined ? "" : JSON.stringify(content);
}

export function systemPromptTextOf(messages: ChatCompletionMessageParam[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => textOfContent(m.content))
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
    return finalText(mockAssessmentJson(flow, sys));
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
