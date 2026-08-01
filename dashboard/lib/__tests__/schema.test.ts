import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import {
  validateSpec,
  DashboardSpecSchema,
  WidgetSchema,
  TimeRangePresetSchema,
  type DashboardSpec,
} from "../schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid spec matching the ARCHITECTURE.md example. */
const VALID_SPEC: DashboardSpec = {
  title: "Cuadro de Mandos — Ventas Marzo 2026",
  description: "Panel para el responsable de ventas",
  widgets: [
    {
      id: "w1",
      type: "kpi_row",
      items: [
        {
          label: "Ventas Netas",
          sql: "SELECT SUM(total_si) FROM ps_ventas",
          format: "currency",
          prefix: "€",
        },
        {
          label: "Tickets",
          sql: "SELECT COUNT(DISTINCT reg_ventas) FROM ps_ventas",
          format: "number",
        },
      ],
    },
    {
      type: "bar_chart",
      title: "Ventas por Tienda",
      sql: "SELECT tienda AS label, SUM(total_si) AS value FROM ps_ventas GROUP BY tienda",
      x: "label",
      y: "value",
    },
    {
      type: "line_chart",
      title: "Tendencia Semanal",
      sql: "SELECT DATE_TRUNC('week', fecha_creacion) AS x, SUM(total_si) AS y FROM ps_ventas GROUP BY 1",
    },
    {
      type: "table",
      title: "Top 10 Artículos",
      sql: 'SELECT ccrefejofacm AS "Referencia" FROM ps_articulos LIMIT 10',
    },
  ],
};

// ---------------------------------------------------------------------------
// Valid spec tests
// ---------------------------------------------------------------------------

describe("validateSpec — valid inputs", () => {
  it("accepts the full ARCHITECTURE.md example spec", () => {
    const result = validateSpec(VALID_SPEC);
    expect(result.title).toBe(VALID_SPEC.title);
    expect(result.widgets).toHaveLength(4);
  });

  it("accepts a spec without description (optional)", () => {
    const spec = { ...VALID_SPEC, description: undefined };
    const result = validateSpec(spec);
    expect(result.description).toBeUndefined();
  });

  it("accepts every widget type", () => {
    const spec: DashboardSpec = {
      title: "All Types",
      widgets: [
        {
          type: "kpi_row",
          items: [{ label: "X", sql: "SELECT 1", format: "number" }],
        },
        {
          type: "bar_chart",
          title: "B",
          sql: "SELECT 1",
          x: "a",
          y: "b",
        },
        { type: "line_chart", title: "L", sql: "SELECT 1" },
        { type: "area_chart", title: "A", sql: "SELECT 1" },
        { type: "donut_chart", title: "D", sql: "SELECT 1" },
        { type: "table", title: "T", sql: "SELECT 1" },
        {
          type: "number",
          title: "N",
          sql: "SELECT 1",
          format: "percent",
        },
      ],
    };
    const result = validateSpec(spec);
    expect(result.widgets).toHaveLength(7);
  });

  it("accepts widgets with optional id", () => {
    const spec: DashboardSpec = {
      title: "IDs",
      widgets: [
        {
          id: "custom-id",
          type: "table",
          title: "T",
          sql: "SELECT 1",
        },
      ],
    };
    const result = validateSpec(spec);
    expect(result.widgets[0].id).toBe("custom-id");
  });

  it("accepts number widget with prefix", () => {
    const spec: DashboardSpec = {
      title: "Num",
      widgets: [
        {
          type: "number",
          title: "Revenue",
          sql: "SELECT 42",
          format: "currency",
          prefix: "€",
        },
      ],
    };
    const result = validateSpec(spec);
    const w = result.widgets[0];
    expect(w.type).toBe("number");
    if (w.type === "number") {
      expect(w.prefix).toBe("€");
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid spec tests
// ---------------------------------------------------------------------------

describe("validateSpec — invalid inputs", () => {
  it("rejects null", () => {
    expect(() => validateSpec(null)).toThrow(ZodError);
  });

  it("rejects a string", () => {
    expect(() => validateSpec("not a spec")).toThrow(ZodError);
  });

  it("rejects missing title", () => {
    const spec = { widgets: VALID_SPEC.widgets };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects empty title", () => {
    const spec = { ...VALID_SPEC, title: "" };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects missing widgets", () => {
    const spec = { title: "No widgets" };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects empty widgets array", () => {
    const spec = { title: "Empty", widgets: [] };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects unknown widget type", () => {
    const spec = {
      title: "Bad",
      widgets: [{ type: "pie_chart", title: "P", sql: "SELECT 1" }],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects kpi_row with empty items array", () => {
    const spec = {
      title: "Bad",
      widgets: [{ type: "kpi_row", items: [] }],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects kpi item with missing sql", () => {
    const spec = {
      title: "Bad",
      widgets: [
        {
          type: "kpi_row",
          items: [{ label: "X", format: "number" }],
        },
      ],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects kpi item with invalid format", () => {
    const spec = {
      title: "Bad",
      widgets: [
        {
          type: "kpi_row",
          items: [{ label: "X", sql: "SELECT 1", format: "dollars" }],
        },
      ],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects bar_chart without x/y", () => {
    const spec = {
      title: "Bad",
      widgets: [{ type: "bar_chart", title: "B", sql: "SELECT 1" }],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects number widget without format", () => {
    const spec = {
      title: "Bad",
      widgets: [{ type: "number", title: "N", sql: "SELECT 1" }],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects table widget without sql", () => {
    const spec = {
      title: "Bad",
      widgets: [{ type: "table", title: "T" }],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects empty string for optional id", () => {
    const spec = {
      title: "Bad",
      widgets: [{ id: "", type: "table", title: "T", sql: "SELECT 1" }],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects empty string for optional prefix", () => {
    const spec = {
      title: "Bad",
      widgets: [
        {
          type: "number",
          title: "N",
          sql: "SELECT 1",
          format: "currency",
          prefix: "",
        },
      ],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects unknown properties on widgets (strict mode)", () => {
    const spec = {
      title: "Bad",
      widgets: [
        {
          type: "table",
          title: "T",
          sql: "SELECT 1",
          extraField: "unexpected",
        },
      ],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects unknown properties on the dashboard spec (strict mode)", () => {
    const spec = {
      title: "Bad",
      widgets: [{ type: "table", title: "T", sql: "SELECT 1" }],
      theme: "dark",
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });
});

// ---------------------------------------------------------------------------
// Schema-level tests
// ---------------------------------------------------------------------------

describe("DashboardSpecSchema", () => {
  it("safeParse returns success=false for invalid input", () => {
    const result = DashboardSpecSchema.safeParse({ title: 123 });
    expect(result.success).toBe(false);
  });

  it("safeParse returns success=true for valid input", () => {
    const result = DashboardSpecSchema.safeParse(VALID_SPEC);
    expect(result.success).toBe(true);
  });
});

describe("WidgetSchema", () => {
  it("parses a standalone bar_chart widget", () => {
    const w = {
      type: "bar_chart",
      title: "Test",
      sql: "SELECT 1",
      x: "a",
      y: "b",
    };
    const result = WidgetSchema.parse(w);
    expect(result.type).toBe("bar_chart");
  });
});

// ---------------------------------------------------------------------------
// default_time_range field tests
// ---------------------------------------------------------------------------

describe("DashboardSpecSchema — filters (global)", () => {
  const BASE = {
    title: "T",
    widgets: [{ type: "table", title: "W", sql: "SELECT 1" }],
  };

  it("accepts spec without filters (optional)", () => {
    expect(() => DashboardSpecSchema.parse(BASE)).not.toThrow();
  });

  it("accepts valid single_select and multi_select filters", () => {
    const spec = {
      ...BASE,
      filters: [
        {
          id: "tienda",
          type: "single_select",
          label: "Tienda",
          bind_expr: `v."tienda"`,
          value_type: "text",
          options_sql: "SELECT 1 AS value, 1 AS label",
        },
        {
          id: "familia",
          type: "multi_select",
          label: "Familia",
          bind_expr: `fm."fami_grup_marc"`,
          value_type: "text",
          options_sql: "SELECT 1 AS value, 1 AS label",
        },
      ],
    };
    const r = DashboardSpecSchema.parse(spec);
    expect(r.filters).toHaveLength(2);
  });

  it("rejects duplicate filter ids", () => {
    const spec = {
      ...BASE,
      filters: [
        {
          id: "tienda",
          type: "single_select",
          label: "A",
          bind_expr: "v.a",
          value_type: "text",
          options_sql: "SELECT 1 AS value, 1 AS label",
        },
        {
          id: "tienda",
          type: "single_select",
          label: "B",
          bind_expr: "v.b",
          value_type: "text",
          options_sql: "SELECT 1 AS value, 1 AS label",
        },
      ],
    };
    expect(() => DashboardSpecSchema.parse(spec)).toThrow(ZodError);
  });

  it("rejects invalid filter id slug", () => {
    const spec = {
      ...BASE,
      filters: [
        {
          id: "1bad",
          type: "single_select",
          label: "X",
          bind_expr: "x",
          value_type: "text",
          options_sql: "SELECT 1 AS value, 1 AS label",
        },
      ],
    };
    expect(() => DashboardSpecSchema.parse(spec)).toThrow(ZodError);
  });
});

describe("DashboardSpecSchema — default_time_range", () => {
  const BASE = {
    title: "T",
    widgets: [{ type: "table", title: "T", sql: "SELECT 1" }],
  };

  it("accepts spec without default_time_range (backward compat)", () => {
    expect(() => DashboardSpecSchema.parse(BASE)).not.toThrow();
  });

  it("accepts all valid preset values", () => {
    for (const preset of TimeRangePresetSchema.options) {
      const spec = { ...BASE, default_time_range: { preset } };
      const result = DashboardSpecSchema.parse(spec);
      expect(result.default_time_range?.preset).toBe(preset);
    }
  });

  it("accepts null as absent (nullish — LLMs may emit null for absent fields)", () => {
    const spec = { ...BASE, default_time_range: null };
    const result = DashboardSpecSchema.parse(spec);
    expect(result.default_time_range).toBeNull();
  });

  it("rejects invalid preset value", () => {
    const spec = { ...BASE, default_time_range: { preset: "invalid" } };
    expect(() => DashboardSpecSchema.parse(spec)).toThrow(ZodError);
  });

  it("rejects extra fields on default_time_range (strict mode)", () => {
    const spec = { ...BASE, default_time_range: { preset: "today", extra: 1 } };
    expect(() => DashboardSpecSchema.parse(spec)).toThrow(ZodError);
  });
});

describe("validateSpec — positional param guard", () => {
  // DashboardRenderer never binds positional params; it only inlines
  // :curr_*/:comp_* date tokens and __gf_<id>__ filter tokens. A saved/seeded
  // widget SQL with $1 reaches Postgres unbound ("there is no parameter $1").
  it("rejects a widget whose sql uses a positional param ($1)", () => {
    const spec = {
      title: "T",
      widgets: [
        { type: "table", title: "W", sql: "SELECT n FROM t WHERE d >= $1::date" },
      ],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("rejects a positional param in comparison_sql", () => {
    const spec = {
      title: "T",
      widgets: [
        {
          type: "bar_chart",
          title: "W",
          sql: "SELECT a AS label, b AS value FROM t",
          x: "label",
          y: "value",
          comparison_sql: "SELECT a, b FROM t WHERE d < $2::date",
        },
      ],
    };
    expect(() => validateSpec(spec)).toThrow(ZodError);
  });

  it("accepts widget sql using :curr_from / :curr_to date tokens", () => {
    const spec = {
      title: "T",
      widgets: [
        {
          type: "number",
          title: "W",
          sql: "SELECT COUNT(*) FROM t WHERE d >= :curr_from::date AND d < :curr_to::date",
          format: "number",
        },
      ],
    };
    expect(() => validateSpec(spec)).not.toThrow();
  });
});
