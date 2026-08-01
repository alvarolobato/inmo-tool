// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import LogBlock from "../LogBlock";
import type { LogLine } from "../LogBlock";

const sampleLines: LogLine[] = [
  { timestamp: "+0.0s", kind: "tool", label: "fetch_data", detail: "6 widgets" },
  { timestamp: "+0.4s", kind: "reason", label: "Razonando", detail: "comparando períodos" },
  { timestamp: "+1.1s", kind: "done", label: "Respuesta lista", detail: "1.742 tokens" },
];

describe("LogBlock", () => {
  // -----------------------------------------------------------------------
  // Streaming state
  // -----------------------------------------------------------------------

  it("renders streaming state with dashed border and step count", () => {
    render(<LogBlock lines={sampleLines} streaming />);
    const container = screen.getByTestId("logblock-streaming");
    expect(container).toBeInTheDocument();
    // Text is split across nodes; check container text content
    expect(container.textContent).toMatch(/Procesando/);
    expect(container.textContent).toMatch(/3 paso/);
  });

  it("renders all lines in streaming state", () => {
    render(<LogBlock lines={sampleLines} streaming />);
    expect(screen.getByText("fetch_data")).toBeInTheDocument();
    expect(screen.getByText("Razonando")).toBeInTheDocument();
    expect(screen.getByText("Respuesta lista")).toBeInTheDocument();
  });

  it("shows singular paso when exactly 1 line", () => {
    render(<LogBlock lines={[sampleLines[0]]} streaming />);
    const container = screen.getByTestId("logblock-streaming");
    // Should say "1 paso" not "1 pasos"
    expect(container.textContent).toMatch(/1 paso[^s]/);
  });

  it("does not show toggle button in streaming state", () => {
    render(<LogBlock lines={sampleLines} streaming />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Post-delivery (collapsed by default)
  // -----------------------------------------------------------------------

  it("renders collapsed toggle button in post-delivery state", () => {
    render(<LogBlock lines={sampleLines} />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveTextContent(/Ver logs \(3\)/i);
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("does not show log lines by default (collapsed)", () => {
    render(<LogBlock lines={sampleLines} />);
    expect(screen.queryByTestId("logblock-lines")).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Toggle expand/collapse (uncontrolled)
  // -----------------------------------------------------------------------

  it("expands to show log lines when toggle button is clicked", () => {
    render(<LogBlock lines={sampleLines} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("logblock-lines")).toBeInTheDocument();
    expect(screen.getByText("fetch_data")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses again when toggle clicked twice", () => {
    render(<LogBlock lines={sampleLines} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(screen.queryByTestId("logblock-lines")).not.toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it('shows "Ocultar logs" text when expanded', () => {
    render(<LogBlock lines={sampleLines} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent(/Ocultar logs/i);
  });

  // -----------------------------------------------------------------------
  // Controlled mode
  // -----------------------------------------------------------------------

  it("respects controlled expanded=true without clicking", () => {
    render(<LogBlock lines={sampleLines} expanded={true} />);
    expect(screen.getByTestId("logblock-lines")).toBeInTheDocument();
  });

  it("calls onToggle when controlled button is clicked", () => {
    const onToggle = vi.fn();
    render(<LogBlock lines={sampleLines} expanded={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // Line detail rendering
  // -----------------------------------------------------------------------

  it("renders line detail text when provided", () => {
    render(<LogBlock lines={sampleLines} streaming />);
    // Detail is rendered in its own span — check it appears somewhere in the document
    const container = screen.getByTestId("logblock-streaming");
    expect(container.textContent).toContain("6 widgets");
  });

  it("renders lines without detail gracefully", () => {
    const linesNoDetail: LogLine[] = [
      { timestamp: "+0.0s", kind: "tool", label: "init" },
    ];
    render(<LogBlock lines={linesNoDetail} streaming />);
    expect(screen.getByText("init")).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Line append simulation
  // -----------------------------------------------------------------------

  it("shows updated line count after re-render with more lines", () => {
    const initial: LogLine[] = [sampleLines[0]];
    const { rerender } = render(<LogBlock lines={initial} streaming />);
    let container = screen.getByTestId("logblock-streaming");
    expect(container.textContent).toMatch(/1 paso[^s]/);

    rerender(<LogBlock lines={sampleLines} streaming />);
    container = screen.getByTestId("logblock-streaming");
    expect(container.textContent).toMatch(/3 paso/);
  });
});
