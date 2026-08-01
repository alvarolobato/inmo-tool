// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { BarChartWidget } from "../BarChartWidget";
import type { BarChartWidget as BarChartSpec } from "@/lib/schema";
import type { WidgetData } from "../types";

describe("BarChartWidget drill-down", () => {
  it("invokes onDataPointClick when a bar group is clicked", () => {
    const onDataPointClick = vi.fn();
    const widget: BarChartSpec = {
      type: "bar_chart",
      title: "Ventas por tienda",
      sql: "SELECT 1",
      x: "tienda",
      y: "Ventas",
    };
    const data: WidgetData = {
      columns: ["tienda", "Ventas"],
      rows: [
        ["Tienda 05", 1234],
        ["Tienda 01", 500],
      ],
    };
    render(<BarChartWidget widget={widget} data={data} onDataPointClick={onDataPointClick} />);

    // The custom SVG renders <g> groups with onClick for each bar
    // Click the first <g> element that has the onClick handler (cursor: pointer)
    const svg = document.querySelector("svg");
    expect(svg).toBeInTheDocument();

    // Find all <g> groups (one per data point) and click the first one
    const barGroups = document.querySelectorAll("svg g");
    expect(barGroups.length).toBeGreaterThan(0);
    fireEvent.click(barGroups[0]);

    expect(onDataPointClick).toHaveBeenCalledTimes(1);
    expect(onDataPointClick).toHaveBeenCalledWith({
      label: "Tienda 05",
      value: "1234",
      widgetTitle: "Ventas por tienda",
      widgetType: "bar_chart",
    });
  });
});
