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
  total_connectors: 2,
  connectors_ok: 2,
  connectors_failed: 0,
  connectors_skipped: 0,
  total_discovered: 72,
  total_fetched: 45,
  trigger: "scheduled",
};

const failedRun = {
  ...successRun,
  id: 2,
  status: "partial" as const,
  connectors_ok: 1,
  connectors_failed: 1,
};

const runningRun = {
  ...successRun,
  id: 3,
  status: "running" as const,
  finished_at: null,
  duration_ms: null,
  trigger: "manual",
};

/** A run where the operator disabled a connector (issue #99). */
const skippedRun = {
  ...successRun,
  id: 4,
  connectors_ok: 1,
  connectors_failed: 0,
  connectors_skipped: 1,
};

const sampleConnectors = [
  {
    id: 1,
    connector_name: "fotocasa",
    started_at: "2026-04-15T02:00:00Z",
    finished_at: "2026-04-15T02:15:00Z",
    duration_ms: 900000,
    status: "ok" as const,
    discovered_count: 31,
    fetched_count: 28,
    error_count: 3,
    error_msg: null,
    failure_classification: null,
    geography_scope: [
      { scope_key: "madrid", center: [40.4, -3.7] as [number, number], radius_km: 10, rooms: null, outcome: "crawled" },
    ],
    // Healthy run with a stable trend (small +delta, not degraded).
    extraction_quality_summary: {
      n: 28,
      mean_score: 0.88,
      grade_histogram: { A: 20, B: 6, C: 2, F: 0 },
      low_quality_count: 2,
      weights_version: 1,
      trend: { baseline_mean: 0.86, baseline_n_runs: 4, delta: 0.02, degraded: false },
    },
  },
  {
    id: 2,
    connector_name: "milanuncios",
    started_at: "2026-04-15T02:15:00Z",
    finished_at: "2026-04-15T02:20:00Z",
    duration_ms: 300000,
    status: "ok" as const,
    discovered_count: 41,
    fetched_count: 17,
    error_count: 0,
    error_msg: null,
    failure_classification: null,
    geography_scope: null,
    // status='ok', zero errors — but extraction quality silently dropped vs the
    // connector's recent baseline: exactly the issue #171 failure mode.
    extraction_quality_summary: {
      n: 17,
      mean_score: 0.6,
      grade_histogram: { A: 2, B: 3, C: 7, F: 5 },
      low_quality_count: 12,
      weights_version: 1,
      trend: { baseline_mean: 0.9, baseline_n_runs: 5, delta: -0.3, degraded: true },
    },
  },
  {
    id: 3,
    connector_name: "idealista",
    started_at: "2026-04-15T02:20:00Z",
    finished_at: "2026-04-15T02:21:00Z",
    duration_ms: 60000,
    status: "failed" as const,
    discovered_count: 0,
    fetched_count: 0,
    error_count: 1,
    error_msg: "Connection timeout after 60s: could not connect to server",
    failure_classification: "network",
    geography_scope: [
      { scope_key: "sevilla", center: null, radius_km: null, rooms: null, outcome: "failed" },
    ],
    // A failed run produced no listings — no quality to aggregate.
    extraction_quality_summary: null,
  },
];

/** circuit_open + skipped — the two states the old per-table UI had no concept of. */
const newStatusConnectors = [
  {
    id: 10,
    connector_name: "fotocasa",
    started_at: "2026-04-15T02:00:00Z",
    finished_at: "2026-04-15T02:05:00Z",
    duration_ms: 300000,
    status: "circuit_open" as const,
    discovered_count: 31,
    fetched_count: 4,
    error_count: 8,
    error_msg: "circuit breaker open after 8/10 errors",
    failure_classification: "structure_change",
    geography_scope: null,
    extraction_quality_summary: null,
  },
  {
    id: 11,
    connector_name: "milanuncios",
    started_at: "2026-04-15T02:05:00Z",
    finished_at: "2026-04-15T02:05:00Z",
    duration_ms: 0,
    status: "skipped" as const,
    discovered_count: 0,
    fetched_count: 0,
    error_count: 0,
    error_msg: "disabled via connector_config",
    failure_classification: null,
    geography_scope: null,
    extraction_quality_summary: null,
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
      json: () => Promise.resolve({ run: successRun, connectors: sampleConnectors }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("run-detail")).toBeInTheDocument(); });
    expect(screen.getByText(/Ejecución #1/)).toBeInTheDocument();
    expect(screen.getByTestId("kpi-row")).toBeInTheDocument();
  });

  it("KPI shows correct duration, connector count, and trigger", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: successRun, connectors: [] }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("kpi-row")).toBeInTheDocument(); });
    expect(screen.getByText("1h 23m 45s")).toBeInTheDocument();
    expect(screen.getByText("2 / 0")).toBeInTheDocument();
    expect(screen.getByText("Programado")).toBeInTheDocument();
  });

  it("shows per-connector stats table with correct rows", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: successRun, connectors: sampleConnectors }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("connector-stats")).toBeInTheDocument(); });
    expect(screen.getByTestId("connector-row-fotocasa")).toBeInTheDocument();
    expect(screen.getByTestId("connector-row-milanuncios")).toBeInTheDocument();
    expect(screen.getByTestId("connector-row-idealista")).toBeInTheDocument();
  });

  it("shows error message in red for failed connectors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: failedRun, connectors: sampleConnectors }),
    });
    render(<RunDetail runId="2" />);
    await waitFor(() => { expect(screen.getByTestId("connector-stats")).toBeInTheDocument(); });
    const errorRow = screen.getByTestId("connector-row-idealista-error");
    expect(errorRow).toBeInTheDocument();
    const errorBtn = errorRow.querySelector("button");
    expect(errorBtn).toHaveClass("text-red-500");
    expect(errorBtn?.textContent).toContain("Connection timeout");
  });

  it("shows bar chart when connectors have duration data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: successRun, connectors: sampleConnectors }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("bar-chart")).toBeInTheDocument(); });
  });

  it("shows in-progress badge for running run", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: runningRun, connectors: [] }),
    });
    render(<RunDetail runId="3" />);
    await waitFor(() => { expect(screen.getByTestId("run-detail")).toBeInTheDocument(); });
    expect(screen.getByText(/En progreso/)).toBeInTheDocument();
    expect(screen.getByText(/Manual/)).toBeInTheDocument();
  });

  it("shows empty state when connectors array is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: successRun, connectors: [] }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("run-detail")).toBeInTheDocument(); });
    expect(screen.getByText(/Sin resultados de conectores/)).toBeInTheDocument();
    expect(screen.queryByTestId("connector-stats")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bar-chart")).not.toBeInTheDocument();
  });

  it("renders the discovered→fetched→errors funnel per connector", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: successRun, connectors: sampleConnectors }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("connector-stats")).toBeInTheDocument(); });
    const row = screen.getByTestId("connector-row-fotocasa");
    // 31 discovered → 28 stored → 3 errored. The gap is the signal.
    expect(row.textContent).toContain("31");
    expect(row.textContent).toContain("28");
    expect(row.textContent).toContain("3");
  });

  it("surfaces the typed failure classification and the resolved geography scope (#242/#109)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: failedRun, connectors: sampleConnectors }),
    });
    render(<RunDetail runId="2" />);
    await waitFor(() => { expect(screen.getByTestId("connector-stats")).toBeInTheDocument(); });

    // #242: the failed connector's typed kind renders as a human label, not
    // the raw enum value.
    const failureBadge = screen.getByTestId("connector-failure-idealista");
    expect(failureBadge.textContent).toBe("Red / conexión");
    // A clean connector carries no failure badge.
    expect(screen.queryByTestId("connector-failure-milanuncios")).not.toBeInTheDocument();

    // #109: the geography a run ran against is displayed per connector, with
    // its per-scope outcome (crawled here) — the audit trail #109 asked for.
    const geoRow = screen.getByTestId("connector-row-fotocasa-geo");
    expect(geoRow.textContent).toContain("madrid");
    expect(geoRow.textContent).toContain("Rastreada");
    // The failed connector's geography shows its 'failed' outcome.
    const idealistaGeo = screen.getByTestId("connector-row-idealista-geo");
    expect(idealistaGeo.textContent).toContain("Error");
    // A connector with no recorded scope shows no geography row.
    expect(screen.queryByTestId("connector-row-milanuncios-geo")).not.toBeInTheDocument();
  });

  it("flags a silently-degraded connector and leaves a stable one unflagged (#171)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: successRun, connectors: sampleConnectors }),
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("connector-stats")).toBeInTheDocument(); });

    // milanuncios ran status='ok' with zero errors, but its extraction quality
    // dropped 30pp vs its baseline — the degraded badge is what makes that
    // visible. This is the whole point of #171.
    const degraded = screen.getByTestId("connector-quality-trend-milanuncios");
    expect(degraded.textContent).toContain("Calidad");
    expect(degraded.textContent).toContain("30 pp");

    // fotocasa is healthy and stable — it must NOT carry the red degraded
    // badge. Its quality cell still renders (grade + percent).
    const fotocasaTrend = screen.getByTestId("connector-quality-trend-fotocasa");
    expect(fotocasaTrend.textContent).not.toContain("Calidad");
    expect(screen.getByTestId("connector-quality-fotocasa").textContent).toContain("88 %");

    // idealista failed and produced no listings — an em dash, no fabricated 0%.
    expect(screen.getByTestId("connector-quality-idealista").textContent).toBe("—");
  });

  it("renders circuit_open and skipped as distinct states", async () => {
    // Neither existed in the per-table model this UI was inherited from —
    // a tripped breaker used to be invisible, and a disabled connector was
    // indistinguishable from one that simply had nothing to do.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: skippedRun, connectors: newStatusConnectors }),
    });
    render(<RunDetail runId="4" />);
    await waitFor(() => { expect(screen.getByTestId("connector-stats")).toBeInTheDocument(); });
    expect(screen.getByText("Circuito abierto")).toBeInTheDocument();
    expect(screen.getByText("Omitido")).toBeInTheDocument();
  });

  it("does not render a skipped connector's reason as an error", async () => {
    // "disabled via connector_config" is informational — rendering it in
    // alarm-red would tell an operator their own deliberate setting is a
    // fault.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: skippedRun, connectors: newStatusConnectors }),
    });
    render(<RunDetail runId="4" />);
    await waitFor(() => { expect(screen.getByTestId("connector-stats")).toBeInTheDocument(); });

    const skippedBtn = screen
      .getByTestId("connector-row-milanuncios-error")
      .querySelector("button");
    expect(skippedBtn?.textContent).toContain("disabled via connector_config");
    expect(skippedBtn).not.toHaveClass("text-red-500");

    // ...while a real fault still is red.
    const brokenBtn = screen
      .getByTestId("connector-row-fotocasa-error")
      .querySelector("button");
    expect(brokenBtn).toHaveClass("text-red-500");
  });

  it("KPI surfaces the skipped count alongside ok/failed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ run: skippedRun, connectors: newStatusConnectors }),
    });
    render(<RunDetail runId="4" />);
    await waitFor(() => { expect(screen.getByTestId("kpi-row")).toBeInTheDocument(); });
    expect(screen.getByText("1 / 0 / 1")).toBeInTheDocument();
    expect(screen.getByText(/1 omitido/)).toBeInTheDocument();
  });

  it("sets up auto-refresh for running run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ run: runningRun, connectors: [] }) });
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
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ run: successRun, connectors: [] }) });
    });
    render(<RunDetail runId="1" />);
    await waitFor(() => { expect(screen.getByTestId("run-detail")).toBeInTheDocument(); });
    const countAfterLoad = fetchCount;
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(fetchCount).toBe(countAfterLoad);
    vi.useRealTimers();
  });
});
