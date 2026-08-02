// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { EvolutionCharts } from "../EvolutionCharts";
import type { EtlStatsData } from "../EvolutionCharts";

// Polyfill ResizeObserver (required by Tremor/recharts)
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EMPTY_STATS: EtlStatsData = {
  duration_trend: [],
  listings_trend: [],
  connector_durations: [],
  top_connectors_by_listings: [],
  success_rate: { total: 0, success: 0, partial: 0, failed: 0 },
  last_run: {
    run_id: null,
    duration_ms: null,
    total_discovered: null,
    total_fetched: null,
    fetch_rate: null,
  },
  errors_24h: { runs_failed: 0, connectors_failed: 0 },
};

const POPULATED_STATS: EtlStatsData = {
  duration_trend: [
    { started_at: "2026-04-10T02:00:00Z", duration_ms: 3600000, status: "success" },
    { started_at: "2026-04-11T02:00:00Z", duration_ms: 1800000, status: "partial" },
    { started_at: "2026-04-12T02:00:00Z", duration_ms: null, status: "failed" },
  ],
  listings_trend: [
    { started_at: "2026-04-10T02:00:00Z", discovered: 72, fetched: 45 },
    { started_at: "2026-04-11T02:00:00Z", discovered: 68, fetched: 30 },
  ],
  connector_durations: [
    { connector_name: "fotocasa", avg_duration_ms: 900000, last_duration_ms: 850000 },
    { connector_name: "milanuncios", avg_duration_ms: 2700000, last_duration_ms: 2600000 },
  ],
  top_connectors_by_listings: [
    { connector_name: "fotocasa", fetched_count: 28 },
    { connector_name: "milanuncios", fetched_count: 17 },
  ],
  success_rate: { total: 30, success: 25, partial: 3, failed: 2 },
  last_run: {
    run_id: 42,
    duration_ms: 3600000,
    total_discovered: 72,
    total_fetched: 45,
    fetch_rate: 0.625,
  },
  errors_24h: { runs_failed: 1, connectors_failed: 2 },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("EvolutionCharts", () => {
  it("renders the charts container", () => {
    render(<EvolutionCharts stats={POPULATED_STATS} />);
    expect(screen.getByTestId("evolution-charts")).toBeInTheDocument();
  });

  it("shows empty states when stats are empty", () => {
    render(<EvolutionCharts stats={EMPTY_STATS} />);
    const emptyMessages = screen.getAllByText("Sin datos disponibles");
    // 5 empty charts: duration, listings funnel, slowest connectors,
    // listings-per-connector, outcomes
    expect(emptyMessages.length).toBe(5);
  });

  it("renders the per-connector listings panel when data is available", () => {
    render(<EvolutionCharts stats={POPULATED_STATS} />);
    expect(screen.getByTestId("top-connectors-by-listings")).toBeInTheDocument();
    expect(
      screen.getByText("Anuncios guardados por conector (última ejecución)"),
    ).toBeInTheDocument();
  });

  it("renders the discovered-vs-stored funnel chart", () => {
    // Two series, not one — the gap between them is the health signal this
    // project has and the per-table model it replaced did not.
    render(<EvolutionCharts stats={POPULATED_STATS} />);
    expect(screen.getByTestId("listings-funnel-chart")).toBeInTheDocument();
  });

  it("renders duration trend chart title", () => {
    render(<EvolutionCharts stats={POPULATED_STATS} />);
    expect(
      screen.getByText("Tendencia de duración (últimas 30 ejecuciones)")
    ).toBeInTheDocument();
  });

  it("renders listings funnel chart title", () => {
    render(<EvolutionCharts stats={POPULATED_STATS} />);
    expect(
      screen.getByText("Anuncios por ejecución (encontrados vs. guardados)")
    ).toBeInTheDocument();
  });

  it("renders slowest-connectors chart title", () => {
    render(<EvolutionCharts stats={POPULATED_STATS} />);
    expect(
      screen.getByText("Conectores más lentos (duración media)")
    ).toBeInTheDocument();
  });

  it("renders outcomes donut chart title", () => {
    render(<EvolutionCharts stats={POPULATED_STATS} />);
    expect(
      screen.getByText("Resultados de ejecuciones (últimas 30)")
    ).toBeInTheDocument();
  });

  it("shows empty state for duration trend when all values are null", () => {
    const stats: EtlStatsData = {
      ...POPULATED_STATS,
      duration_trend: [
        { started_at: "2026-04-10T02:00:00Z", duration_ms: null, status: "failed" },
      ],
    };
    render(<EvolutionCharts stats={stats} />);
    // duration chart section falls back to EmptyChart
    const emptyMessages = screen.getAllByText("Sin datos disponibles");
    expect(emptyMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("shows empty state for donut when success_rate total is 0", () => {
    const stats: EtlStatsData = {
      ...POPULATED_STATS,
      success_rate: { total: 0, success: 0, partial: 0, failed: 0 },
    };
    render(<EvolutionCharts stats={stats} />);
    const emptyMessages = screen.getAllByText("Sin datos disponibles");
    expect(emptyMessages.length).toBeGreaterThanOrEqual(1);
  });
});
