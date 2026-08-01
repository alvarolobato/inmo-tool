import { describe, it, expect, afterEach, vi } from "vitest";
import {
  loadDashboardLlmConfig,
  resetDashboardLlmConfigCache,
  getEffectiveDashboardModel,
  getEffectiveOpenRouterProvider,
} from "@/lib/llm-provider/config";

describe("loadDashboardLlmConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetDashboardLlmConfigCache();
  });

  it("throws on unknown CLI driver", () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    vi.stubEnv("DASHBOARD_LLM_CLI_DRIVER", "unknown_agent");
    // The central schema validates enum values up-front (it's an enum
    // [claude_code]) and throws before normalizeDriver runs; accept either
    // wording so we stay robust if the validation layer moves later.
    expect(() => loadDashboardLlmConfig()).toThrow(
      /Invalid DASHBOARD_LLM_CLI_DRIVER|is not one of/,
    );
  });

  it("throws on invalid DASHBOARD_LLM_PROVIDER value", () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "lambda");
    // The central config loader (getSystemConfig) validates enum values at the schema
    // level and throws before normalizeProvider is called. Accept either error message.
    expect(() => loadDashboardLlmConfig()).toThrow(
      /Invalid DASHBOARD_LLM_PROVIDER|is not one of/,
    );
  });

  it("rejects newline in DASHBOARD_LLM_CLI_BIN", () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    vi.stubEnv("DASHBOARD_LLM_CLI_BIN", "claude\n--evil");
    expect(() => loadDashboardLlmConfig()).toThrow(/newline/);
  });

  it("getEffectiveDashboardModel picks cli model when provider is cli", () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    vi.stubEnv("DASHBOARD_LLM_MODEL_CLI", "m-cli");
    vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER", "m-or");
    const c = loadDashboardLlmConfig();
    expect(getEffectiveDashboardModel(c)).toBe("m-cli");
  });

  it("validates CLI driver at the schema layer regardless of provider", () => {
    // dashboard.llm_cli_driver is an enum [claude_code] in config/schema.yaml,
    // so the central loader rejects unknown values at startup — even when the
    // active provider is openrouter and would never read the field. Catching
    // typos early beats silently ignoring them.
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
    vi.stubEnv("DASHBOARD_LLM_CLI_DRIVER", "totally_invalid");
    expect(() => loadDashboardLlmConfig()).toThrow(/is not one of/);
  });

  describe("per-flow OpenRouter model overrides", () => {
    it("uses the per-flow override when set", () => {
      vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
      vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER", "default-or");
      vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER_MODIFY", "claude-opus-4");
      vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER_ANALYZE", "claude-haiku-4");
      const c = loadDashboardLlmConfig();
      expect(getEffectiveDashboardModel(c, "modify")).toBe("claude-opus-4");
      expect(getEffectiveDashboardModel(c, "analyze")).toBe("claude-haiku-4");
    });

    it("falls back to llm_model_openrouter when the per-flow override is empty", () => {
      vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
      vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER", "default-or");
      const c = loadDashboardLlmConfig();
      expect(getEffectiveDashboardModel(c, "modify")).toBe("default-or");
      expect(getEffectiveDashboardModel(c, "weekly")).toBe("default-or");
    });

    it("ignores the per-flow override on the cli provider", () => {
      vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
      vi.stubEnv("DASHBOARD_LLM_MODEL_CLI", "m-cli");
      vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER_MODIFY", "claude-opus-4");
      const c = loadDashboardLlmConfig();
      expect(getEffectiveDashboardModel(c, "modify")).toBe("m-cli");
    });

    it("returns llm_model_openrouter when called without a flow", () => {
      vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
      vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER", "default-or");
      vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER_GENERATE", "claude-sonnet-4");
      const c = loadDashboardLlmConfig();
      expect(getEffectiveDashboardModel(c)).toBe("default-or");
    });

    it("strips tab-suffixed OpenRouter provider routing from the effective model id", () => {
      vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
      const suffix = `\t${JSON.stringify({ only: ["deepinfra/fp4"], allow_fallbacks: false })}`;
      vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER", `deepseek/deepseek-chat${suffix}`);
      const c = loadDashboardLlmConfig();
      expect(getEffectiveDashboardModel(c)).toBe("deepseek/deepseek-chat");
      expect(getEffectiveOpenRouterProvider(c)).toEqual({
        only: ["deepinfra/fp4"],
        allow_fallbacks: false,
      });
    });
  });
});
