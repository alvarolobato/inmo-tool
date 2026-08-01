/**
 * Snapshot tests for all 7 LLM prompt flows.
 *
 * This is the BASELINE captured before any refactoring — imports come from
 * the original source locations, not from llm-context/. Do NOT change these
 * imports to point at llm-context/ (that would defeat the purpose of the
 * baseline).
 *
 * DASHBOARD_AGENTIC_TOOLS_ENABLED is stubbed to "false" in beforeEach so that
 * snapshots are deterministic and independent of the environment default.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildGeneratePromptSplit, buildModifyPromptSplit } from "../prompts";
import { buildAnalyzePrompt } from "../analyze-prompts";
import { buildFreeChatContext } from "../conversation-context";
import { buildReviewPrompt } from "../review-prompts";
import { buildSuggestPrompt, buildGapAnalysisPrompt } from "../creation-prompts";

describe("prompt-snapshots (baseline)", () => {
  beforeEach(() => {
    // Ensure agentic tools are disabled so snapshots are deterministic
    vi.stubEnv("DASHBOARD_AGENTIC_TOOLS_ENABLED", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const FIXED_SPEC = JSON.stringify({
    title: "Test",
    description: "Test",
    widgets: [],
    filters: [],
    glossary: [],
  });

  it("generate prompt is stable", () => {
    const prompt = buildGeneratePromptSplit();
    expect(prompt.stable).toMatchSnapshot();
    expect(prompt.volatile).toMatchSnapshot();
  });

  it("modify prompt is stable", () => {
    const prompt = buildModifyPromptSplit(FIXED_SPEC, true);
    expect(prompt.stable).toMatchSnapshot();
    expect(prompt.volatile).toMatchSnapshot();
  });

  it("analyze prompt is stable", () => {
    const prompt = buildAnalyzePrompt("## Widget: Ventas\nTotal: 50000", undefined, {
      agenticMode: true,
    });
    expect(prompt).toMatchSnapshot();
  });

  it("free-chat context is stable", () => {
    const ctx = buildFreeChatContext();
    expect(ctx.systemPrompt.stable).toMatchSnapshot();
  });

  it("weekly-review prompt is stable", () => {
    const prompt = buildReviewPrompt(
      "results: {}",
      "Semana 2026-01-01 a 2026-01-07",
      "initial",
      true,
    );
    expect(prompt).toMatchSnapshot();
  });

  it("suggest prompt is stable", () => {
    const prompt = buildSuggestPrompt("Director de ventas", []);
    expect(prompt).toMatchSnapshot();
  });

  it("gap analysis prompt is stable", () => {
    const prompt = buildGapAnalysisPrompt([]);
    expect(prompt).toMatchSnapshot();
  });
});
