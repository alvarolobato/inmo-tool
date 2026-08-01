import { describe, it, expect } from "vitest";
import { WEEKLY_SUMMARY_SEED } from "../seed-prompts";

describe("WEEKLY_SUMMARY_SEED", () => {
  it("is a non-empty string", () => {
    expect(typeof WEEKLY_SUMMARY_SEED).toBe("string");
    expect(WEEKLY_SUMMARY_SEED.length).toBeGreaterThan(0);
  });

  it("stays under 3200 characters (~800 tokens)", () => {
    expect(WEEKLY_SUMMARY_SEED.length).toBeLessThan(3200);
  });

  it("specifies the ISO week time window", () => {
    expect(WEEKLY_SUMMARY_SEED).toContain("semana ISO");
  });

  it("covers retail sales", () => {
    expect(WEEKLY_SUMMARY_SEED).toContain("retail");
  });

  it("covers wholesale sales", () => {
    // mayorista or wholesale marker
    expect(WEEKLY_SUMMARY_SEED).toMatch(/mayorista|wholesale/i);
  });

  it("includes retail business-rule filter for entrada", () => {
    expect(WEEKLY_SUMMARY_SEED).toContain("entrada");
  });

  it("includes retail tienda exclusion for store 99", () => {
    expect(WEEKLY_SUMMARY_SEED).toContain("99");
  });

  it("includes wholesale abono filter", () => {
    expect(WEEKLY_SUMMARY_SEED).toContain("abono");
  });

  it("covers margin", () => {
    expect(WEEKLY_SUMMARY_SEED).toContain("Margen");
  });

  it("covers anomaly detection", () => {
    expect(WEEKLY_SUMMARY_SEED).toContain("sigma");
  });

  it("references agentic tools", () => {
    expect(WEEKLY_SUMMARY_SEED).toContain("execute_query");
    expect(WEEKLY_SUMMARY_SEED).toContain("list_ps_tables");
    expect(WEEKLY_SUMMARY_SEED).toContain("describe_ps_table");
  });

  it("requests action recommendations", () => {
    expect(WEEKLY_SUMMARY_SEED).toMatch(/recomendaciones|acciones/i);
  });

  it("is written in Spanish", () => {
    expect(WEEKLY_SUMMARY_SEED).toContain("semana");
    expect(WEEKLY_SUMMARY_SEED).toContain("ventas");
  });
});
