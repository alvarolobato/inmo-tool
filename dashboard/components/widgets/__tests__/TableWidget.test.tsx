// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { TableWidget } from "../TableWidget";
import type { TableWidget as TableSpec } from "@/lib/schema";
import type { WidgetData } from "../types";

vi.mock("@tremor/react", () => ({
  Card: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

describe("TableWidget drill-down", () => {
  it("invokes onDataPointClick with first column as label when a row is clicked", () => {
    const onDataPointClick = vi.fn();
    const widget: TableSpec = {
      type: "table",
      title: "Detalle por tienda",
      sql: "SELECT 1",
    };
    const data: WidgetData = {
      columns: ["Tienda", "Ventas"],
      rows: [
        ["Tienda 05", 100],
        ["Tienda 01", 200],
      ],
    };
    render(<TableWidget widget={widget} data={data} onDataPointClick={onDataPointClick} />);
    fireEvent.click(screen.getByText("Tienda 05"));
    expect(onDataPointClick).toHaveBeenCalledTimes(1);
    expect(onDataPointClick).toHaveBeenCalledWith({
      label: "Tienda 05",
      value: "",
      widgetTitle: "Detalle por tienda",
      widgetType: "table",
    });
  });
});

describe("TableWidget numeric column header alignment", () => {
  // Regression for closed PR #423 Copilot blocker: numeric column detection
  // used `colMaxValues[idx] > 0`, which silently mis-classified columns
  // whose values were ALL 0 or ALL negative as non-numeric (left-aligned).
  it("right-aligns numeric column headers even when every value is 0", () => {
    const widget: TableSpec = {
      type: "table",
      title: "Pedidos pendientes",
      sql: "SELECT 1",
    };
    const data: WidgetData = {
      columns: ["Tienda", "Pendientes"],
      rows: [
        ["Tienda 05", 0],
        ["Tienda 01", 0],
      ],
    };
    render(<TableWidget widget={widget} data={data} />);
    const header = screen.getByText("Pendientes").closest("th");
    expect(header).not.toBeNull();
    expect(header!).toHaveStyle({ textAlign: "right" });
  });

  it("right-aligns numeric column headers when every value is negative", () => {
    const widget: TableSpec = {
      type: "table",
      title: "Variación",
      sql: "SELECT 1",
    };
    const data: WidgetData = {
      columns: ["Tienda", "Δ"],
      rows: [
        ["Tienda 05", -10],
        ["Tienda 01", -5],
      ],
    };
    render(<TableWidget widget={widget} data={data} />);
    const header = screen.getByText("Δ").closest("th");
    expect(header).not.toBeNull();
    expect(header!).toHaveStyle({ textAlign: "right" });
  });

  it("left-aligns string column headers", () => {
    const widget: TableSpec = {
      type: "table",
      title: "Lista",
      sql: "SELECT 1",
    };
    const data: WidgetData = {
      columns: ["Tienda", "Ventas"],
      rows: [
        ["Tienda 05", 100],
        ["Tienda 01", 200],
      ],
    };
    render(<TableWidget widget={widget} data={data} />);
    const header = screen.getByText("Tienda").closest("th");
    expect(header).not.toBeNull();
    expect(header!).toHaveStyle({ textAlign: "left" });
  });

  // Regression for the "Temporada" alignment bug: identifier columns whose
  // values are mostly text codes ("S26", "VER", "P25-V") with a minority of
  // pure-number values ("2024") used to render numeric rows right-aligned
  // with heat bars while sibling text rows rendered left-aligned. We treat a
  // column as numeric only when ≥80% of non-null cells are numbers.
  it("keeps identifier columns left-aligned when only a minority of cells are numeric", () => {
    const widget: TableSpec = {
      type: "table",
      title: "Dead Stock",
      sql: "SELECT 1",
    };
    const data: WidgetData = {
      columns: ["Referencia", "Temporada"],
      rows: [
        ["REF-001", "S26"],
        ["REF-002", "VER"],
        ["REF-003", "P25-V"],
        ["REF-004", "2024"],
        ["REF-005", "INV"],
      ],
    };
    render(<TableWidget widget={widget} data={data} />);
    const header = screen.getByText("Temporada").closest("th");
    expect(header).not.toBeNull();
    expect(header!).toHaveStyle({ textAlign: "left" });
    // The "2024" cell must NOT render as a heat-cell (right-aligned with bar).
    // Heat-cell wraps the number in a span with a fixed monospace size; a
    // plain text cell renders the value directly inside the <td>.
    const cell2024 = screen.getByText("2024").closest("td");
    expect(cell2024).not.toBeNull();
    expect(cell2024!).not.toHaveStyle({ textAlign: "right" });
  });
});
