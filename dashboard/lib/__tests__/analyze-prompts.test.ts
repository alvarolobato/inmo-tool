import { describe, it, expect } from "vitest";
import {
  buildAnalyzePrompt,
  buildSuggestionPrompt,
  VALID_ANALYZE_ACTIONS,
} from "../analyze-prompts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildAnalyzePrompt", () => {
  const sampleData = "## Dashboard: Test\n\n### KPIs\n- Ventas: 50000\n- Tickets: 1000";

  it("includes serialized data in the prompt", () => {
    const prompt = buildAnalyzePrompt(sampleData);
    expect(prompt).toContain(sampleData);
  });

  it("includes role definition in Spanish", () => {
    const prompt = buildAnalyzePrompt(sampleData);
    expect(prompt).toContain("analista de datos experto");
    expect(prompt).toContain("PowerShop");
  });

  it("includes output rules (Spanish, markdown, specific numbers)", () => {
    const prompt = buildAnalyzePrompt(sampleData);
    expect(prompt).toContain("Responde siempre en español");
    expect(prompt).toContain("markdown");
  });

  it("includes business knowledge from INSTRUCTIONS", () => {
    const prompt = buildAnalyzePrompt(sampleData);
    // Check that some business rules are included
    expect(prompt).toContain("Reglas de negocio");
  });

  it("injects action-specific instructions for 'explicar'", () => {
    const prompt = buildAnalyzePrompt(sampleData, "explicar");
    expect(prompt).toContain("resumen narrativo completo");
  });

  it("injects action-specific instructions for 'plan_accion'", () => {
    const prompt = buildAnalyzePrompt(sampleData, "plan_accion");
    expect(prompt).toContain("acciones concretas de negocio");
    expect(prompt).toContain("prioridad");
  });

  it("injects action-specific instructions for 'anomalias'", () => {
    const prompt = buildAnalyzePrompt(sampleData, "anomalias");
    expect(prompt).toContain("anomalías");
  });

  it("injects action-specific instructions for 'comparar'", () => {
    const prompt = buildAnalyzePrompt(sampleData, "comparar");
    expect(prompt).toContain("período anterior");
  });

  it("injects action-specific instructions for 'resumen_ejecutivo'", () => {
    const prompt = buildAnalyzePrompt(sampleData, "resumen_ejecutivo");
    expect(prompt).toContain("resumen ejecutivo");
    expect(prompt).toContain("200 palabras");
  });

  it("injects action-specific instructions for 'buenas_practicas'", () => {
    const prompt = buildAnalyzePrompt(sampleData, "buenas_practicas");
    expect(prompt).toContain("buenas prácticas");
  });

  it("does not include task section when action is undefined", () => {
    const prompt = buildAnalyzePrompt(sampleData);
    expect(prompt).not.toContain("Tarea específica");
  });

  it("includes task section when action is provided", () => {
    const prompt = buildAnalyzePrompt(sampleData, "explicar");
    expect(prompt).toContain("Tarea específica");
  });

  it("all VALID_ANALYZE_ACTIONS produce non-empty action instructions", () => {
    for (const action of VALID_ANALYZE_ACTIONS) {
      const prompt = buildAnalyzePrompt(sampleData, action);
      expect(prompt).toContain("Tarea específica");
    }
  });
});

describe("buildSuggestionPrompt", () => {
  const sampleData = "## Dashboard: Test\n\n### KPIs\n- Ventas: 50000";
  const sampleExchange = "Usuario: ¿Cuánto vendimos?\n\nAsistente: Vendimos 50000€ este mes.";

  it("includes last exchange context in prompt", () => {
    const prompt = buildSuggestionPrompt(sampleData, sampleExchange);
    expect(prompt).toContain(sampleExchange.slice(0, 100));
  });

  it("includes dashboard data context", () => {
    const prompt = buildSuggestionPrompt(sampleData, sampleExchange);
    expect(prompt).toContain("Dashboard: Test");
  });

  it("requests JSON array output", () => {
    const prompt = buildSuggestionPrompt(sampleData, sampleExchange);
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("array");
  });

  it("requests Spanish questions", () => {
    const prompt = buildSuggestionPrompt(sampleData, sampleExchange);
    expect(prompt).toContain("español");
  });

  it("truncates very long data to avoid token bloat", () => {
    const longData = "x".repeat(2000);
    const prompt = buildSuggestionPrompt(longData, sampleExchange);
    // Should be truncated to 500 chars
    const dataSection = prompt.slice(prompt.indexOf("Contexto"));
    expect(dataSection.length).toBeLessThan(1500);
  });
});
