// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { KpiRow } from "@/components/widgets/KpiRow";
import type { KpiRowWidget } from "@/lib/schema";
import type { WidgetData } from "@/components/widgets/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_WIDGET: KpiRowWidget = {
  type: "kpi_row",
  items: [
    { label: "Ventas Netas", sql: "SELECT 1", format: "currency", prefix: "€" },
    { label: "Tickets", sql: "SELECT 2", format: "number" },
  ],
};

const WIDGET_WITH_ANOMALY_SQL: KpiRowWidget = {
  type: "kpi_row",
  items: [
    {
      label: "Ventas Netas",
      sql: "SELECT 1",
      format: "currency",
      prefix: "€",
      anomaly_sql: "SELECT val FROM t",
    },
    { label: "Tickets", sql: "SELECT 2", format: "number" },
  ],
};

function makeData(value: unknown): WidgetData {
  return { columns: ["value"], rows: [[value]] };
}

function makeAnomalyData(values: number[]): WidgetData {
  return { columns: ["value"], rows: values.map((v) => [v]) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KpiRow anomaly badge", () => {
  it("renders without anomaly badge when anomaly_sql is not set", () => {
    render(
      <KpiRow
        widget={BASE_WIDGET}
        data={[makeData(1000), makeData(50)]}
      />
    );

    expect(screen.queryByTestId("anomaly-badge")).not.toBeInTheDocument();
  });

  it("renders without anomaly badge when anomaly_sql is set but anomalyData is null", () => {
    render(
      <KpiRow
        widget={WIDGET_WITH_ANOMALY_SQL}
        data={[makeData(1000), makeData(50)]}
        anomalyData={[null, null]}
      />
    );

    expect(screen.queryByTestId("anomaly-badge")).not.toBeInTheDocument();
  });

  it("renders without anomaly badge when values are normal (no anomaly)", () => {
    // values[0]=100, historical=[100, 98, 102, 99, 101] — normal range
    render(
      <KpiRow
        widget={WIDGET_WITH_ANOMALY_SQL}
        data={[makeData(1000), makeData(50)]}
        anomalyData={[makeAnomalyData([100, 100, 98, 102, 99, 101]), null]}
      />
    );

    expect(screen.queryByTestId("anomaly-badge")).not.toBeInTheDocument();
  });

  it("renders anomaly badge when z-score exceeds threshold", () => {
    // values[0]=50 (current), historical=[100, 98, 102, 99, 101] — anomaly
    render(
      <KpiRow
        widget={WIDGET_WITH_ANOMALY_SQL}
        data={[makeData(1000), makeData(50)]}
        anomalyData={[makeAnomalyData([50, 100, 98, 102, 99, 101]), null]}
      />
    );

    expect(screen.getByTestId("anomaly-badge")).toBeInTheDocument();
    expect(screen.getByTestId("anomaly-badge")).toHaveTextContent("ANOMALÍA DETECTADA");
  });

  it("anomaly badge has explanation in title attribute", () => {
    render(
      <KpiRow
        widget={WIDGET_WITH_ANOMALY_SQL}
        data={[makeData(1000), makeData(50)]}
        anomalyData={[makeAnomalyData([50, 100, 98, 102, 99, 101]), null]}
      />
    );

    const badge = screen.getByTestId("anomaly-badge");
    const titleAttr = badge.getAttribute("title") ?? "";
    expect(titleAttr).toMatch(/media/i);
    expect(titleAttr).toMatch(/por debajo/);
  });

  it("only shows badge for the item that has anomaly_sql", () => {
    // Widget with anomaly_sql on item 0 only; item 1 has no anomaly_sql
    const widget: KpiRowWidget = {
      type: "kpi_row",
      items: [
        {
          label: "Ventas Netas",
          sql: "SELECT 1",
          format: "currency",
          prefix: "€",
          anomaly_sql: "SELECT val",
        },
        { label: "Tickets", sql: "SELECT 2", format: "number" },
      ],
    };

    render(
      <KpiRow
        widget={widget}
        data={[makeData(1000), makeData(50)]}
        anomalyData={[makeAnomalyData([50, 100, 98, 102, 99, 101]), null]}
      />
    );

    // Only one badge (for item 0)
    expect(screen.getAllByTestId("anomaly-badge")).toHaveLength(1);
  });

  it("renders KPI values correctly without anomaly regression", () => {
    render(
      <KpiRow
        widget={BASE_WIDGET}
        data={[makeData(12345.67), makeData(42)]}
      />
    );

    // Check KPI labels
    expect(screen.getByText("Ventas Netas")).toBeInTheDocument();
    expect(screen.getByText("Tickets")).toBeInTheDocument();
  });

  it("does not crash when anomalyData array length differs from items", () => {
    render(
      <KpiRow
        widget={WIDGET_WITH_ANOMALY_SQL}
        data={[makeData(1000), makeData(50)]}
        anomalyData={[]} // shorter than items
      />
    );

    // Should not crash
    expect(screen.queryByTestId("anomaly-badge")).not.toBeInTheDocument();
  });
});
