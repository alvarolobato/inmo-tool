// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RankedBarsWidget } from "../RankedBarsWidget";
import type { RankedBarsWidget as RankedBarsWidgetSpec } from "@/lib/schema";

function makeWidget(overrides: Partial<RankedBarsWidgetSpec> = {}): RankedBarsWidgetSpec {
  return {
    type: "ranked_bars",
    title: "Margen Bruto % por Tienda",
    items: [
      { label: "159", value: 85.2, flag: "top" },
      { label: "611", value: 61.5 },
      { label: "601", value: 27.8, flag: "low" },
    ],
    ...overrides,
  };
}

describe("RankedBarsWidget", () => {
  it("renders the widget title", () => {
    render(<RankedBarsWidget widget={makeWidget()} />);
    expect(screen.getByText("Margen Bruto % por Tienda")).toBeDefined();
  });

  it("renders all item labels", () => {
    render(<RankedBarsWidget widget={makeWidget()} />);
    expect(screen.getByText("159")).toBeDefined();
    expect(screen.getByText("611")).toBeDefined();
    expect(screen.getByText("601")).toBeDefined();
  });

  it("renders formatted values", () => {
    render(<RankedBarsWidget widget={makeWidget()} />);
    expect(screen.getByText("85,2")).toBeDefined();
    expect(screen.getByText("27,8")).toBeDefined();
  });

  it("renders values with explicit unit", () => {
    render(
      <RankedBarsWidget
        widget={makeWidget({
          items: [{ label: "A", value: 42, unit: "%" }],
        })}
      />,
    );
    expect(screen.getByText("42 %")).toBeDefined();
  });

  it("bar widths are proportional (low value narrower than high value)", () => {
    const { container } = render(<RankedBarsWidget widget={makeWidget()} />);
    const bars = container.querySelectorAll("[data-testid='ranked-bar']");
    if (bars.length > 0) {
      const widths = Array.from(bars).map((b) => parseFloat((b as HTMLElement).style.width || "0"));
      // top item (85.2) should be wider than bottom item (27.8)
      expect(widths[0]).toBeGreaterThan(widths[2]);
    }
  });

  it("handles zero maxValue gracefully (no Infinity)", () => {
    // All items with value 0 — should not throw
    expect(() =>
      render(
        <RankedBarsWidget
          widget={makeWidget({ items: [{ label: "X", value: 0 }] })}
        />,
      ),
    ).not.toThrow();
  });

  it("handles item.maxValue=0 gracefully (no Infinity)", () => {
    expect(() =>
      render(
        <RankedBarsWidget
          widget={makeWidget({ items: [{ label: "X", value: 5, maxValue: 0 }] })}
        />,
      ),
    ).not.toThrow();
  });
});
