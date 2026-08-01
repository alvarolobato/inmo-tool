// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { DashboardFiltersBar } from "../DashboardFiltersBar";
import type { DashboardSpec } from "@/lib/schema";

// Headless UI Combobox uses ResizeObserver internally
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

const baseSpec: DashboardSpec = {
  title: "T",
  widgets: [{ type: "number", title: "N", sql: "SELECT 1", format: "number" }],
  filters: [
    {
      id: "tienda",
      type: "single_select",
      label: "Tienda",
      bind_expr: `v."tienda"`,
      value_type: "text",
      options_sql: "SELECT 1",
    },
  ],
};

const numericSpec: DashboardSpec = {
  ...baseSpec,
  filters: [
    {
      id: "n",
      type: "single_select",
      label: "N",
      bind_expr: "t.x",
      value_type: "numeric",
      options_sql: "SELECT 1",
    },
  ],
};

const multiSpec: DashboardSpec = {
  ...baseSpec,
  filters: [
    {
      id: "familia",
      type: "multi_select",
      label: "Familia",
      bind_expr: `fm."fami_grup_marc"`,
      value_type: "text",
      options_sql: "SELECT 1",
    },
  ],
};

function mockOptions(opts: { value: string; label: string }[]) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ options: opts }),
  } as unknown as Response);
}

describe("DashboardFiltersBar", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads options and calls onChange when single selection changes", async () => {
    mockOptions([
      { value: "A", label: "Alfa" },
      { value: "B", label: "Beta" },
    ]);

    const onChange = vi.fn();

    render(
      <DashboardFiltersBar
        dashboardId={1}
        spec={baseSpec}
        value={{}}
        onChange={onChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("global-filters-bar")).toBeInTheDocument();
    });

    // Wait for options to actually be loaded into the UI, then open + click.
    const input = screen.getByLabelText("Tienda") as HTMLInputElement;
    await act(async () => {
      input.focus();
      fireEvent.click(screen.getByLabelText(/Abrir opciones de Tienda/));
    });
    await waitFor(() => {
      expect(screen.getByText("Alfa")).toBeInTheDocument();
    });
    await act(async () => {
      const el = screen.getByText("Alfa");
      fireEvent.pointerDown(el);
      fireEvent.mouseDown(el);
      fireEvent.mouseUp(el);
      fireEvent.click(el);
    });

    expect(onChange).toHaveBeenCalledWith({ tienda: "A" });
  });

  it("shows numeric single_select selection and emits a number", async () => {
    mockOptions([
      { value: "42", label: "42" },
      { value: "7", label: "7" },
    ]);

    const onChange = vi.fn();

    render(
      <DashboardFiltersBar
        dashboardId={1}
        spec={numericSpec}
        value={{ n: 42 }}
        onChange={onChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("global-filters-bar")).toBeInTheDocument();
    });

    const nInput = screen.getByLabelText("N") as HTMLInputElement;
    await act(async () => {
      nInput.focus();
      fireEvent.click(screen.getByLabelText(/Abrir opciones de N/));
    });
    await waitFor(() => {
      expect(screen.getByText("7")).toBeInTheDocument();
    });
    await act(async () => {
      const el = screen.getByText("7");
      fireEvent.pointerDown(el);
      fireEvent.mouseDown(el);
      fireEvent.mouseUp(el);
      fireEvent.click(el);
    });
    expect(onChange).toHaveBeenCalledWith({ n: 7 });
  });

  it("multi_select emits an array of string values", async () => {
    mockOptions([
      { value: "CAMI", label: "Camisetas" },
      { value: "PAN", label: "Pantalones" },
    ]);

    const onChange = vi.fn();

    render(
      <DashboardFiltersBar
        dashboardId={1}
        spec={multiSpec}
        value={{}}
        onChange={onChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("global-filters-bar")).toBeInTheDocument();
    });

    const famInput = screen.getByLabelText("Familia") as HTMLInputElement;
    await act(async () => {
      famInput.focus();
      fireEvent.click(screen.getByLabelText(/Abrir opciones de Familia/));
    });
    await waitFor(() => {
      expect(screen.getByText("Camisetas")).toBeInTheDocument();
    });
    await act(async () => {
      const el = screen.getByText("Camisetas");
      fireEvent.pointerDown(el);
      fireEvent.mouseDown(el);
      fireEvent.mouseUp(el);
      fireEvent.click(el);
    });

    expect(onChange).toHaveBeenCalledWith({ familia: ["CAMI"] });
  });
});
