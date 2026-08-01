import { describe, it, expect } from "vitest";
import { spec, name, description } from "../inicio";
import { validateSpec, DashboardSpecSchema } from "@/lib/schema";

describe("inicio template", () => {
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

  it("has 9 widgets", () => {
    expect(spec.widgets).toHaveLength(9);
  });

  it("has no global filters (read-only home panel)", () => {
    // The home panel does not expose filter controls — filters must be empty.
    expect(spec.filters).toEqual([]);
  });

  it("every widget has a non-empty id", () => {
    for (const widget of spec.widgets) {
      expect(widget.id).toBeTruthy();
    }
  });

  it("every widget SQL is non-empty (no :curr_from / :curr_to tokens)", () => {
    for (const widget of spec.widgets) {
      if (widget.type === "kpi_row") {
        for (const item of widget.items) {
          expect(item.sql.trim().length).toBeGreaterThan(0);
          expect(item.sql).not.toContain(":curr_from");
          expect(item.sql).not.toContain(":curr_to");
          expect(item.sql).not.toContain("__gf_");
        }
      } else if (widget.type !== "insights_strip" && widget.type !== "ranked_bars") {
        expect(widget.sql.trim().length).toBeGreaterThan(0);
        expect(widget.sql).not.toContain(":curr_from");
        expect(widget.sql).not.toContain(":curr_to");
        expect(widget.sql).not.toContain("__gf_");
      }
    }
  });

  it("all kpi_row items have a valid format", () => {
    const validFormats = ["currency", "number", "percent", "decimal"];
    for (const widget of spec.widgets) {
      if (widget.type === "kpi_row") {
        for (const item of widget.items) {
          expect(validFormats).toContain(item.format);
        }
      }
    }
  });

  it("freshness widget has 4 items (Ventas, Stock, Compras, Mayorista)", () => {
    const freshness = spec.widgets.find((w) => w.id === "inicio-freshness");
    expect(freshness).toBeDefined();
    expect(freshness?.type).toBe("kpi_row");
    if (freshness?.type === "kpi_row") {
      expect(freshness.items).toHaveLength(4);
    }
  });

  it("uses CURRENT_DATE instead of :curr_from / :curr_to for temporal filters", () => {
    for (const widget of spec.widgets) {
      if (widget.type === "kpi_row") {
        for (const item of widget.items) {
          if (item.sql.includes("fecha_creacion") || item.sql.includes("fecha_factura")) {
            expect(item.sql).toMatch(/CURRENT_DATE|DATE_TRUNC/);
          }
        }
      } else if (widget.type !== "insights_strip" && widget.type !== "ranked_bars") {
        if (widget.sql.includes("fecha_creacion") || widget.sql.includes("fecha_factura")) {
          expect(widget.sql).toMatch(/CURRENT_DATE|DATE_TRUNC/);
        }
      }
    }
  });
});
