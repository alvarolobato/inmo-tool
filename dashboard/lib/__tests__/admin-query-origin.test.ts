import { describe, it, expect } from "vitest";
import {
  extractSqlFingerprint,
  jaccardSimilarity,
  savedDashboardCandidates,
  findQueryOrigin,
} from "../admin-query-origin";

describe("extractSqlFingerprint", () => {
  it("extracts ps_* table names from a simple query", () => {
    const sql = "SELECT * FROM ps_ventas WHERE fecha_creacion >= $1";
    expect(extractSqlFingerprint(sql)).toEqual(["ps_ventas"]);
  });

  it("extracts multiple table names from a JOIN query", () => {
    const sql = `
      SELECT lv.codigo, v.tienda
      FROM ps_lineas_ventas lv
      JOIN ps_ventas v ON v.reg_ventas = lv.num_ventas
      WHERE lv.tienda <> '99'
    `;
    expect(extractSqlFingerprint(sql)).toEqual(["ps_lineas_ventas", "ps_ventas"]);
  });

  it("deduplicates repeated table names", () => {
    const sql =
      "SELECT * FROM ps_ventas v JOIN ps_ventas v2 ON v.id = v2.id WHERE ps_ventas.tienda = '01'";
    expect(extractSqlFingerprint(sql)).toEqual(["ps_ventas"]);
  });

  it("returns empty array when no ps_* tables", () => {
    expect(extractSqlFingerprint("SELECT 1 AS x")).toEqual([]);
    expect(extractSqlFingerprint("")).toEqual([]);
  });

  it("is case-insensitive", () => {
    const sql = "SELECT * FROM PS_VENTAS";
    expect(extractSqlFingerprint(sql)).toEqual(["ps_ventas"]);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical non-empty fingerprints", () => {
    expect(jaccardSimilarity(["ps_ventas"], ["ps_ventas"])).toBe(1);
  });

  it("returns 0 for disjoint fingerprints", () => {
    expect(jaccardSimilarity(["ps_ventas"], ["ps_stock_tienda"])).toBe(0);
  });

  it("returns 0 for two empty fingerprints", () => {
    expect(jaccardSimilarity([], [])).toBe(0);
  });

  it("computes partial overlap correctly", () => {
    const a = ["ps_ventas", "ps_lineas_ventas"];
    const b = ["ps_ventas", "ps_articulos"];
    // intersection = {ps_ventas}, union = {ps_ventas, ps_lineas_ventas, ps_articulos}
    expect(jaccardSimilarity(a, b)).toBeCloseTo(1 / 3);
  });
});

describe("savedDashboardCandidates", () => {
  it("extracts candidates from a dashboard spec", () => {
    const dashboards = [
      {
        id: "d1",
        title: "Mi Dashboard",
        spec: {
          title: "Mi Dashboard",
          widgets: [
            {
              id: "w1",
              type: "bar_chart",
              title: "Ventas por tienda",
              sql: "SELECT tienda, SUM(total_si) FROM ps_ventas GROUP BY tienda",
            },
          ],
        },
      },
    ];
    const candidates = savedDashboardCandidates(dashboards);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toContain("Mi Dashboard");
    expect(candidates[0].fingerprint).toEqual(["ps_ventas"]);
  });

  it("extracts candidates from kpi_row items", () => {
    const dashboards = [
      {
        id: "d2",
        title: "KPIs",
        spec: {
          title: "KPIs",
          widgets: [
            {
              id: "w1",
              type: "kpi_row",
              items: [
                {
                  label: "Ventas",
                  sql: "SELECT SUM(total_si) AS value FROM ps_ventas WHERE entrada = true",
                },
                {
                  label: "Stock",
                  sql: "SELECT SUM(stock) AS value FROM ps_stock_tienda",
                },
              ],
            },
          ],
        },
      },
    ];
    const candidates = savedDashboardCandidates(dashboards);
    expect(candidates).toHaveLength(2);
    const tables = candidates.flatMap((c) => c.fingerprint);
    expect(tables).toContain("ps_ventas");
    expect(tables).toContain("ps_stock_tienda");
  });

  it("returns empty when dashboards list is empty", () => {
    expect(savedDashboardCandidates([])).toHaveLength(0);
  });
});

describe("findQueryOrigin — template matching", () => {
  it("matches a ps_ventas query to the Ventas template", () => {
    const rawSql =
      "SELECT SUM(total_si) AS value FROM ps_ventas v WHERE v.entrada = true AND v.tienda <> '99' AND v.fecha_creacion >= $1 AND v.fecha_creacion <= $2";
    const origin = findQueryOrigin(rawSql);
    expect(origin).not.toBeNull();
    expect(origin!.source).toMatch(/Template.*Ventas/i);
    expect(origin!.locationHint).toContain("dashboard/lib/templates/ventas.ts");
  });

  it("matches a ps_stock_tienda query to the Stock template", () => {
    const rawSql =
      "SELECT tienda, SUM(stock) AS total_stock FROM ps_stock_tienda WHERE tienda <> '99' GROUP BY tienda ORDER BY total_stock DESC";
    const origin = findQueryOrigin(rawSql);
    expect(origin).not.toBeNull();
    // Should match the stock template since it primarily references ps_stock_tienda
    expect(origin!.locationHint).toContain("dashboard/lib/templates/stock.ts");
  });

  it("returns null for a non-ps_* query", () => {
    const rawSql = "SELECT 1 AS health_check";
    expect(findQueryOrigin(rawSql)).toBeNull();
  });

  it("returns null when similarity is below threshold", () => {
    // A query with a table not in any template
    const rawSql =
      "SELECT * FROM ps_completely_made_up_table_xyz WHERE id = $1";
    // ps_completely_made_up_table_xyz won't match any source
    expect(findQueryOrigin(rawSql)).toBeNull();
  });
});

describe("findQueryOrigin — saved dashboard matching", () => {
  it("matches a query against a saved dashboard", () => {
    const rawSql =
      "SELECT tienda, SUM(total_si) AS ventas FROM ps_gc_lin_albarane GROUP BY tienda";
    const savedDashboards = [
      {
        id: "d1",
        title: "Dashboard Mayorista",
        spec: {
          title: "Dashboard Mayorista",
          widgets: [
            {
              id: "w1",
              type: "bar_chart",
              title: "Ventas mayorista por tienda",
              sql: "SELECT tienda, SUM(base1 + base2) AS ventas FROM ps_gc_lin_albarane GROUP BY tienda",
            },
          ],
        },
      },
    ];
    // Build candidates once, pass as savedDashboardCandidateList (new API)
    const candidateList = savedDashboardCandidates(savedDashboards);
    const origin = findQueryOrigin(rawSql, { savedDashboardCandidateList: candidateList });
    expect(origin).not.toBeNull();
    expect(origin!.source).toContain("Dashboard Mayorista");
  });
});
