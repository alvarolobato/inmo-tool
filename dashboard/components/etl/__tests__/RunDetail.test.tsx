// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RunDetail, formatDuration, formatNumber } from "../RunDetail";

// ─── Mock next/link ──────────────────────────────────────────────────────────

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

// ─── Mock @tremor/react ────────────────────────────────────────────────────────

vi.mock("@tremor/react", () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
  Badge: ({ children, color, "data-testid": testId }: { children: React.ReactNode; color: string; "data-testid"?: string }) => (
    <span data-testid={testId} data-color={color}>{children}</span>
  ),
  BarChart: ({ data }: { data: unknown[] }) => <div data-testid="bar-chart" data-count={data.length} />,
}));

// ─── Test data ────────────────────────────────────────────────────────────────

const successRun = {
  id: 1,
  started_at: "2026-04-15T02:00:00Z",
  finished_at: "2026-04-15T03:23:45Z",
  duration_ms: 5025000,
  status: "success" as const,
  total_tables: 22,
  tables_ok: 22,
  tables_failed: 0,
  total_rows_synced: 18500000,
  trigger: "scheduled" as const,
  kind: "full" as const,
};

const failedRun = {
  ...successRun,
  id: 2,
  status: "partial" as const,
  tables_ok: 20,
  tables_failed: 2,
};

const runningRun = {
  ...successRun,
  id: 3,
  status: "running" as const,
  finished_at: null,
  duration_ms: null,
  trigger: "manual" as const,
};

const sampleTables = [
  {
    id: 1,
    table_name: "ps_ventas",
    started_at: "2026-04-15T02:00:00Z",
    finished_at: "2026-04-15T02:15:00Z",
    duration_ms: 900000,
    status: "success" as const,
    rows_synced: 911000,
    rows_total_after: 911000,
    sync_method: "upsert_delta" as const,
    watermark_from: "2026-04-14T00:00:00Z",
    watermark_to: "2026-04-15T00:00:00Z",
    error_msg: null,
  },
  {
    id: 2,
    table_name: "ps_articulos",
    started_at: "2026-04-15T02:15:00Z",
    finished_at: "2026-04-15T02:20:00Z",
    duration_ms: 300000,
    status: "success" as const,
    rows_synced: 45000,
    rows_total_after: 45000,
    sync_method: "full_refresh" as const,
    watermark_from: null,
    watermark_to: null,
    error_msg: null,
  },
  {
    id: 3,
    table_name: "ps_clientes",
    started_at: "2026-04-15T02:20:00Z",
    finished_at: "2026-04-15T02:21:00Z",
    duration_ms: 60000,
    status: "failed" as const,
    rows_synced: null,
    rows_total_after: null,
    sync_method: "full_refresh" as const,
    watermark_from: null,
    watermark_to: null,
    error_msg: "Connection timeout after 60s: could not connect to server",
  },
];

// ─── formatDuration tests ─────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("returns dash for null", () => { expect(formatDuration(null)).toBe("—"); });
  it("shows ms for sub-second", () => { expect(formatDuration(500)).toBe("500ms"); });
  it("shows seconds only", () => { expect(formatDuration(45000)).toBe("45s"); });
  it("shows minutes and seconds", () => { expect(formatDuration(125000)).toBe("2m 5s"); });
  it("shows hours minutes seconds", () => { expect(formatDuration(5025000)).toBe("1h 23m 45s"); });
});

describe("formatNumber", () => {
  it("returns dash for null", () => { expect(formatNumber(null)).toBe("—"); });
  it("formats zero", () => { expect(formatNumber(0)).toBe("0"); });
  it("formats large numbers", () => {
    const result = formatNumber(18500000);
    expect(result).toContain("18");
    expect(result).toContain("500");
  });
});

describe("RunDetail component", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); globalThis.fetch = originalFetch; });

  it("shows loading spinner initially", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<RunDetail runId="1" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows not-found state on 404", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 404, ok: false, json: () => Promise.resolve({}) });
    render(<RunDetail runId="99999" />);
    await waitFor(() => { expect(screen.getByTestId("not-found")).toBeInTheDocument(); });
    expect(screen.getByText(/Ejecución no encontrada/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Volver al monitor/ })).toHaveAttribute("href", "/etl");
  });

  it("shows error state on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("error-state")).toBeInTheDocument(); });
    expect(screen.getByTestId("error-message")).toHaveTextContent("Network error");
    expect(screen.getByText("Reintentar")).toBeInTheDocument();
  });

  it("renders run detail with KPI row after success fetch", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: successRun, tables: sampleTables }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("run-detail")).toBeInTheDocument(); });
    expect(screen.getByText(/Ejecución #1/)).toBeInTheDocument();
    expect(screen.getByTestId("kpi-row")).toBeInTheDocument();
  });

  it("KPI shows correct duration, tables count, and trigger", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: successRun, tables: [] }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("kpi-row")).toBeInTheDocument(); });
    expect(screen.getByText("1h 23m 45s")).toBeInTheDocument();
    expect(screen.getByText("22 / 0")).toBeInTheDocument();
    expect(screen.getByText("Programado")).toBeInTheDocument();
  });

  it("shows per-table stats table with correct rows", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: successRun, tables: sampleTables }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("table-stats")).toBeInTheDocument(); });
    expect(screen.getByTestId("table-row-ps_ventas")).toBeInTheDocument();
    expect(screen.getByTestId("table-row-ps_articulos")).toBeInTheDocument();
    expect(screen.getByTestId("table-row-ps_clientes")).toBeInTheDocument();
  });

  it("shows error message in red for failed tables", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: failedRun, tables: sampleTables }),
    });
    render(<RunDetail runId="2" />);
    await waitFor(() => { expect(screen.getByTestId("table-stats")).toBeInTheDocument(); });
    const errorRow = screen.getByTestId("table-row-ps_clientes-error");
    expect(errorRow).toBeInTheDocument();
    const errorBtn = errorRow.querySelector("button");
    expect(errorBtn).toHaveClass("text-red-500");
    expect(errorBtn?.textContent).toContain("Connection timeout");
  });

  it("shows bar chart when tables have duration data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: successRun, tables: sampleTables }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("bar-chart")).toBeInTheDocument(); });
  });

  it("shows in-progress badge for running run", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: runningRun, tables: [] }),
    });
    render(<RunDetail runId="3" />);
    await waitFor(() => { expect(screen.getByTestId("run-detail")).toBeInTheDocument(); });
    expect(screen.getByText(/En progreso/)).toBeInTheDocument();
    expect(screen.getByText(/Manual/)).toBeInTheDocument();
  });

  it("shows empty state when tables array is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: successRun, tables: [] }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("run-detail")).toBeInTheDocument(); });
    expect(screen.getByText(/Sin estadísticas de tablas disponibles/)).toBeInTheDocument();
    expect(screen.queryByTestId("table-stats")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bar-chart")).not.toBeInTheDocument();
  });

  it("sets up auto-refresh for running run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ run: runningRun, tables: [] }) });
    });
    render(<RunDetail runId="3" />);
    await waitFor(() => { expect(screen.getByTestId("run-detail")).toBeInTheDocument(); });
    // Flush pending effects so the auto-refresh setInterval is registered before we advance
    await act(async () => {});
    const countAfterLoad = fetchCount;
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(fetchCount).toBeGreaterThan(countAfterLoad);
    vi.useRealTimers();
  });

  it("does not auto-refresh for completed run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ run: successRun, tables: [] }) });
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("run-detail")).toBeInTheDocument(); });
    const countAfterLoad = fetchCount;
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(fetchCount).toBe(countAfterLoad);
    vi.useRealTimers();
  });
});
