// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  encodeOpenRouterModelValue,
  parseOpenRouterModelValue,
} from "../openrouter-selection";

describe("openrouter-selection", () => {
  it("parses plain model ids (auto routing)", () => {
    expect(parseOpenRouterModelValue("anthropic/claude-sonnet-4")).toEqual({
      modelId: "anthropic/claude-sonnet-4",
      provider: undefined,
    });
  });

  it("parses tab-suffixed provider JSON", () => {
    const stored = `deepseek/deepseek-chat\t${JSON.stringify({ only: ["deepinfra/fp4"], allow_fallbacks: false })}`;
    const parsed = parseOpenRouterModelValue(stored);
    expect(parsed.modelId).toBe("deepseek/deepseek-chat");
    expect(parsed.provider).toEqual({ only: ["deepinfra/fp4"], allow_fallbacks: false });
  });

  it("strips unknown provider keys when parsing", () => {
    const stored = `x/y\t${JSON.stringify({ only: ["a"], evil: "payload" })}`;
    const parsed = parseOpenRouterModelValue(stored);
    expect(parsed.provider).toEqual({ only: ["a"] });
  });

  it("encodeOpenRouterModelValue omits tab when provider is empty", () => {
    expect(encodeOpenRouterModelValue("m", {})).toBe("m");
    expect(encodeOpenRouterModelValue("m", null)).toBe("m");
  });

  it("encodeOpenRouterModelValue round-trips with parse", () => {
    const p = { only: ["nova/fp8"], allow_fallbacks: false };
    const s = encodeOpenRouterModelValue("openai/gpt-4o", p);
    expect(parseOpenRouterModelValue(s)).toEqual({ modelId: "openai/gpt-4o", provider: p });
  });
});
