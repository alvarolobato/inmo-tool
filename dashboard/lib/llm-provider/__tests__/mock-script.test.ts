import { describe, it, expect, beforeEach } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  mockRunStep,
  mockSingleShotText,
  detectMockFlow,
  MOCK_PROBE_SQL,
  __resetMockCallId,
} from "@/lib/llm-provider/mock/script";
import { buildSystemPrompt } from "@/lib/llm-context";

function sys(text: string): ChatCompletionMessageParam {
  return { role: "system", content: text };
}
function user(text: string): ChatCompletionMessageParam {
  return { role: "user", content: text };
}
function toolResult(content: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: "c1", content };
}

/**
 * Build each flow's marker text from the REAL prompt builder rather than
 * hardcoding a copy. If a prompt's task heading is reworded, detectMockFlow
 * silently stops recognising that flow and every e2e run degrades to the chat
 * script — these tests are what catch that, so they must read the same source
 * of truth the runtime does.
 */
const promptFor = (flow: string): string => buildSystemPrompt(flow, {}).stable;

beforeEach(() => __resetMockCallId());

describe("detectMockFlow", () => {
  it("maps each flow from its real assembled system prompt", () => {
    expect(detectMockFlow(promptFor("occupancy"))).toBe("occupancy");
    expect(detectMockFlow(promptFor("condition"))).toBe("condition");
    expect(detectMockFlow(promptFor("redflags"))).toBe("redflags");
    expect(detectMockFlow(promptFor("extract"))).toBe("extract");
    expect(detectMockFlow(promptFor("compare"))).toBe("compare");
    expect(detectMockFlow(promptFor("chat"))).toBe("chat");
  });

  it("falls back to chat for an unrecognised prompt", () => {
    expect(detectMockFlow("texto totalmente ajeno")).toBe("chat");
  });
});

describe("mockRunStep — chat flow", () => {
  it("round 0 calls execute_query against real data", () => {
    const step = mockRunStep([sys(promptFor("chat")), user("¿cuántos anuncios hay?")]);
    expect(step.kind).toBe("tools");
    if (step.kind === "tools") {
      expect(step.tool_calls[0].function.name).toBe("execute_query");
      expect(JSON.parse(step.tool_calls[0].function.arguments).sql).toBe(MOCK_PROBE_SQL);
    }
  });

  it("round 1 returns prose embedding the probe result", () => {
    const step = mockRunStep([
      sys(promptFor("chat")),
      user("¿cuántos anuncios hay?"),
      { role: "assistant", content: "", tool_calls: [] },
      toolResult('{"rows":[{"n":"42"}]}'),
    ]);
    expect(step.kind).toBe("final");
    if (step.kind === "final") expect(step.content).toContain("42");
  });
});

describe("mockRunStep — assessment flows", () => {
  it("occupancy returns a single-shot JSON verdict, no tool round", () => {
    const step = mockRunStep([sys(promptFor("occupancy")), user("evalúa")]);
    expect(step.kind).toBe("final");
    if (step.kind === "final") {
      const parsed = JSON.parse(step.content);
      // Three independent axes since #145 — occupancy is one of them, not the
      // whole verdict.
      expect(parsed.occupancy.status).toBe("vacant");
      expect(typeof parsed.occupancy.confidence).toBe("number");
      expect(parsed.transaction.kind).toBe("compraventa");
      expect(parsed.ownership.extent).toBe("pleno_dominio");
    }
  });

  it("condition returns a condition verdict with an issues array", () => {
    const step = mockRunStep([sys(promptFor("condition")), user("evalúa")]);
    expect(step.kind).toBe("final");
    if (step.kind === "final") {
      const parsed = JSON.parse(step.content);
      expect(parsed.condition).toBe("reformado");
      expect(Array.isArray(parsed.issues)).toBe(true);
      // #313: severity is null on a non-a_reformar verdict.
      expect(parsed.renovation_severity).toBeNull();
    }
  });

  it("redflags returns an empty flags array (a valid, common result)", () => {
    const step = mockRunStep([sys(promptFor("redflags")), user("evalúa")]);
    expect(step.kind).toBe("final");
    if (step.kind === "final") {
      expect(JSON.parse(step.content).flags).toEqual([]);
    }
  });

  it("extract returns the structured-field shape with per-field confidence and nulls preserved (#28)", () => {
    const step = mockRunStep([sys(promptFor("extract")), user("evalúa")]);
    expect(step.kind).toBe("final");
    if (step.kind === "final") {
      const parsed = JSON.parse(step.content);
      expect(parsed.rooms).toBe(3);
      expect(parsed.m2_useful).toBeNull();
      expect(typeof parsed.confidence_per_field).toBe("object");
      expect(parsed.confidence_per_field.rooms).toBeGreaterThan(0);
      // Nulled field must have no confidence entry (module doc's rule).
      expect(parsed.confidence_per_field.m2_useful).toBeUndefined();
    }
  });

  it("compare returns a ranking ordered by rank", () => {
    const step = mockRunStep([sys(promptFor("compare")), user("compara")]);
    expect(step.kind).toBe("final");
    if (step.kind === "final") {
      const parsed = JSON.parse(step.content);
      expect(parsed.ranking[0].rank).toBe(1);
      expect(parsed.ranking).toHaveLength(2);
    }
  });
});

describe("mockSingleShotText", () => {
  it("returns a Spanish title for the title prompt", () => {
    const text = mockSingleShotText([sys("Genera un título conciso..."), user("hola")]);
    expect(text).toBe("Conversación de prueba e2e");
  });

  it("returns the assessment JSON for a single-shot assessment flow", () => {
    const text = mockSingleShotText([sys(promptFor("occupancy")), user("evalúa")]);
    expect(JSON.parse(text).occupancy.status).toBe("vacant");
  });
});
