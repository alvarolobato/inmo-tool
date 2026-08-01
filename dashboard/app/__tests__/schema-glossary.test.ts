// @vitest-environment node
import { describe, it, expect } from "vitest";
import { validateSpec } from "@/lib/schema";

// ---------------------------------------------------------------------------
// DashboardSpec — glossary field validation tests
// ---------------------------------------------------------------------------

const baseSpec = {
  title: "Test Dashboard",
  description: "Un panel de prueba",
  widgets: [
    {
      id: "w1",
      type: "number" as const,
      title: "Total Ventas",
      sql: "SELECT 1 AS value",
      format: "currency" as const,
    },
  ],
};

describe("DashboardSpec schema — glossary field", () => {
  it("validates a spec without glossary (backwards compatible)", () => {
    expect(() => validateSpec(baseSpec)).not.toThrow();
    const result = validateSpec(baseSpec);
    expect(result.glossary).toBeUndefined();
  });

  it("validates a spec with a valid glossary array", () => {
    const spec = {
      ...baseSpec,
      glossary: [
        { term: "Ventas Netas", definition: "Importe de ventas sin IVA, sin devoluciones." },
        { term: "Ticket Medio", definition: "Importe medio por transacción de venta." },
      ],
    };
    expect(() => validateSpec(spec)).not.toThrow();
    const result = validateSpec(spec);
    expect(result.glossary).toHaveLength(2);
    expect(result.glossary![0].term).toBe("Ventas Netas");
  });

  it("fails validation when glossary entry is missing 'definition'", () => {
    const spec = {
      ...baseSpec,
      glossary: [{ term: "Ventas Netas" }],
    };
    expect(() => validateSpec(spec)).toThrow();
  });

  it("fails validation when glossary entry is missing 'term'", () => {
    const spec = {
      ...baseSpec,
      glossary: [{ definition: "Solo definición, sin término." }],
    };
    expect(() => validateSpec(spec)).toThrow();
  });

  it("fails validation when a glossary entry has extra unknown fields", () => {
    const spec = {
      ...baseSpec,
      glossary: [{ term: "Ventas Netas", definition: "Ventas sin IVA", extra: "oops" }],
    };
    // .strict() rejects extra fields
    expect(() => validateSpec(spec)).toThrow();
  });

  it("fails validation when glossary entries have empty strings", () => {
    const spec = {
      ...baseSpec,
      glossary: [{ term: "", definition: "Some def" }],
    };
    expect(() => validateSpec(spec)).toThrow();
  });

  it("fails validation when glossary is an empty array (min(1) constraint)", () => {
    const spec = {
      ...baseSpec,
      glossary: [],
    };
    // z.array(GlossaryItemSchema).min(1).optional() — empty array fails
    expect(() => validateSpec(spec)).toThrow();
  });

  it("validates a spec with both sections and glossary", () => {
    const spec = {
      ...baseSpec,
      widgets: [
        { id: "w1", type: "number" as const, title: "Total", sql: "SELECT 1 AS value", format: "number" as const },
      ],
      sections: [
        { id: "s1", label: "Ventas", widget_ids: ["w1"] },
      ],
      glossary: [
        { term: "Total", definition: "Suma total de registros." },
      ],
    };
    expect(() => validateSpec(spec)).not.toThrow();
  });
});
