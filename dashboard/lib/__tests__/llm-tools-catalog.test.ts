import { describe, it, expect } from "vitest";
import {
  DASHBOARD_AGENTIC_TOOLS,
  FREE_CHAT_TOOLS,
  FULL_DASHBOARD_TOOLS,
} from "@/lib/llm-tools/catalog";

describe("llm-tools catalog", () => {
  describe("FREE_CHAT_TOOLS", () => {
    it("contains exactly 12 tools (10 inspection + start_dashboard_generation + set_title)", () => {
      expect(FREE_CHAT_TOOLS).toHaveLength(12);
    });

    it("includes all 10 inspection tools", () => {
      const names = FREE_CHAT_TOOLS.map((t) => t.function.name);
      expect(names).toContain("list_ps_tables");
      expect(names).toContain("describe_ps_table");
      expect(names).toContain("validate_query");
      expect(names).toContain("execute_query");
      expect(names).toContain("explain_query");
      expect(names).toContain("list_dashboards");
      expect(names).toContain("get_dashboard_spec");
      expect(names).toContain("get_dashboard_queries");
      expect(names).toContain("get_dashboard_widget_raw_values");
      expect(names).toContain("get_dashboard_all_widget_status");
    });

    it("includes start_dashboard_generation", () => {
      const names = FREE_CHAT_TOOLS.map((t) => t.function.name);
      expect(names).toContain("start_dashboard_generation");
    });

    it("includes set_title", () => {
      const names = FREE_CHAT_TOOLS.map((t) => t.function.name);
      expect(names).toContain("set_title");
    });

    it("does NOT include apply_dashboard_modification", () => {
      const names = FREE_CHAT_TOOLS.map((t) => t.function.name);
      expect(names).not.toContain("apply_dashboard_modification");
    });

    it("does NOT include submit_dashboard_analysis", () => {
      const names = FREE_CHAT_TOOLS.map((t) => t.function.name);
      expect(names).not.toContain("submit_dashboard_analysis");
    });

    it("does NOT include validate_dashboard_spec", () => {
      const names = FREE_CHAT_TOOLS.map((t) => t.function.name);
      expect(names).not.toContain("validate_dashboard_spec");
    });

    it("does NOT include submit_weekly_review", () => {
      const names = FREE_CHAT_TOOLS.map((t) => t.function.name);
      expect(names).not.toContain("submit_weekly_review");
    });
  });

  describe("set_title tool", () => {
    it("is present in FREE_CHAT_TOOLS", () => {
      const names = FREE_CHAT_TOOLS.map((t) => t.function.name);
      expect(names).toContain("set_title");
    });

    it("is NOT present in DASHBOARD_AGENTIC_TOOLS", () => {
      const names = DASHBOARD_AGENTIC_TOOLS.map((t) => t.function.name);
      expect(names).not.toContain("set_title");
    });

    it("has required 'title' parameter", () => {
      const tool = FREE_CHAT_TOOLS.find((t) => t.function.name === "set_title");
      const required = tool?.function.parameters?.required as string[] | undefined;
      expect(required).toContain("title");
    });
  });

  describe("FULL_DASHBOARD_TOOLS", () => {
    it("contains all tools from DASHBOARD_AGENTIC_TOOLS", () => {
      expect(FULL_DASHBOARD_TOOLS).toBe(DASHBOARD_AGENTIC_TOOLS);
    });

    it("contains start_dashboard_generation", () => {
      const names = FULL_DASHBOARD_TOOLS.map((t) => t.function.name);
      expect(names).toContain("start_dashboard_generation");
    });
  });

  describe("DASHBOARD_AGENTIC_TOOLS (backwards compat)", () => {
    it("contains start_dashboard_generation", () => {
      const names = DASHBOARD_AGENTIC_TOOLS.map((t) => t.function.name);
      expect(names).toContain("start_dashboard_generation");
    });

    it("still contains all original tools", () => {
      const names = DASHBOARD_AGENTIC_TOOLS.map((t) => t.function.name);
      expect(names).toContain("validate_query");
      expect(names).toContain("execute_query");
      expect(names).toContain("explain_query");
      expect(names).toContain("list_ps_tables");
      expect(names).toContain("describe_ps_table");
      expect(names).toContain("list_dashboards");
      expect(names).toContain("get_dashboard_spec");
      expect(names).toContain("get_dashboard_queries");
      expect(names).toContain("get_dashboard_widget_raw_values");
      expect(names).toContain("get_dashboard_all_widget_status");
      expect(names).toContain("validate_dashboard_spec");
      expect(names).toContain("apply_dashboard_modification");
      expect(names).toContain("submit_dashboard_analysis");
      expect(names).toContain("submit_weekly_review");
    });
  });

  describe("start_dashboard_generation tool definition", () => {
    const tool = DASHBOARD_AGENTIC_TOOLS.find(
      (t) => t.function.name === "start_dashboard_generation",
    );

    it("exists in DASHBOARD_AGENTIC_TOOLS", () => {
      expect(tool).toBeDefined();
    });

    it("has required 'prompt' parameter", () => {
      const required = tool?.function.parameters?.required as string[] | undefined;
      expect(required).toContain("prompt");
    });

    it("only exposes 'prompt' in parameters (template was removed)", () => {
      const props = tool?.function.parameters?.properties as Record<string, unknown> | undefined;
      expect(props).toHaveProperty("prompt");
      expect(props).not.toHaveProperty("template");
    });
  });
});
