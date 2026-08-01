import { describe, it, expect } from "vitest";
import { lintWidgetSql, lintDashboardSpec } from "../sql-heuristics";
import type { DashboardSpec } from "../schema";

describe("lintWidgetSql", () => {
  it("flags EXTRACT(days FROM …)", () => {
    const sql =
      "SELECT EXTRACT(days FROM CURRENT_DATE - MAX(v.fecha_creacion)) AS x FROM t";
    expect(lintWidgetSql(sql).length).toBeGreaterThan(0);
  });

  it("allows date subtraction without EXTRACT(days", () => {
    const sql =
      "SELECT (CURRENT_DATE - MAX(v.fecha_creacion)) AS dias FROM ps_lineas_ventas lv JOIN ps_ventas v ON true GROUP BY lv.codigo";
    expect(lintWidgetSql(sql)).toEqual([]);
  });

  it("flags COALESCE(MAX(…fecha…), 'literal')", () => {
    const sql =
      "SELECT COALESCE(MAX(ultima_venta.fecha_ultima), 'Sin ventas') AS u FROM t";
    expect(lintWidgetSql(sql).length).toBeGreaterThan(0);
  });

  it("allows COALESCE(MAX(fecha…)::text, 'literal')", () => {
    const sql =
      "SELECT COALESCE(MAX(ultima_venta.fecha_ultima)::text, 'Sin ventas') AS u FROM t";
    expect(lintWidgetSql(sql)).toEqual([]);
  });
});

describe("lintDashboardSpec", () => {
  it("returns paths for failing widgets", () => {
    const spec: DashboardSpec = {
      title: "T",
      description: "D",
      widgets: [
        {
          id: "w1",
          type: "table",
          title: "Tab",
          sql: "SELECT EXTRACT(days FROM CURRENT_DATE - fecha) AS x FROM foo",
        },
      ],
      glossary: [{ term: "a", definition: "b" }],
    };
    const msgs = lintDashboardSpec(spec);
    expect(msgs.some((m) => m.includes("w1"))).toBe(true);
    expect(msgs.some((m) => m.includes("EXTRACT(days"))).toBe(true);
  });

  it("deduplicates identical widget path messages", () => {
    const badSql = "SELECT EXTRACT(days FROM CURRENT_DATE - fecha) AS x FROM foo";
    const spec: DashboardSpec = {
      title: "T",
      description: "D",
      widgets: [
        {
          id: "w1",
          type: "kpi_row",
          items: [
            { label: "A", sql: badSql, format: "number" as const },
            { label: "A", sql: badSql, format: "number" as const },
          ],
        },
      ],
      glossary: [{ term: "a", definition: "b" }],
    };
    const msgs = lintDashboardSpec(spec);
    expect(msgs.length).toBe(1);
  });
});
