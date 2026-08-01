// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { HomeSparkline } from "../Sparkline";

describe("HomeSparkline", () => {
  it("renders an SVG element", () => {
    const { container } = render(
      <HomeSparkline data={[1, 2, 3, 4, 5]} />
    );
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("renders correct number of path segments (area + line)", () => {
    const { container } = render(
      <HomeSparkline data={[10, 20, 30]} />
    );
    const paths = container.querySelectorAll("path");
    // area path + line path
    expect(paths).toHaveLength(2);
  });

  it("uses provided color for stroke", () => {
    const { container } = render(
      <HomeSparkline data={[5, 10]} color="var(--up)" />
    );
    const line = container.querySelector("path[stroke]");
    expect(line?.getAttribute("stroke")).toBe("var(--up)");
  });

  it("uses --down color when passed", () => {
    const { container } = render(
      <HomeSparkline data={[5, 3]} color="var(--down)" />
    );
    const line = container.querySelector("path[stroke]");
    expect(line?.getAttribute("stroke")).toBe("var(--down)");
  });

  it("respects width and height props", () => {
    const { container } = render(
      <HomeSparkline data={[1, 2, 3]} width={70} height={20} />
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("70");
    expect(svg?.getAttribute("height")).toBe("20");
  });

  it("renders title for accessibility", () => {
    const { container } = render(
      <HomeSparkline data={[1, 2]} label="Tendencia Hoy" />
    );
    const title = container.querySelector("title");
    expect(title?.textContent).toBe("Tendencia Hoy");
  });

  it("returns null for empty data", () => {
    const { container } = render(<HomeSparkline data={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("handles single-point data (flat line)", () => {
    const { container } = render(<HomeSparkline data={[42]} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    // Should have area and line paths
    expect(container.querySelectorAll("path")).toHaveLength(2);
  });
});
