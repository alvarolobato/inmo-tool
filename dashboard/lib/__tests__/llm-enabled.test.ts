/**
 * The master LLM kill switch (`dashboard.llm_enabled`).
 *
 * The point of this switch is that it is the ONLY one that covers every path.
 * These tests pin that: both LLM seams refuse, and the default stays on.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { isLlmEnabled, assertLlmEnabled, LlmDisabledError } from "../llm-enabled";
import { resetDashboardLlmConfigCache } from "../llm-model-config";

beforeEach(() => {
  // Isolate from the developer's real ~/.config/inmo-tool/config.yaml.
  vi.stubEnv("CONFIG_FILE", "/nonexistent/inmo-tool-test/config.yaml");
  resetDashboardLlmConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetDashboardLlmConfigCache();
});

describe("isLlmEnabled", () => {
  it("defaults to ON — the switch is opt-in, never a surprise", () => {
    expect(isLlmEnabled()).toBe(true);
  });

  it.each([["false"], ["0"], ["no"], ["FALSE"]])("is OFF for %s", (v) => {
    vi.stubEnv("DASHBOARD_LLM_ENABLED", v);
    resetDashboardLlmConfigCache();
    expect(isLlmEnabled()).toBe(false);
  });

  it.each([["true"], ["1"], ["yes"], [""]])("stays ON for %s", (v) => {
    vi.stubEnv("DASHBOARD_LLM_ENABLED", v);
    resetDashboardLlmConfigCache();
    expect(isLlmEnabled()).toBe(true);
  });

  it("assertLlmEnabled throws a named error when off", () => {
    vi.stubEnv("DASHBOARD_LLM_ENABLED", "false");
    resetDashboardLlmConfigCache();
    expect(() => assertLlmEnabled()).toThrow(LlmDisabledError);
    // `name` is load-bearing: callers match on it to avoid import cycles.
    expect(new LlmDisabledError().name).toBe("LlmDisabledError");
    // The message must name the switch — "the AI stopped working" is a
    // support ticket; "dashboard.llm_enabled = false" is an answer.
    expect(new LlmDisabledError().message).toContain("dashboard.llm_enabled");
  });

  it("does not throw when on", () => {
    expect(() => assertLlmEnabled()).not.toThrow();
  });
});
