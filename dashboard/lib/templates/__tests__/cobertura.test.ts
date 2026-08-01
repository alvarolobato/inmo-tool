import { describe, it, expect } from "vitest";
import { spec, name, description } from "../cobertura";
import { validateSpec, DashboardSpecSchema } from "@/lib/schema";
import { TEMPLATES } from "../index";
import { templateGlobalFiltersCobertura } from "@/lib/template-global-filters";

describe("cobertura template", () => {
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

  it("has 5 widgets", () => {
    expect(spec.widgets).toHaveLength(5);
  });

  it("every widget has a non-empty id", () => {
    for (const widget of spec.widgets) {
      expect(widget.id).toBeTruthy();
    }
  });

  it("widget ids match the expected set", () => {
    const ids = spec.widgets.map((w) => w.id);
    expect(ids).toContain("cobertura-kpis");
    expect(ids).toContain("cobertura-critica");
    expect(ids).toContain("cobertura-por-familia");
    expect(ids).toContain("cobertura-por-tienda");
    expect(ids).toContain("cobertura-sobrestock");
  });

  it("no widget SQL contains :curr_from or :curr_to tokens", () => {
    for (const widget of spec.widgets) {
      if (widget.type === "kpi_row") {
        for (const item of widget.items) {
          expect(item.sql).not.toContain(":curr_from");
          expect(item.sql).not.toContain(":curr_to");
        }
      } else if (
        widget.type !== "insights_strip" &&
        widget.type !== "ranked_bars"
      ) {
        expect(widget.sql).not.toContain(":curr_from");
        expect(widget.sql).not.toContain(":curr_to");
      }
    }
  });

  it("all __gf_*__ tokens in SQL match declared filter IDs", () => {
    const declaredIds = new Set(spec.filters?.map((f) => f.id) ?? []);
    const tokenRegex = /__gf_([a-z][a-z0-9_]*)__/g;

    for (const widget of spec.widgets) {
      if (widget.type === "kpi_row") {
        for (const item of widget.items) {
          for (const match of item.sql.matchAll(tokenRegex)) {
            expect(declaredIds).toContain(match[1]);
          }
        }
      } else if (
        widget.type !== "insights_strip" &&
        widget.type !== "ranked_bars"
      ) {
        for (const match of widget.sql.matchAll(tokenRegex)) {
          expect(declaredIds).toContain(match[1]);
        }
      }
    }
  });

  it("templateGlobalFiltersCobertura includes tienda, familia, temporada, marca, proveedor", () => {
    const ids = templateGlobalFiltersCobertura.map((f) => f.id);
    expect(ids).toContain("tienda");
    expect(ids).toContain("familia");
    expect(ids).toContain("temporada");
    expect(ids).toContain("marca");
    expect(ids).toContain("proveedor");
  });

  it("spec.filters matches templateGlobalFiltersCobertura", () => {
    expect(spec.filters).toEqual(templateGlobalFiltersCobertura);
  });

  it("template is registered in TEMPLATES array", () => {
    const found = TEMPLATES.find((t) => t.slug === "cobertura");
    expect(found).toBeDefined();
    expect(found?.name).toBe(name);
    expect(found?.description).toBe(description);
  });

  it("kpi_row widget has 4 items with correct formats", () => {
    const kpi = spec.widgets.find((w) => w.id === "cobertura-kpis");
    expect(kpi).toBeDefined();
    expect(kpi?.type).toBe("kpi_row");
    if (kpi?.type === "kpi_row") {
      expect(kpi.items).toHaveLength(4);
      expect(kpi.items[0].format).toBe("number");
      expect(kpi.items[0].inverted).toBe(true);
      expect(kpi.items[1].format).toBe("decimal");
      expect(kpi.items[2].format).toBe("number");
      expect(kpi.items[2].inverted).toBe(true);
      expect(kpi.items[3].format).toBe("currency");
      expect(kpi.items[3].prefix).toBe("€");
    }
  });

  it("bar charts have x and y fields set", () => {
    const barWidgets = spec.widgets.filter((w) => w.type === "bar_chart");
    expect(barWidgets).toHaveLength(2);
    for (const w of barWidgets) {
      if (w.type === "bar_chart") {
        expect(w.x).toBeTruthy();
        expect(w.y).toBeTruthy();
      }
    }
  });

  it("coverage formula uses CURRENT_DATE not date tokens", () => {
    for (const widget of spec.widgets) {
      if (widget.type === "kpi_row") {
        for (const item of widget.items) {
          expect(item.sql).toContain("CURRENT_DATE");
        }
      } else if (
        widget.type !== "insights_strip" &&
        widget.type !== "ranked_bars"
      ) {
        expect(widget.sql).toContain("CURRENT_DATE");
      }
    }
  });

  it("ghost store 99 is excluded in all SQL", () => {
    for (const widget of spec.widgets) {
      if (widget.type === "kpi_row") {
        for (const item of widget.items) {
          expect(item.sql).toContain("'99'");
        }
      } else if (
        widget.type !== "insights_strip" &&
        widget.type !== "ranked_bars"
      ) {
        expect(widget.sql).toContain("'99'");
      }
    }
  });
});
