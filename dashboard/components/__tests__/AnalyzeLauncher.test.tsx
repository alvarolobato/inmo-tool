// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import AnalyzeLauncher from "../AnalyzeLauncher";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("AnalyzeLauncher", () => {
  it("renders the launch button", () => {
    render(<AnalyzeLauncher />);
    expect(screen.getByTestId("analyze-launcher")).toBeInTheDocument();
  });

  it("returns null when hidden=true", () => {
    const { container } = render(<AnalyzeLauncher hidden />);
    expect(container.firstChild).toBeNull();
  });

  it("calls onOpen with empty string when clicked (no pre-filled prompt)", () => {
    const onOpen = vi.fn();
    render(<AnalyzeLauncher dashboardId={42} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("analyze-launcher"));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith("");
  });

  it("does nothing when clicked without onOpen prop", () => {
    // Should not throw
    render(<AnalyzeLauncher dashboardId={42} />);
    fireEvent.click(screen.getByTestId("analyze-launcher"));
  });
});
