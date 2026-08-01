import { describe, it, expect, beforeEach } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  mockRunStep,
  mockSingleShotText,
  detectMockFlow,
  mockDashboardSpec,
  MOCK_PROBE_SQL,
  __resetMockCallId,
} from "@/lib/llm-provider/mock/script";

function sys(text: string): ChatCompletionMessageParam {
  return { role: "system", content: text };
}
function user(text: string): ChatCompletionMessageParam {
  return { role: "user", content: text };
}
function toolResult(content: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: "c1", content };
}

// Flow detection keys off each flow's unique ROLE sentence (not tool names,
// which appear in every agentic prompt). Include the terminal tool name too so
// the round-1 scripting in modify/analyze is exercised end to end.
const CHAT_SYS = "Eres un asistente analítico de PowerShop Analytics.";
const MODIFY_SYS =
  "You are an expert AI dashboard modifier for PowerShop. Call apply_dashboard_modification with the validated spec.";
const ANALYZE_SYS =
  "Eres un analista de datos experto para PowerShop. Llama a submit_dashboard_analysis.";
const GENERATE_SYS = "You are an expert AI dashboard generator for PowerShop.";

beforeEach(() => __resetMockCallId());

describe("detectMockFlow", () => {
  it("maps each flow from its system prompt markers", () => {
    expect(detectMockFlow(MODIFY_SYS)).toBe("modify");
    expect(detectMockFlow(ANALYZE_SYS)).toBe("analyze");
    expect(detectMockFlow(GENERATE_SYS)).toBe("generate");
    expect(detectMockFlow(CHAT_SYS)).toBe("chat");
  });
});

describe("mockRunStep — chat flow", () => {
  it("round 0 calls execute_query against real data", () => {
    const step = mockRunStep([sys(CHAT_SYS), user("¿cuántas ventas hay?")]);
    expect(step.kind).toBe("tools");
    if (step.kind === "tools") {
      expect(step.tool_calls[0].function.name).toBe("execute_query");
      expect(JSON.parse(step.tool_calls[0].function.arguments).sql).toBe(MOCK_PROBE_SQL);
    }
  });

  it("round 1 returns prose embedding the probe result", () => {
    const step = mockRunStep([
      sys(CHAT_SYS),
      user("¿cuántas ventas hay?"),
      { role: "assistant", content: "", tool_calls: [] },
      toolResult('{"rows":[{"n":"42"}]}'),
    ]);
    expect(step.kind).toBe("final");
    if (step.kind === "final") expect(step.content).toContain("42");
  });
});

describe("mockRunStep — modify flow", () => {
  it("round 1 calls apply_dashboard_modification with a valid-shaped spec", () => {
    const step = mockRunStep([
      sys(MODIFY_SYS),
      user("añade un kpi de ventas"),
      { role: "assistant", content: "", tool_calls: [] },
      toolResult('{"rows":[{"n":"42"}]}'),
    ]);
    expect(step.kind).toBe("tools");
    if (step.kind === "tools") {
      expect(step.tool_calls[0].function.name).toBe("apply_dashboard_modification");
      const args = JSON.parse(step.tool_calls[0].function.arguments);
      expect(args.spec.widgets[0].type).toBe("kpi_row");
      expect(typeof args.change_summary).toBe("string");
    }
  });
});

describe("mockRunStep — analyze flow", () => {
  it("round 1 calls submit_dashboard_analysis", () => {
    const step = mockRunStep([
      sys(ANALYZE_SYS),
      user("analiza esto"),
      { role: "assistant", content: "", tool_calls: [] },
      toolResult('{"rows":[{"n":"42"}]}'),
    ]);
    expect(step.kind).toBe("tools");
    if (step.kind === "tools") {
      expect(step.tool_calls[0].function.name).toBe("submit_dashboard_analysis");
      // Args must match the real tool schema (analysis_markdown / brief_summary).
      const args = JSON.parse(step.tool_calls[0].function.arguments);
      expect(typeof args.analysis_markdown).toBe("string");
      expect(typeof args.brief_summary).toBe("string");
    }
  });
});

describe("mockRunStep — generate flow", () => {
  it("returns a valid-shaped JSON spec as the final message (no tool round)", () => {
    const step = mockRunStep([sys(GENERATE_SYS), user("créame un panel de ventas")]);
    expect(step.kind).toBe("final");
    if (step.kind === "final") {
      const parsed = JSON.parse(step.content);
      expect(parsed.title).toBeTruthy();
      expect(parsed.widgets[0].type).toBe("kpi_row");
    }
  });
});

describe("mockSingleShotText", () => {
  it("returns a Spanish title for the title flow", () => {
    const text = mockSingleShotText([sys("Genera un título conciso..."), user("hola")]);
    expect(text).toBe("Conversación de prueba e2e");
  });
});

describe("mockDashboardSpec", () => {
  it("produces a kpi_row widget with seeded-data SQL", () => {
    const spec = mockDashboardSpec("X") as { widgets: Array<{ items: Array<{ sql: string }> }> };
    expect(spec.widgets[0].items[0].sql).toContain("ps_ventas");
  });
});
