import { describe, it, expect } from "vitest";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { CHAT_TOOLS, INSPECTION_TOOL_NAMES } from "@/lib/llm-tools/catalog";
import { toolsForFlow } from "@/lib/llm-context";
import { LLM_FLOWS } from "@/lib/llm-context/types";

const names = (tools: ChatCompletionTool[]): string[] =>
  tools
    .filter((t): t is Extract<ChatCompletionTool, { type: "function" }> => t.type === "function")
    .map((t) => t.function.name);

describe("llm-tools catalog", () => {
  describe("CHAT_TOOLS", () => {
    it("contains exactly 6 tools (5 inspection + set_title)", () => {
      expect(CHAT_TOOLS).toHaveLength(6);
    });

    it("includes every read-only inspection tool", () => {
      const n = names(CHAT_TOOLS);
      expect(n).toContain("validate_query");
      expect(n).toContain("execute_query");
      expect(n).toContain("explain_query");
      expect(n).toContain("list_tables");
      expect(n).toContain("describe_table");
    });

    it("includes set_title", () => {
      expect(names(CHAT_TOOLS)).toContain("set_title");
    });

    it("set_title has a required 'title' parameter", () => {
      const setTitle = CHAT_TOOLS.find(
        (t) => t.type === "function" && t.function.name === "set_title",
      );
      expect(setTitle).toBeDefined();
      if (setTitle?.type === "function") {
        const params = setTitle.function.parameters as {
          properties: Record<string, unknown>;
          required: string[];
        };
        expect(params.properties).toHaveProperty("title");
        expect(params.required).toContain("title");
      }
    });

    /**
     * #24 removed the dashboard-authoring tier. These names must never come
     * back without a deliberate decision: they let the model publish an
     * artifact, and this product has no artifact for them to publish.
     */
    it("contains no dashboard-authoring or write tools", () => {
      const n = names(CHAT_TOOLS);
      for (const retired of [
        "validate_dashboard_spec",
        "apply_dashboard_modification",
        "submit_dashboard_analysis",
        "start_dashboard_generation",
        "submit_weekly_review",
        "list_dashboards",
        "get_dashboard_spec",
        "get_dashboard_queries",
        "get_dashboard_widget_raw_values",
        "get_dashboard_all_widget_status",
      ]) {
        expect(n).not.toContain(retired);
      }
    });

    it("every tool except set_title is a declared read-only inspection tool", () => {
      const n = names(CHAT_TOOLS).filter((x) => x !== "set_title");
      for (const name of n) expect(INSPECTION_TOOL_NAMES.has(name)).toBe(true);
    });
  });

  describe("toolsForFlow", () => {
    it("gives the chat flow the full chat catalog", () => {
      expect(toolsForFlow("chat")).toEqual(CHAT_TOOLS);
    });

    it("gives every assessment flow an empty catalog (single-shot)", () => {
      for (const flow of LLM_FLOWS.filter((f) => f !== "chat")) {
        expect(toolsForFlow(flow)).toEqual([]);
      }
    });

    it("fails closed for an unknown flow", () => {
      expect(toolsForFlow("definitely-not-a-flow")).toEqual([]);
    });
  });
});
