import { describe, it, expect } from "vitest";
import {
  serializeWidgetData,
  MAX_CHART_ROWS,
  MAX_TABLE_ROWS,
} from "../data-serializer";
import type { WidgetStateData } from "../data-serializer";
import type { DashboardSpec } from "../schema";
import type { WidgetData } from "@/components/widgets/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWidgetData(columns: string[], rows: unknown[][]): WidgetData {
  return { columns, rows };
}

function makeState(data: WidgetData | null | (WidgetData | null)[], extra?: Partial<WidgetStateData>): WidgetStateData {
  return {
    data,
    loading: false,
    error: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("serializeWidgetData", () => {
  describe("kpi_row widget", () => {
    const spec: DashboardSpec = {
      title: "Test Dashboard",
      widgets: [
        {
          type: "kpi_row",
          items: [
            { label: "Ventas Netas", sql: "SELECT 1", format: "currency" },
            { label: "Tickets", sql: "SELECT 2", format: "number" },
            { label: "Ticket Medio", sql: "SELECT 3", format: "currency" },
          ],
        },
      ],
    };

    it("serializes kpi_row with 3 items", () => {
      const map = new Map<number, WidgetStateData>([
        [0, makeState([
          makeWidgetData(["value"], [[12345.67]]),
          makeWidgetData(["value"], [[890]]),
          makeWidgetData(["value"], [[13.87]]),
        ])],
      ]);

      const result = serializeWidgetData(spec, map);

      expect(result).toContain("Ventas Netas:");
      expect(result).toContain("Tickets:");
      expect(result).toContain("Ticket Medio:");
      expect(result).toContain("12.345,67");
      expect(result).toContain("890");
    });

    it("includes trend data when available", () => {
      const map = new Map<number, WidgetStateData>([
        [0, makeState(
          [makeWidgetData(["value"], [[100]])],
          { trendData: [makeWidgetData(["value"], [[80]])] }
        )],
      ]);
      const spec2: DashboardSpec = {
        title: "Test",
        widgets: [
          {
            type: "kpi_row",
            items: [{ label: "KPI", sql: "SELECT 1", format: "number" }],
          },
        ],
      };

      const result = serializeWidgetData(spec2, map);
      expect(result).toContain("período anterior:");
      expect(result).toContain("80");
    });

    it("shows unavailable message when state is missing", () => {
      const map = new Map<number, WidgetStateData>();
      const result = serializeWidgetData(spec, map);
      expect(result).toContain("[datos no disponibles]");
    });

    it("shows sin datos for null item data", () => {
      const map = new Map<number, WidgetStateData>([
        [0, makeState([null, null, null])],
      ]);
      const result = serializeWidgetData(spec, map);
      expect(result).toContain("[sin datos]");
    });
  });

  describe("bar_chart widget", () => {
    const spec: DashboardSpec = {
      title: "Bar Chart Test",
      widgets: [
        {
          type: "bar_chart",
          title: "Ventas por Tienda",
          sql: "SELECT tienda, SUM(total) FROM ps_ventas GROUP BY 1",
          x: "tienda",
          y: "valor",
        },
      ],
    };

    it("serializes bar_chart as markdown table", () => {
      const data = makeWidgetData(
        ["tienda", "valor"],
        [["Madrid", 50000], ["Barcelona", 40000]]
      );
      const map = new Map<number, WidgetStateData>([[0, makeState(data)]]);
      const result = serializeWidgetData(spec, map);

      expect(result).toContain("Ventas por Tienda");
      expect(result).toContain("Madrid");
      expect(result).toContain("50.000");
    });

    it("truncates bar_chart to MAX_CHART_ROWS", () => {
      const rows = Array.from({ length: MAX_CHART_ROWS + 20 }, (_, i) => [
        `Tienda ${i}`,
        i * 100,
      ]);
      const data = makeWidgetData(["tienda", "valor"], rows);
      const map = new Map<number, WidgetStateData>([[0, makeState(data)]]);
      const result = serializeWidgetData(spec, map);

      expect(result).toContain(`20 filas más`);
    });

    it("shows unavailable when state is missing", () => {
      const map = new Map<number, WidgetStateData>();
      const result = serializeWidgetData(spec, map);
      expect(result).toContain("[datos no disponibles]");
    });

    it("shows sin datos when data rows are empty", () => {
      const data = makeWidgetData(["tienda", "valor"], []);
      const map = new Map<number, WidgetStateData>([[0, makeState(data)]]);
      const result = serializeWidgetData(spec, map);
      expect(result).toContain("[sin datos]");
    });
  });

  describe("table widget", () => {
    const spec: DashboardSpec = {
      title: "Table Test",
      widgets: [
        {
          type: "table",
          title: "Top Artículos",
          sql: "SELECT referencia, descripcion FROM ps_articulos LIMIT 10",
        },
      ],
    };

    it("serializes table as markdown table", () => {
      const data = makeWidgetData(
        ["Referencia", "Descripción"],
        [["REF001", "Pantalón azul"], ["REF002", "Camisa blanca"]]
      );
      const map = new Map<number, WidgetStateData>([[0, makeState(data)]]);
      const result = serializeWidgetData(spec, map);

      expect(result).toContain("Top Artículos");
      expect(result).toContain("REF001");
      expect(result).toContain("Pantalón azul");
    });

    it("truncates table to MAX_TABLE_ROWS", () => {
      const rows = Array.from({ length: MAX_TABLE_ROWS + 15 }, (_, i) => [
        `REF${i}`,
        `Producto ${i}`,
      ]);
      const data = makeWidgetData(["Referencia", "Descripción"], rows);
      const map = new Map<number, WidgetStateData>([[0, makeState(data)]]);
      const result = serializeWidgetData(spec, map);

      expect(result).toContain(`15 filas más`);
    });
  });

  describe("number widget", () => {
    const spec: DashboardSpec = {
      title: "Number Test",
      widgets: [
        {
          type: "number",
          title: "Ticket Medio",
          sql: "SELECT AVG(total) AS value FROM ps_ventas",
          format: "currency",
        },
      ],
    };

    it("serializes number widget as single value", () => {
      const data = makeWidgetData(["value"], [[42.5]]);
      const map = new Map<number, WidgetStateData>([[0, makeState(data)]]);
      const result = serializeWidgetData(spec, map);

      expect(result).toContain("Ticket Medio");
      expect(result).toContain("42,5");
    });

    it("shows unavailable when data is null", () => {
      const map = new Map<number, WidgetStateData>([[0, makeState(null)]]);
      const result = serializeWidgetData(spec, map);
      expect(result).toContain("[sin datos]");
    });
  });

  describe("multiple widgets", () => {
    it("includes dashboard title and description", () => {
      const spec: DashboardSpec = {
        title: "Mi Dashboard",
        description: "Panel de ventas mensual",
        widgets: [
          {
            type: "number",
            title: "Total",
            sql: "SELECT 1",
            format: "number",
          },
        ],
      };

      const data = makeWidgetData(["value"], [[999]]);
      const map = new Map<number, WidgetStateData>([[0, makeState(data)]]);
      const result = serializeWidgetData(spec, map);

      expect(result).toContain("Mi Dashboard");
      expect(result).toContain("Panel de ventas mensual");
    });
  });

  describe("null/missing data handling", () => {
    it("handles completely missing widgetDataMap gracefully", () => {
      const spec: DashboardSpec = {
        title: "Empty Test",
        widgets: [
          {
            type: "bar_chart",
            title: "Chart",
            sql: "SELECT 1",
            x: "x",
            y: "y",
          },
        ],
      };

      const result = serializeWidgetData(spec, new Map());
      expect(result).toContain("[datos no disponibles]");
    });
  });
});
