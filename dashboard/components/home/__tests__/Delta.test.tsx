// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Delta } from "../Delta";

describe("Delta", () => {
  it("renders positive delta with up arrow and green color", () => {
    const { container } = render(<Delta value={0.082} size="md" />);
    const span = container.querySelector("span");
    expect(span).toBeTruthy();
    expect(container.textContent).toContain("+8,2%");
    expect(container.textContent).toContain("▲");
  });

  it("renders negative delta with down arrow", () => {
    const { container } = render(<Delta value={-0.114} size="md" />);
    expect(container.textContent).toContain("▼");
    expect(container.textContent).toContain("-11,4%");
  });

  it("renders near-zero delta as neutral", () => {
    const { container } = render(<Delta value={0.001} size="md" />);
    // Flat (abs < 0.005) — uses "·" symbol
    expect(container.textContent).toContain("·");
  });

  it("sm size renders correctly", () => {
    const { container } = render(<Delta value={0.05} size="sm" />);
    const span = container.querySelector("[aria-label]");
    expect(span).toBeTruthy();
    expect(span?.getAttribute("style")).toContain("10");
  });

  it("lg size renders correctly", () => {
    const { container } = render(<Delta value={0.05} size="lg" />);
    const span = container.querySelector("[aria-label]");
    expect(span?.getAttribute("style")).toContain("13");
  });

  it("inverted=true: positive value renders as down color (bad)", () => {
    const { container } = render(<Delta value={0.083} inverted size="sm" />);
    // Positive delta + inverted → "down" color
    const chipStyle = container.querySelector("span[aria-label]")?.getAttribute("style") ?? "";
    expect(chipStyle).toContain("var(--down)");
  });

  it("inverted=true: negative value renders as up color (good)", () => {
    const { container } = render(<Delta value={-0.05} inverted size="sm" />);
    const chipStyle = container.querySelector("span[aria-label]")?.getAttribute("style") ?? "";
    expect(chipStyle).toContain("var(--up)");
  });

  it("renders em-dash for null value", () => {
    const { container } = render(<Delta value={null} />);
    expect(container.textContent).toBe("—");
  });

  it("renders em-dash for undefined value", () => {
    const { container } = render(<Delta value={undefined} />);
    expect(container.textContent).toBe("—");
  });
});
