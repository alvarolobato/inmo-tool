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
  rows_trend: [],
  table_durations: [],
  top_tables_by_rows: [],
  success_rate: { total: 0, success: 0, partial: 0, failed: 0 },
  last_run: {
    run_id: null,
    duration_ms: null,
    total_rows_synced: null,
    throughput_rows_per_sec: null,
  },
  watermarks: { max_age_seconds: null, table_name: null },
  errors_24h: { runs_failed: 0, tables_failed: 0 },
};

const POPULATED_STATS: EtlStatsData = {
  duration_trend: [
    { started_at: "2026-04-10T02:00:00Z", duration_ms: 3600000, status: "success" },
    { started_at: "2026-04-11T02:00:00Z", duration_ms: 1800000, status: "partial" },
    { started_at: "2026-04-12T02:00:00Z", duration_ms: null, status: "failed" },
  ],
  rows_trend: [
    { started_at: "2026-04-10T02:00:00Z", total_rows_synced: 45000 },
    { started_at: "2026-04-11T02:00:00Z", total_rows_synced: 30000 },
  ],
  table_durations: [
    { table_name: "ps_ventas", avg_duration_ms: 900000, last_duration_ms: 850000 },
    { table_name: "ps_stock", avg_duration_ms: 2700000, last_duration_ms: 2600000 },
  ],
  top_tables_by_rows: [
    { table_name: "ps_stock_tienda", rows_synced: 12_300_000 },
    { table_name: "ps_lineas_ventas", rows_synced: 1_700_000 },
  ],
  success_rate: { total: 30, success: 25, partial: 3, failed: 2 },
  last_run: {
    run_id: 42,
    duration_ms: 3600000,
    total_rows_synced: 45000,
    throughput_rows_per_sec: 12.5,
  },
  watermarks: { max_age_seconds: 90_000, table_name: "ps_stock" },
  errors_24h: { runs_failed: 1, tables_failed: 2 },
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
    // 5 empty charts: duration, rows, top-slowest, top-rows, outcomes
    expect(emptyMessages.length).toBe(5);
  });

  it("renders the top-tables-by-rows panel when rows are available", () => {
    render(<EvolutionCharts stats={POPULATED_STATS} />);
    expect(screen.getByTestId("top-tables-by-rows")).toBeInTheDocument();
    expect(
      screen.getByText("Top tablas por filas (última sincronización)"),
    ).toBeInTheDocument();
  });

  it("renders duration trend chart title", () => {
    render(<EvolutionCharts stats={POPULATED_STATS} />);
    expect(
      screen.getByText("Tendencia de duración (últimas 30 ejecuciones)")
    ).toBeInTheDocument();
  });

  it("renders rows trend chart title", () => {
    render(<EvolutionCharts stats={POPULATED_STATS} />);
    expect(
      screen.getByText("Filas sincronizadas por ejecución")
    ).toBeInTheDocument();
  });

  it("renders top tables chart title", () => {
    render(<EvolutionCharts stats={POPULATED_STATS} />);
    expect(
      screen.getByText("Top 10 tablas más lentas (duración media)")
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
