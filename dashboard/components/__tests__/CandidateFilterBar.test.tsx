// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
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

describe("CandidateFilterBar #470 free-text search box", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the primary-row search box seeded from `q`", () => {
    renderBar({ q: "terraza" });
    const box = screen.getByTestId("search-input") as HTMLInputElement;
    expect(box).toBeInTheDocument();
    expect(box.value).toBe("terraza");
    // An active search surfaces its chip.
    expect(screen.getByTestId("filter-chip-q")).toHaveTextContent(
      "Búsqueda: «terraza»",
    );
  });

  it("debounces typing into a single onChange with the trimmed term", () => {
    vi.useFakeTimers();
    const { onChange } = renderBar();
    const box = screen.getByTestId("search-input");

    // Several keystrokes in quick succession.
    fireEvent.change(box, { target: { value: "ter" } });
    fireEvent.change(box, { target: { value: "terra" } });
    fireEvent.change(box, { target: { value: "terraza " } });
    // Before the debounce window elapses, nothing is emitted.
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(350);
    });
    // Exactly one emit, carrying the last (trimmed) value.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ q: "terraza" }),
    );
  });

  it("Enter commits the term immediately (no debounce wait)", () => {
    vi.useFakeTimers();
    const { onChange } = renderBar();
    const box = screen.getByTestId("search-input");
    fireEvent.change(box, { target: { value: "embargo" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ q: "embargo" }),
    );
  });

  it("the ✕ button clears only the search", () => {
    const { onChange } = renderBar({ q: "terraza", source: "fotocasa" });
    fireEvent.click(screen.getByTestId("search-clear"));
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_CANDIDATE_FILTERS,
      q: "", // cleared
      source: "fotocasa", // untouched
    });
  });

  it("the q chip's ✕ clears only the search", () => {
    const { onChange } = renderBar({ q: "terraza", minDiscount: "15" });
    fireEvent.click(screen.getByTestId("filter-chip-clear-q"));
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_CANDIDATE_FILTERS,
      q: "",
      minDiscount: "15",
    });
  });
});

describe("CandidateFilterBar more-filters popover + clear all", () => {
  it("badges the popover button with the count of active AI-gated filters", () => {
    renderBar({ occupancy: "free", caveat: "usufructo" });
    expect(screen.getByTestId("more-filters-count")).toHaveTextContent("2");
  });

  it("keeps Limpiar todo always visible but disabled when no filter is active", () => {
    // Always rendered (no layout jump); disabled when nothing is active.
    const { onChange, values } = renderBar();
    void values;
    const clearBtn = screen.getByTestId("clear-all-filters");
    expect(clearBtn).toBeInTheDocument();
    expect(clearBtn).toBeDisabled();
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
