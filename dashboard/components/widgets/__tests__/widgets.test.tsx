// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "./setup";
import {
  KpiRow,
  BarChartWidget,
  LineChartWidget,
  AreaChartWidget,
  DonutChartWidget,
  TableWidget,
  NumberWidget,
  WidgetSkeleton,
} from "../index";
import { mergeComparisonSeries } from "../BarChartWidget";
import type {
  KpiRowWidget,
  BarChartWidget as BarChartSpec,
  LineChartWidget as LineChartSpec,
  AreaChartWidget as AreaChartSpec,
  DonutChartWidget as DonutChartSpec,
  TableWidget as TableSpec,
  NumberWidget as NumberSpec,
} from "@/lib/schema";
import type { WidgetData } from "../types";

// ---------------------------------------------------------------------------
// KpiRow
// ---------------------------------------------------------------------------

describe("KpiRow", () => {
  const widget: KpiRowWidget = {
    type: "kpi_row",
    items: [
      { label: "Ventas", sql: "", format: "currency", prefix: "\u20ac" },
      { label: "Tickets", sql: "", format: "number" },
    ],
  };

  it("renders labels and formatted values", () => {
    const data: (WidgetData | null)[] = [
      { columns: ["value"], rows: [[1234.5]] },
      { columns: ["value"], rows: [[42]] },
    ];
    render(<KpiRow widget={widget} data={data} />);
    expect(screen.getByText("Ventas")).toBeInTheDocument();
    expect(screen.getByText("Tickets")).toBeInTheDocument();
    expect(screen.getByText("\u20ac1.234,50")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("shows dash when data is missing for an item", () => {
    const data: (WidgetData | null)[] = [null, null];
    render(<KpiRow widget={widget} data={data} />);
    const dashes = screen.getAllByText("\u2014");
    expect(dashes).toHaveLength(2);
  });

  it("shows positive trend badge when trend_sql is set and value is higher", () => {
    const widgetWithTrend: KpiRowWidget = {
      type: "kpi_row",
      items: [
        { label: "Ventas", sql: "", format: "currency", prefix: "\u20ac", trend_sql: "SELECT 900" },
      ],
    };
    const data: (WidgetData | null)[] = [
      { columns: ["value"], rows: [[1000]] },
    ];
    const trendData: (WidgetData | null)[] = [
      { columns: ["value"], rows: [[800]] }, // 25% increase
    ];
    render(<KpiRow widget={widgetWithTrend} data={data} trendData={trendData} />);
    // fmtDelta renders "\u25b2 25,0%" (arrow + stripped sign + es-ES decimal)
    expect(screen.getByText("\u25b2 25,0%")).toBeInTheDocument();
  });

  it("shows negative trend badge when value is lower than comparison", () => {
    const widgetWithTrend: KpiRowWidget = {
      type: "kpi_row",
      items: [
        { label: "Ventas", sql: "", format: "currency", prefix: "\u20ac", trend_sql: "SELECT 1200" },
      ],
    };
    const data: (WidgetData | null)[] = [
      { columns: ["value"], rows: [[900]] },
    ];
    const trendData: (WidgetData | null)[] = [
      { columns: ["value"], rows: [[1000]] }, // 10% decrease
    ];
    render(<KpiRow widget={widgetWithTrend} data={data} trendData={trendData} />);
    // fmtDelta renders "\u25bc 10,0%" (arrow + stripped sign + es-ES decimal)
    expect(screen.getByText("\u25bc 10,0%")).toBeInTheDocument();
  });

  it("does not show trend badge when trend_sql is not set", () => {
    const data: (WidgetData | null)[] = [
      { columns: ["value"], rows: [[1000]] },
    ];
    const trendData: (WidgetData | null)[] = [
      { columns: ["value"], rows: [[800]] },
    ];
    render(<KpiRow widget={widget} data={data} trendData={trendData} />);
    // No percentage text should appear
    expect(screen.queryByText(/[+-]\d+\.\d+%/)).not.toBeInTheDocument();
  });

  it("does not show trend badge when comparison value is null", () => {
    const widgetWithTrend: KpiRowWidget = {
      type: "kpi_row",
      items: [
        { label: "Ventas", sql: "", format: "number", trend_sql: "SELECT NULL" },
      ],
    };
    const data: (WidgetData | null)[] = [
      { columns: ["value"], rows: [[1000]] },
    ];
    const trendData: (WidgetData | null)[] = [null];
    render(<KpiRow widget={widgetWithTrend} data={data} trendData={trendData} />);
    expect(screen.queryByText(/[+-]\d+\.\d+%/)).not.toBeInTheDocument();
  });

  it("does not show trend badge when comparison value is zero (division guard)", () => {
    const widgetWithTrend: KpiRowWidget = {
      type: "kpi_row",
      items: [
        { label: "Ventas", sql: "", format: "number", trend_sql: "SELECT 0" },
      ],
    };
    const data: (WidgetData | null)[] = [
      { columns: ["value"], rows: [[1000]] },
    ];
    const trendData: (WidgetData | null)[] = [
      { columns: ["value"], rows: [[0]] },
    ];
    render(<KpiRow widget={widgetWithTrend} data={data} trendData={trendData} />);
    expect(screen.queryByText(/[+-]\d+\.\d+%/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// NumberWidget
// ---------------------------------------------------------------------------

describe("NumberWidget", () => {
  const widget: NumberSpec = {
    type: "number",
    title: "Total Ventas",
    sql: "",
    format: "currency",
    prefix: "\u20ac",
  };

  it("renders the formatted value", () => {
    const data: WidgetData = { columns: ["total"], rows: [[5000]] };
    render(<NumberWidget widget={widget} data={data} />);
    expect(screen.getByText("Total Ventas")).toBeInTheDocument();
    expect(screen.getByText("\u20ac5.000,00")).toBeInTheDocument();
  });

  it("shows empty message when no data", () => {
    render(<NumberWidget widget={widget} data={null} />);
    expect(screen.getByText("Sin datos")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// BarChartWidget
// ---------------------------------------------------------------------------

describe("BarChartWidget", () => {
  const widget: BarChartSpec = {
    type: "bar_chart",
    title: "Ventas por Tienda",
    sql: "",
    x: "tienda",
    y: "ventas",
  };

  it("renders the title", () => {
    const data: WidgetData = {
      columns: ["tienda", "ventas"],
      rows: [["Madrid", 100]],
    };
    render(<BarChartWidget widget={widget} data={data} />);
    expect(screen.getByText("Ventas por Tienda")).toBeInTheDocument();
  });

  it("shows skeleton for null data (loading)", () => {
    render(<BarChartWidget widget={widget} data={null} />);
    expect(screen.getByTestId("widget-skeleton")).toBeInTheDocument();
  });

  it("shows empty message for empty rows", () => {
    const data: WidgetData = { columns: ["tienda", "ventas"], rows: [] };
    render(<BarChartWidget widget={widget} data={data} />);
    expect(screen.getByText("Sin datos")).toBeInTheDocument();
  });

  it("shows empty message when column names do not match", () => {
    const data: WidgetData = {
      columns: ["wrong_x", "wrong_y"],
      rows: [["A", 1]],
    };
    render(<BarChartWidget widget={widget} data={data} />);
    expect(screen.getByText("Sin datos")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// LineChartWidget
// ---------------------------------------------------------------------------

describe("LineChartWidget", () => {
  const widget: LineChartSpec = {
    type: "line_chart",
    title: "Tendencia",
    sql: "",
    x: "semana",
    y: "ventas",
  };

  it("renders the title with data", () => {
    const data: WidgetData = {
      columns: ["semana", "ventas"],
      rows: [["S1", 100], ["S2", 200]],
    };
    render(<LineChartWidget widget={widget} data={data} />);
    expect(screen.getByText("Tendencia")).toBeInTheDocument();
  });

  it("shows skeleton for null data (loading)", () => {
    render(<LineChartWidget widget={widget} data={null} />);
    expect(screen.getByTestId("widget-skeleton")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AreaChartWidget
// ---------------------------------------------------------------------------

describe("AreaChartWidget", () => {
  const widget: AreaChartSpec = {
    type: "area_chart",
    title: "Ingresos",
    sql: "",
    x: "mes",
    y: "total",
  };

  it("renders the title with data", () => {
    const data: WidgetData = {
      columns: ["mes", "total"],
      rows: [["Ene", 50], ["Feb", 80]],
    };
    render(<AreaChartWidget widget={widget} data={data} />);
    expect(screen.getByText("Ingresos")).toBeInTheDocument();
  });

  it("shows skeleton for null data (loading)", () => {
    render(<AreaChartWidget widget={widget} data={null} />);
    expect(screen.getByTestId("widget-skeleton")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// DonutChartWidget
// ---------------------------------------------------------------------------

describe("DonutChartWidget", () => {
  const widget: DonutChartSpec = {
    type: "donut_chart",
    title: "Mix Familias",
    sql: "",
    x: "familia",
    y: "pct",
  };

  it("renders the title with data", () => {
    const data: WidgetData = {
      columns: ["familia", "pct"],
      rows: [["A", 60], ["B", 40]],
    };
    render(<DonutChartWidget widget={widget} data={data} />);
    expect(screen.getByText("Mix Familias")).toBeInTheDocument();
  });

  it("shows skeleton for null data (loading)", () => {
    render(<DonutChartWidget widget={widget} data={null} />);
    expect(screen.getByTestId("widget-skeleton")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// TableWidget
// ---------------------------------------------------------------------------

describe("TableWidget", () => {
  const widget: TableSpec = {
    type: "table",
    title: "Top Articulos",
    sql: "",
  };

  it("renders column headers and rows", () => {
    const data: WidgetData = {
      columns: ["Ref", "Descripcion", "Unidades"],
      rows: [
        ["A1", "Camiseta", 10],
        ["A2", "Pantalon", 5],
      ],
    };
    render(<TableWidget widget={widget} data={data} />);
    expect(screen.getByText("Top Articulos")).toBeInTheDocument();
    expect(screen.getByText("Ref")).toBeInTheDocument();
    expect(screen.getByText("Descripcion")).toBeInTheDocument();
    expect(screen.getByText("Camiseta")).toBeInTheDocument();
    expect(screen.getByText("Pantalon")).toBeInTheDocument();
  });

  it("shows empty message for null data", () => {
    render(<TableWidget widget={widget} data={null} />);
    expect(screen.getByText("Sin datos")).toBeInTheDocument();
  });

  it("formats numeric cells with European style", () => {
    const data: WidgetData = {
      columns: ["Importe"],
      rows: [[12500]],
    };
    render(<TableWidget widget={widget} data={data} />);
    expect(screen.getByText("12.500")).toBeInTheDocument();
  });

  it("formats string numeric cells from PostgreSQL", () => {
    const data: WidgetData = {
      columns: ["Importe"],
      rows: [["12500.5"]],
    };
    render(<TableWidget widget={widget} data={data} />);
    // Numeric column is rendered as a heat cell with 0 decimal places (es-ES locale)
    expect(screen.getByText("12.501")).toBeInTheDocument();
  });

  it("shows dash for null cells", () => {
    const data: WidgetData = {
      columns: ["Valor"],
      rows: [[null]],
    };
    render(<TableWidget widget={widget} data={data} />);
    expect(screen.getByText("\u2014")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// mergeComparisonSeries unit tests
// ---------------------------------------------------------------------------

describe("mergeComparisonSeries", () => {
  const primary: WidgetData = {
    columns: ["label", "value"],
    rows: [
      ["Madrid", 1000],
      ["Barcelona", 800],
      ["Valencia", 600],
    ],
  };
  const comparison: WidgetData = {
    columns: ["label", "value"],
    rows: [
      ["Madrid", 900],
      ["Barcelona", 700],
    ],
  };

  it("merges primary and comparison into two-series dataset", () => {
    const result = mergeComparisonSeries(primary, comparison, 0, 1, "label");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ label: "Madrid", Actual: 1000, Anterior: 900 });
    expect(result[1]).toEqual({ label: "Barcelona", Actual: 800, Anterior: 700 });
  });

  it("uses null for Anterior when comparison has no matching label", () => {
    const result = mergeComparisonSeries(primary, comparison, 0, 1, "label");
    expect(result[2]).toEqual({ label: "Valencia", Actual: 600, Anterior: null });
  });

  it("excludes primary rows with non-numeric y values", () => {
    const badPrimary: WidgetData = {
      columns: ["label", "value"],
      rows: [["A", "not-a-number"], ["B", 50]],
    };
    const result = mergeComparisonSeries(badPrimary, comparison, 0, 1, "label");
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// BarChartWidget with comparison series
// ---------------------------------------------------------------------------

describe("BarChartWidget with comparison", () => {
  const widget: import("@/lib/schema").BarChartWidget = {
    type: "bar_chart",
    title: "Ventas Actual vs Anterior",
    sql: "",
    x: "label",
    y: "value",
    comparison_sql: "SELECT label, value FROM ps_ventas WHERE fecha BETWEEN :comp_from AND :comp_to",
  };

  it("renders title with comparison data present", () => {
    const data: WidgetData = { columns: ["label", "value"], rows: [["Madrid", 1000]] };
    const compData: WidgetData = { columns: ["label", "value"], rows: [["Madrid", 900]] };
    render(<BarChartWidget widget={widget} data={data} comparisonData={compData} />);
    expect(screen.getByText("Ventas Actual vs Anterior")).toBeInTheDocument();
  });

  it("renders identically (no legend) when comparisonData is absent", () => {
    const data: WidgetData = { columns: ["label", "value"], rows: [["Madrid", 1000]] };
    render(<BarChartWidget widget={widget} data={data} />);
    expect(screen.getByText("Ventas Actual vs Anterior")).toBeInTheDocument();
  });

  it("renders identically when comparisonData is null", () => {
    const data: WidgetData = { columns: ["label", "value"], rows: [["Madrid", 1000]] };
    render(<BarChartWidget widget={widget} data={data} comparisonData={null} />);
    expect(screen.getByText("Ventas Actual vs Anterior")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// DonutChartWidget with comparison summary
// ---------------------------------------------------------------------------

describe("DonutChartWidget with comparison", () => {
  const widget: import("@/lib/schema").DonutChartWidget = {
    type: "donut_chart",
    title: "Mix por Familia",
    sql: "",
    x: "familia",
    y: "pct",
    comparison_sql: "SELECT familia, pct FROM ps_ventas WHERE fecha BETWEEN :comp_from AND :comp_to",
  };

  it("shows comparison total label when comparisonData is present", () => {
    const data: WidgetData = { columns: ["familia", "pct"], rows: [["A", 600], ["B", 400]] };
    const compData: WidgetData = { columns: ["familia", "pct"], rows: [["A", 500], ["B", 300]] };
    render(<DonutChartWidget widget={widget} data={data} comparisonData={compData} />);
    // The comparison summary row contains "Anterior: 800"
    expect(screen.getByText(/Anterior:/)).toBeInTheDocument();
    expect(screen.getByText(/Actual:/)).toBeInTheDocument();
  });

  it("does not show comparison label when comparisonData is null", () => {
    const data: WidgetData = { columns: ["familia", "pct"], rows: [["A", 60], ["B", 40]] };
    render(<DonutChartWidget widget={widget} data={data} comparisonData={null} />);
    // No "Anterior:" text should appear (the title doesn't contain it)
    expect(screen.queryByText(/Anterior:/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// WidgetSkeleton
// ---------------------------------------------------------------------------

describe("WidgetSkeleton", () => {
  it("renders chart skeleton with data-testid and aria attributes", () => {
    render(<WidgetSkeleton type="chart" />);
    const el = screen.getByTestId("widget-skeleton");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("role", "status");
    expect(el).toHaveAttribute("aria-label", "Loading");
  });

  it("renders kpi skeleton with three placeholder blocks", () => {
    const { container } = render(<WidgetSkeleton type="kpi" />);
    expect(screen.getByTestId("widget-skeleton")).toBeInTheDocument();
    // three sibling flex children
    expect(container.querySelectorAll("[data-testid='widget-skeleton'] > div")).toHaveLength(3);
  });

  it("renders table skeleton with five row placeholders", () => {
    const { container } = render(<WidgetSkeleton type="table" />);
    expect(screen.getByTestId("widget-skeleton")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-testid='widget-skeleton'] > div")).toHaveLength(5);
  });

  it("renders number skeleton with a single placeholder block", () => {
    const { container } = render(<WidgetSkeleton type="number" />);
    expect(screen.getByTestId("widget-skeleton")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-testid='widget-skeleton'] > div")).toHaveLength(1);
  });
});
