import { describe, it, expect } from "vitest";
import { spec, name, description } from "../general";
import { validateSpec, DashboardSpecSchema } from "@/lib/schema";

describe("general template", () => {
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

  it("has 7 widgets", () => {
    expect(spec.widgets).toHaveLength(7);
  });

  it("every widget has a non-empty id", () => {
    for (const widget of spec.widgets) {
      expect(widget.id).toBeTruthy();
    }
  });

  it("all expected widget IDs are present", () => {
    const ids = spec.widgets.map((w) => w.id);
    expect(ids).toContain("general-kpis");
    expect(ids).toContain("general-kpis-secondary");
    expect(ids).toContain("general-mix-canales");
    expect(ids).toContain("general-ventas-por-tienda");
    expect(ids).toContain("general-tendencia-12m");
    expect(ids).toContain("general-top-familias");
    expect(ids).toContain("general-valor-stock");
  });

  describe("general-top-familias widget", () => {
    const getWidget = () => {
      const w = spec.widgets.find((w) => w.id === "general-top-familias");
      if (!w || w.type !== "table") throw new Error("widget not found or wrong type");
      return w;
    };

    it("is a table widget", () => {
      const w = spec.widgets.find((w) => w.id === "general-top-familias");
      expect(w).toBeDefined();
      expect(w?.type).toBe("table");
    });

    it("SQL uses three CTEs: WITH curr, prev AS, yoy AS", () => {
      const w = getWidget();
      expect(w.sql).toContain("WITH curr AS");
      expect(w.sql).toContain("prev AS");
      expect(w.sql).toContain("yoy AS");
    });

    it("SQL uses INTERVAL '1 year' for YoY comparison", () => {
      const w = getWidget();
      expect(w.sql).toContain("INTERVAL '1 year'");
    });

    it("SQL uses window function OVER () for mix percentage", () => {
      const w = getWidget();
      expect(w.sql).toContain("OVER ()");
    });

    it("SQL computes previous period via interval arithmetic", () => {
      const w = getWidget();
      expect(w.sql).toContain(":curr_from::date - (:curr_to::date - :curr_from::date + 1)");
      expect(w.sql).toContain(":curr_from::date - INTERVAL '1 day'");
    });

    it("SQL selects 7 aliased columns", () => {
      const w = getWidget();
      expect(w.sql).toContain('"Familia"');
      expect(w.sql).toContain('"Ventas Netas"');
      expect(w.sql).toContain('"Unidades"');
      expect(w.sql).toContain('"Margen %"');
      expect(w.sql).toContain('"Mix %"');
      expect(w.sql).toContain('"Δ Per. Ant. %"');
      expect(w.sql).toContain('"Δ Año Ant. %"');
    });

    it("SQL applies all 6 global filter tokens in curr CTE", () => {
      const w = getWidget();
      // Extract the curr CTE block (between WITH curr AS ( and the closing ),)
      const currBlock = w.sql.split("prev AS")[0];
      expect(currBlock).toContain("__gf_tienda__");
      expect(currBlock).toContain("__gf_familia__");
      expect(currBlock).toContain("__gf_temporada__");
      expect(currBlock).toContain("__gf_marca__");
      expect(currBlock).toContain("__gf_sexo__");
      expect(currBlock).toContain("__gf_departamento__");
    });

    it("SQL applies all 6 global filter tokens in prev CTE", () => {
      const w = getWidget();
      const prevBlock = w.sql.split("prev AS")[1].split("yoy AS")[0];
      expect(prevBlock).toContain("__gf_tienda__");
      expect(prevBlock).toContain("__gf_familia__");
      expect(prevBlock).toContain("__gf_temporada__");
      expect(prevBlock).toContain("__gf_marca__");
      expect(prevBlock).toContain("__gf_sexo__");
      expect(prevBlock).toContain("__gf_departamento__");
    });

    it("SQL applies all 6 global filter tokens in yoy CTE", () => {
      const w = getWidget();
      const yoyBlock = w.sql.split("yoy AS")[1].split("SELECT c.familia")[0];
      expect(yoyBlock).toContain("__gf_tienda__");
      expect(yoyBlock).toContain("__gf_familia__");
      expect(yoyBlock).toContain("__gf_temporada__");
      expect(yoyBlock).toContain("__gf_marca__");
      expect(yoyBlock).toContain("__gf_sexo__");
      expect(yoyBlock).toContain("__gf_departamento__");
    });

    it("SQL uses LEFT JOIN for prev and yoy", () => {
      const w = getWidget();
      expect(w.sql).toContain("LEFT JOIN prev p ON");
      expect(w.sql).toContain("LEFT JOIN yoy y ON");
    });

    it("SQL has LIMIT 10", () => {
      const w = getWidget();
      expect(w.sql).toContain("LIMIT 10");
    });
  });
});
