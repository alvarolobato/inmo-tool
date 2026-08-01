import { describe, it, expect } from "vitest";
import { parseClaudeAgenticStepJson } from "@/lib/llm-provider/cli/claude-code";

describe("parseClaudeAgenticStepJson", () => {
  it("parses final kind", () => {
    const out = parseClaudeAgenticStepJson('{"kind":"final","content":"hello"}');
    expect(out).toEqual({ kind: "final", content: "hello" });
  });

  it("parses tools kind", () => {
    const out = parseClaudeAgenticStepJson(
      '{"kind":"tools","calls":[{"name":"list_ps_tables","arguments":"{}"}]}',
    );
    expect(out.kind).toBe("tools");
    if (out.kind === "tools") {
      expect(out.calls[0].name).toBe("list_ps_tables");
    }
  });

  it("extracts JSON from markdown fences", () => {
    const out = parseClaudeAgenticStepJson('```json\n{"kind":"final","content":"x"}\n```');
    expect(out).toEqual({ kind: "final", content: "x" });
  });
});
