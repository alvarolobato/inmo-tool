import { describe, it, expect } from "vitest";
import { spec, name, description } from "../stock";
import { validateSpec, DashboardSpecSchema } from "@/lib/schema";

describe("stock template", () => {
  it("has a non-empty name and description", () => {
    expect(name.length).toBeGreaterThan(0);
    expect(description.length).toBeGreaterThan(0);
  });

  it("validateSpec does not throw", () => {
    expect(() => validateSpec(spec)).not.toThrow();
  });

  it("safeParse returns success", () => {
    const result = DashboardSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it("has a non-empty title", () => {
    expect(spec.title.length).toBeGreaterThan(0);
  });

  it("has 11 widgets (8 original + 3 talla widgets)", () => {
    expect(spec.widgets).toHaveLength(11);
  });

  it("every widget has a non-empty id", () => {
    for (const widget of spec.widgets) {
      expect(widget.id).toBeTruthy();
    }
  });

  it("every widget SQL is non-empty", () => {
    for (const widget of spec.widgets) {
      if (widget.type === "kpi_row") {
        for (const item of widget.items) {
          expect(item.sql.trim().length).toBeGreaterThan(0);
        }
      } else if (widget.type !== "insights_strip" && widget.type !== "ranked_bars") {
        expect(widget.sql.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("new widget IDs are present", () => {
    const ids = spec.widgets.map((w) => w.id);
    expect(ids).toContain("stock-distribucion-tallas");
    expect(ids).toContain("stock-roturas-por-talla");
    expect(ids).toContain("stock-articulos-por-talla");
  });

  it("stock-distribucion-tallas is a bar_chart with x='label' and y='value'", () => {
    const widget = spec.widgets.find((w) => w.id === "stock-distribucion-tallas");
    expect(widget).toBeDefined();
    expect(widget?.type).toBe("bar_chart");
    if (widget?.type === "bar_chart") {
      expect(widget.x).toBe("label");
      expect(widget.y).toBe("value");
    }
  });

  it("stock-distribucion-tallas SQL applies all 4 filter tokens", () => {
    const widget = spec.widgets.find((w) => w.id === "stock-distribucion-tallas");
    expect(widget?.type).toBe("bar_chart");
    if (widget?.type === "bar_chart") {
      expect(widget.sql).toContain("__gf_tienda__");
      expect(widget.sql).toContain("__gf_familia__");
      expect(widget.sql).toContain("__gf_temporada__");
      expect(widget.sql).toContain("__gf_marca__");
    }
  });

  it("stock-roturas-por-talla SQL uses CASE aggregates, HAVING, and LIMIT 50", () => {
    const widget = spec.widgets.find((w) => w.id === "stock-roturas-por-talla");
    expect(widget?.type).toBe("table");
    if (widget?.type === "table") {
      expect(widget.sql).toContain("CASE WHEN");
      expect(widget.sql).toContain("HAVING");
      expect(widget.sql).toContain("LIMIT 50");
    }
  });

  it("stock-articulos-por-talla SQL sorts DESC and has LIMIT 50", () => {
    const widget = spec.widgets.find((w) => w.id === "stock-articulos-por-talla");
    expect(widget?.type).toBe("table");
    if (widget?.type === "table") {
      expect(widget.sql).toContain("ORDER BY");
      expect(widget.sql).toContain("DESC");
      expect(widget.sql).toContain("LIMIT 50");
    }
  });

  it("stock-articulos-por-talla SQL applies all 4 filter tokens", () => {
    const widget = spec.widgets.find((w) => w.id === "stock-articulos-por-talla");
    expect(widget?.type).toBe("table");
    if (widget?.type === "table") {
      expect(widget.sql).toContain("__gf_tienda__");
      expect(widget.sql).toContain("__gf_familia__");
      expect(widget.sql).toContain("__gf_temporada__");
      expect(widget.sql).toContain("__gf_marca__");
    }
  });
});
