/**
 * Legacy `conversation.mode` values must not reach buildSystemPrompt raw.
 *
 * `conversations.mode` is free text and predates the Phase 4 flow catalog:
 * rows written by the inherited product still carry 'generate', 'analyze',
 * 'weekly', etc. buildSystemPrompt has no case for those and returns an empty
 * stable prompt, so passing the raw value through would make a real, billed
 * LLM call with no system prompt and no tools — silently, since an empty
 * string is a valid prompt as far as the provider is concerned.
 *
 * turn-background.ts narrows with isLlmFlow() and falls back to 'chat'. These
 * tests pin both halves: that the raw values really are empty (so the guard is
 * load-bearing, not decorative) and that the narrowing produces a real prompt.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../system-prompt";
import { isLlmFlow } from "../types";

const LEGACY_MODES = ["generate", "modify", "analyze", "suggest", "gap", "weekly", "summary"];

describe("legacy conversation.mode fallback", () => {
  it("legacy modes are not recognised as flows", () => {
    for (const mode of LEGACY_MODES) {
      expect(isLlmFlow(mode), `${mode} should not be a current flow`).toBe(false);
    }
  });

  it("passing a legacy mode straight to buildSystemPrompt yields an empty prompt", () => {
    // This is the bug being guarded against, asserted directly: if this ever
    // starts returning content, the guard below can be reconsidered.
    for (const mode of LEGACY_MODES) {
      const { stable } = buildSystemPrompt(mode as never, {});
      expect(stable, `${mode} unexpectedly produced a prompt`).toBe("");
    }
  });

  it("narrowing a legacy mode to chat produces a real system prompt", () => {
    for (const mode of LEGACY_MODES) {
      const flow = isLlmFlow(mode) ? mode : "chat";
      const { stable } = buildSystemPrompt(flow, {});
      expect(stable.length).toBeGreaterThan(100);
      expect(stable).toContain("inmobiliaria");
    }
  });

  it("real flows are untouched by the narrowing", () => {
    for (const flow of ["chat", "occupancy", "triage", "redflags", "extract", "compare"]) {
      expect(isLlmFlow(flow)).toBe(true);
      const { stable } = buildSystemPrompt(flow as never, {});
      expect(stable.length).toBeGreaterThan(100);
    }
  });
});
