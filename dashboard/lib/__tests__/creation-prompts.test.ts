import { describe, it, expect } from "vitest";
import {
  buildSuggestPrompt,
  buildGapAnalysisPrompt,
} from "../creation-prompts";

describe("buildSuggestPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildSuggestPrompt("Director de ventas", []);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("includes the role in the prompt", () => {
    const prompt = buildSuggestPrompt("Responsable de stock", []);
    expect(prompt).toContain("Responsable de stock");
  });

  it("includes JSON output format instructions", () => {
    const prompt = buildSuggestPrompt("Comprador", []);
    expect(prompt).toContain("JSON");
    expect(prompt).toContain('"name"');
    expect(prompt).toContain('"description"');
    expect(prompt).toContain('"prompt"');
  });

  it("includes schema context", () => {
    const prompt = buildSuggestPrompt("Director general", []);
    expect(prompt).toContain("ps_ventas");
    expect(prompt).toContain("ps_lineas_ventas");
    expect(prompt).toContain("ps_articulos");
  });

  it("includes relationships", () => {
    const prompt = buildSuggestPrompt("Controller financiero", []);
    expect(prompt).toContain("Table Relationships");
  });

  it("includes business rules", () => {
    const prompt = buildSuggestPrompt("Director de ventas", []);
    expect(prompt).toContain("Business Rules");
    expect(prompt).toContain("total_si");
  });

  it("includes existing dashboards to avoid overlap", () => {
    const existing = [
      { title: "Panel de Ventas Mensual", description: "Ventas por mes" },
      { title: "Stock por Tienda", description: "Stock actual" },
    ];
    const prompt = buildSuggestPrompt("Director de ventas", existing);
    expect(prompt).toContain("Panel de Ventas Mensual");
    expect(prompt).toContain("Stock por Tienda");
    expect(prompt).toContain("Do NOT suggest dashboards that overlap");
  });

  it("mentions no overlap when no existing dashboards", () => {
    const prompt = buildSuggestPrompt("Comprador", []);
    expect(prompt).toContain("None yet");
  });

  it("instructs not to use markdown fences in response", () => {
    const prompt = buildSuggestPrompt("Director general", []);
    expect(prompt).toContain("no markdown fences");
  });
});

describe("buildGapAnalysisPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildGapAnalysisPrompt([]);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("includes JSON output format instructions", () => {
    const prompt = buildGapAnalysisPrompt([]);
    expect(prompt).toContain("JSON");
    expect(prompt).toContain('"area"');
    expect(prompt).toContain('"description"');
    expect(prompt).toContain('"suggestedPrompt"');
  });

  it("includes schema context", () => {
    const prompt = buildGapAnalysisPrompt([]);
    expect(prompt).toContain("ps_ventas");
    expect(prompt).toContain("ps_stock_tienda");
  });

  it("includes relationships", () => {
    const prompt = buildGapAnalysisPrompt([]);
    expect(prompt).toContain("Table Relationships");
  });

  it("includes business rules", () => {
    const prompt = buildGapAnalysisPrompt([]);
    expect(prompt).toContain("Business Rules");
  });

  it("shows existing dashboards and widget titles in prompt", () => {
    const existing = [
      {
        title: "Panel de Ventas",
        description: "Ventas mensuales",
        widgetTitles: ["Ventas Netas", "Ticket Medio", "Top Tiendas"],
      },
      {
        title: "Panel de Stock",
        description: "Stock actual",
        widgetTitles: ["Stock Total", "Artículos sin Stock"],
      },
    ];
    const prompt = buildGapAnalysisPrompt(existing);
    expect(prompt).toContain("Panel de Ventas");
    expect(prompt).toContain("Panel de Stock");
    expect(prompt).toContain("Ventas Netas");
    expect(prompt).toContain("Artículos sin Stock");
  });

  it("handles empty dashboards array gracefully", () => {
    const prompt = buildGapAnalysisPrompt([]);
    expect(prompt).toContain("No dashboards have been created yet");
  });

  it("handles dashboard with no widget titles", () => {
    const existing = [
      { title: "Panel X", description: "Test", widgetTitles: [] },
    ];
    const prompt = buildGapAnalysisPrompt(existing);
    expect(prompt).toContain("Panel X");
  });

  it("instructs not to use markdown fences in response", () => {
    const prompt = buildGapAnalysisPrompt([]);
    expect(prompt).toContain("no markdown fences");
  });

  it("asks for 3-5 gaps maximum", () => {
    const prompt = buildGapAnalysisPrompt([]);
    expect(prompt).toContain("3-5 gaps");
  });
});
