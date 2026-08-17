import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  getDashboardLlmModel,
  getDashboardLlmDisplayConfig,
  resetDashboardLlmConfigCache,
} from "@/lib/llm-model-config";

describe("dashboard LLM model config", () => {
  beforeEach(() => {
    // Isolate from the developer's real ~/.config/inmo-tool/config.yaml: the
    // loader reads that file directly, so a machine that pins
    // `dashboard.llm_model_openrouter` made the "deprecated env fallback" and
    // "schema default" cases assert against local config instead of the code
    // under test (they passed or failed depending on whose laptop ran them).
    vi.stubEnv("CONFIG_FILE", "/nonexistent/inmo-tool-test/config.yaml");
    resetDashboardLlmConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetDashboardLlmConfigCache();
  });

  it("returns OpenRouter model from DASHBOARD_LLM_MODEL_OPENROUTER when set", () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
    vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER", "openai/gpt-4o");
    delete process.env.DASHBOARD_LLM_MODEL;
    expect(getDashboardLlmModel()).toBe("openai/gpt-4o");
  });

  it("falls back to DASHBOARD_LLM_MODEL (deprecated) for OpenRouter when the per-provider key is unset", () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
    delete process.env.DASHBOARD_LLM_MODEL_OPENROUTER;
    // Slash format → routed to the OpenRouter side; the loader emits
    // a one-time deprecation warning that is silenced in vitest.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DASHBOARD_LLM_MODEL", "legacy/model");
    expect(getDashboardLlmModel()).toBe("legacy/model");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does NOT route a slashed legacy DASHBOARD_LLM_MODEL into the CLI driver", () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    delete process.env.DASHBOARD_LLM_MODEL_CLI;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DASHBOARD_LLM_MODEL", "openrouter-style/something");
    // The CLI accepts native Claude ids only — a slashed legacy value is
    // ignored and the hard-coded default ("claude-haiku-4-5") wins.
    expect(getDashboardLlmModel()).toBe("claude-haiku-4-5");
    warn.mockRestore();
  });

  it("returns CLI model from DASHBOARD_LLM_MODEL_CLI when provider is cli", () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    vi.stubEnv("DASHBOARD_LLM_MODEL_CLI", "sonnet");
    delete process.env.DASHBOARD_LLM_MODEL;
    expect(getDashboardLlmModel()).toBe("sonnet");
  });

  it("returns default when env unset (openrouter)", () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
    delete process.env.DASHBOARD_LLM_MODEL;
    delete process.env.DASHBOARD_LLM_MODEL_OPENROUTER;
    expect(getDashboardLlmModel()).toBe("anthropic/claude-haiku-4.5");
  });

  it("getDashboardLlmDisplayConfig exposes both backend models", () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
    vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER", "a/b");
    vi.stubEnv("DASHBOARD_LLM_MODEL_CLI", "c/d");
    const c = getDashboardLlmDisplayConfig();
    expect(c.provider).toBe("openrouter");
    expect(c.openrouterModel).toBe("a/b");
    expect(c.cliModel).toBe("c/d");
    expect(c.cliDriver).toBe("claude_code");
  });
});
