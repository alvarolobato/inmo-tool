import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "@/lib/review-prompts";
import { INSTRUCTIONS } from "@/lib/knowledge";

describe("buildReviewPrompt", () => {
  const reviewedWeekCtx =
    "Semana ISO cerrada del 2026-04-06 al 2026-04-12 (la semana en curso no se incluye).";

  const sampleResults = `ventas_semana_cerrada:
ventas_netas | num_tickets | ticket_medio
------------ | ----------- | ------------
12345.00     | 150         | 82.30

ventas_semana_previa:
ventas_netas | num_tickets | ticket_medio
------------ | ----------- | ------------
11000.00     | 140         | 78.57`;

  it("returns a non-empty string", () => {
    const prompt = buildReviewPrompt(sampleResults, reviewedWeekCtx);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("contains 'revisión semanal' (Spanish, case-insensitive)", () => {
    const prompt = buildReviewPrompt(sampleResults, reviewedWeekCtx);
    expect(prompt.toLowerCase()).toContain("revisión semanal");
  });

  it("contains 'Resumen Ejecutivo' (expected output section)", () => {
    const prompt = buildReviewPrompt(sampleResults, reviewedWeekCtx);
    expect(prompt).toContain("Resumen Ejecutivo");
  });

  it("contains 'JSON' to specify output format", () => {
    const prompt = buildReviewPrompt(sampleResults, reviewedWeekCtx);
    expect(prompt).toContain("JSON");
  });

  it("includes the 4 expected section titles in the output spec", () => {
    const prompt = buildReviewPrompt(sampleResults, reviewedWeekCtx);
    expect(prompt).toContain("Ventas Retail");
    expect(prompt).toContain("Canal Mayorista");
    expect(prompt).toContain("Stock y Logística");
    expect(prompt).toContain("Compras");
  });

  it("includes business instructions from INSTRUCTIONS", () => {
    const prompt = buildReviewPrompt(sampleResults, reviewedWeekCtx);
    // Check that at least one instruction text appears in the prompt
    expect(INSTRUCTIONS.length).toBeGreaterThan(0);
    const firstInstruction = INSTRUCTIONS[0].instruction;
    // Take first 50 chars to avoid issues with special chars
    expect(prompt).toContain(firstInstruction.slice(0, 50));
  });

  it("includes the query results data in the prompt", () => {
    const prompt = buildReviewPrompt(sampleResults, reviewedWeekCtx);
    expect(prompt).toContain("ventas_semana_cerrada");
    expect(prompt).toContain(reviewedWeekCtx);
    expect(prompt).toContain("12345.00");
  });

  it("specifies action_items field in the output structure", () => {
    const prompt = buildReviewPrompt(sampleResults, reviewedWeekCtx);
    expect(prompt).toContain("action_items");
  });

  it("specifies generated_at field in the output structure", () => {
    const prompt = buildReviewPrompt(sampleResults, reviewedWeekCtx);
    expect(prompt).toContain("generated_at");
  });

  it("instructs to return only JSON (no markdown fences)", () => {
    const prompt = buildReviewPrompt(sampleResults, reviewedWeekCtx);
    // Should mention not to use markdown fences
    expect(prompt.toLowerCase()).toMatch(/sin|only|únicamente|solo/);
  });
});
