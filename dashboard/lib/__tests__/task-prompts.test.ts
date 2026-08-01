import { describe, it, expect } from "vitest";
import { TASK_PROMPTS } from "../task-prompts";
import type { TaskPrompt } from "../task-prompts";

describe("TASK_PROMPTS", () => {
  it("exports exactly 6 task prompts", () => {
    expect(TASK_PROMPTS).toHaveLength(6);
  });

  it("each task has all required fields", () => {
    for (const task of TASK_PROMPTS) {
      expect(task.id).toBeTruthy();
      expect(task.title).toBeTruthy();
      expect(task.description).toBeTruthy();
      expect(task.icon).toBeTruthy();
      expect(task.prompt).toBeTruthy();
    }
  });

  it("all task ids are unique", () => {
    const ids = TASK_PROMPTS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes all expected task ids", () => {
    const ids = TASK_PROMPTS.map((t) => t.id);
    expect(ids).toContain("weekly-sales-meeting");
    expect(ids).toContain("replenishment");
    expect(ids).toContain("store-performance");
    expect(ids).toContain("wholesale-analysis");
    expect(ids).toContain("month-end");
    expect(ids).toContain("period-comparison");
  });

  it("most prompts reference ps_ventas", () => {
    const withVentas = TASK_PROMPTS.filter((t) =>
      t.prompt.includes("ps_ventas")
    );
    // At least 4 out of 6 tasks involve retail sales
    expect(withVentas.length).toBeGreaterThanOrEqual(4);
  });

  it("most prompts reference total_si or ps_gc_ tables", () => {
    const withRevenueRef = TASK_PROMPTS.filter(
      (t) => t.prompt.includes("total_si") || t.prompt.includes("base1")
    );
    // All tasks should reference a revenue metric
    expect(withRevenueRef.length).toBeGreaterThanOrEqual(5);
  });

  it("retail prompts filter entrada and tienda", () => {
    // Weekly sales meeting, store performance, month-end, period-comparison all deal with retail
    const retailIds = [
      "weekly-sales-meeting",
      "store-performance",
      "month-end",
      "period-comparison",
    ];
    for (const id of retailIds) {
      const task = TASK_PROMPTS.find((t) => t.id === id) as TaskPrompt;
      expect(task.prompt).toContain("entrada");
      expect(task.prompt).toContain("tienda");
    }
  });

  it("weekly-sales-meeting prompt focuses on week-over-week comparison", () => {
    const task = TASK_PROMPTS.find((t) => t.id === "weekly-sales-meeting") as TaskPrompt;
    expect(task.prompt.toLowerCase()).toMatch(/seman/);
    expect(task.prompt).toContain("ps_lineas_ventas");
  });

  it("replenishment prompt references stock table", () => {
    const task = TASK_PROMPTS.find((t) => t.id === "replenishment") as TaskPrompt;
    expect(task.prompt).toContain("ps_stock_tienda");
  });

  it("wholesale-analysis prompt references wholesale tables and base1", () => {
    const task = TASK_PROMPTS.find((t) => t.id === "wholesale-analysis") as TaskPrompt;
    expect(task.prompt).toContain("base1");
    expect(task.prompt).toContain("ps_gc_");
  });

  it("all icons are non-empty strings", () => {
    for (const task of TASK_PROMPTS) {
      expect(typeof task.icon).toBe("string");
      expect(task.icon.length).toBeGreaterThan(0);
    }
  });

  it("no task prompt embeds hardcoded SQL date expressions", () => {
    for (const task of TASK_PROMPTS) {
      expect(task.prompt).not.toMatch(/DATE_TRUNC|CURRENT_DATE|CURRENT_TIMESTAMP|\bNOW\s*\(/);
    }
  });
});
