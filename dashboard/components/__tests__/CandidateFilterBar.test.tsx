// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CandidateFilterBar } from "../candidates/CandidateFilterBar";
import {
  DEFAULT_CANDIDATE_FILTERS,
  type CandidateFilters,
} from "@/lib/candidate-filters";

function renderBar(overrides: Partial<CandidateFilters> = {}) {
  const values: CandidateFilters = { ...DEFAULT_CANDIDATE_FILTERS, ...overrides };
  const onChange = vi.fn<[CandidateFilters], void>();
  render(
    <CandidateFilterBar
      values={values}
      onChange={onChange}
      availableSources={["fotocasa", "idealista"]}
      seguimientoAlertCount={0}
    />,
  );
  return { onChange, values };
}

describe("CandidateFilterBar segmented view (mutual exclusion)", () => {
  it("Todas/En seguimiento/Con descartadas are the only three states, emitted exclusively", () => {
    const { onChange } = renderBar({ view: "all" });

    fireEvent.click(screen.getByTestId("view-segment-seguimiento"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "seguimiento" }),
    );

    fireEvent.click(screen.getByTestId("view-segment-descartadas"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "descartadas" }),
    );

    fireEvent.click(screen.getByTestId("view-segment-todas"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "all" }),
    );
  });

  it("marks the active segment via aria-pressed", () => {
    renderBar({ view: "seguimiento" });
    expect(screen.getByTestId("view-segment-seguimiento")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("view-segment-todas")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows the #428 seguimiento alert badge on the segment when > 0", () => {
    const onChange = vi.fn();
    render(
      <CandidateFilterBar
        values={DEFAULT_CANDIDATE_FILTERS}
        onChange={onChange}
        availableSources={[]}
        seguimientoAlertCount={3}
      />,
    );
    const badge = screen.getByTestId("seguimiento-alert-count");
    expect(badge).toHaveTextContent("3");
    expect(screen.getByTestId("view-segment-seguimiento")).toContainElement(
      badge,
    );
  });
});

describe("CandidateFilterBar active chips", () => {
  it("renders one chip per non-default filter (not for view)", () => {
    renderBar({
      source: "fotocasa",
      occupancy: "occupied",
      heritageZone: true,
      view: "seguimiento", // segment, not a chip
    });
    expect(screen.getByTestId("filter-chip-source")).toHaveTextContent(
      "Fuente: fotocasa",
    );
    expect(screen.getByTestId("filter-chip-occupancy")).toHaveTextContent(
      "Ocupación: Ocupado",
    );
    expect(screen.getByTestId("filter-chip-heritage")).toHaveTextContent(
      "Casco histórico",
    );
    // view is shown by the segmented control, never as a chip.
    expect(screen.queryByTestId("filter-chip-view")).toBeNull();
  });

  it("a chip's ✕ clears exactly that one filter, leaving the others intact", () => {
    const { onChange } = renderBar({
      source: "fotocasa",
      occupancy: "occupied",
      minDiscount: "15",
    });
    fireEvent.click(screen.getByTestId("filter-chip-clear-occupancy"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_CANDIDATE_FILTERS,
      source: "fotocasa",
      occupancy: "", // cleared
      minDiscount: "15", // untouched
    });
  });

  it("renders no chips row when nothing is active", () => {
    renderBar();
    expect(screen.queryByTestId("active-filter-chips")).toBeNull();
  });
});

describe("CandidateFilterBar more-filters popover + clear all", () => {
  it("badges the popover button with the count of active AI-gated filters", () => {
    renderBar({ occupancy: "free", caveat: "usufructo" });
    expect(screen.getByTestId("more-filters-count")).toHaveTextContent("2");
  });

  it("shows Limpiar todo only when a filter is active and resets everything", () => {
    // No active filters → no button.
    const { onChange, values } = renderBar();
    void values;
    expect(screen.queryByTestId("clear-all-filters")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Limpiar todo resets to defaults", () => {
    const { onChange } = renderBar({ source: "idealista", view: "descartadas" });
    fireEvent.click(screen.getByTestId("clear-all-filters"));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_CANDIDATE_FILTERS);
  });

  it("opens the popover to reveal the AI-gated selects and the IA note", () => {
    renderBar();
    // Panel is collapsed initially.
    expect(screen.queryByTestId("occupancy-filter")).toBeNull();
    fireEvent.click(screen.getByTestId("more-filters-button"));
    const panel = screen.getByTestId("more-filters-panel");
    expect(within(panel).getByTestId("occupancy-filter")).toBeInTheDocument();
    expect(within(panel).getByTestId("vpo-filter")).toBeInTheDocument();
    expect(panel).toHaveTextContent(/datos de evaluación IA/i);
  });
});
