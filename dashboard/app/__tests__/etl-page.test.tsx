// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import EtlMonitorPage from "../etl/page";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({}),
}));

// Tremor chart components use ResizeObserver internally
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_RUNS_RESPONSE = {
  runs: [
    {
      id: 1,
      started_at: "2026-04-10T02:00:00Z",
      finished_at: "2026-04-10T03:00:00Z",
      duration_ms: 3600000,
      status: "success",
      total_connectors: 2,
      connectors_ok: 2,
      connectors_failed: 0,
      connectors_skipped: 0,
      total_discovered: 72,
      total_fetched: 45,
      trigger: "scheduled",
    },
  ],
  total: 1,
};

const MOCK_RUNNING_RUNS_RESPONSE = {
  runs: [
    {
      id: 2,
      started_at: new Date().toISOString(),
      finished_at: null,
      duration_ms: null,
      status: "running",
      total_connectors: 2,
      connectors_ok: 0,
      connectors_failed: 0,
      connectors_skipped: 0,
      total_discovered: 0,
      total_fetched: 0,
      trigger: "manual",
    },
  ],
  total: 1,
};

const MOCK_STATS_RESPONSE = {
  duration_trend: [
    { started_at: "2026-04-10T02:00:00Z", duration_ms: 3600000, status: "success" },
  ],
  listings_trend: [
    { started_at: "2026-04-10T02:00:00Z", discovered: 72, fetched: 45 },
  ],
  connector_durations: [
    { connector_name: "fotocasa", avg_duration_ms: 900000, last_duration_ms: 850000 },
  ],
  top_connectors_by_listings: [
    { connector_name: "fotocasa", fetched_count: 45 },
  ],
  success_rate: { total: 10, success: 9, partial: 1, failed: 0 },
  last_run: {
    run_id: 1,
    duration_ms: 3600000,
    total_discovered: 72,
    total_fetched: 45,
    fetch_rate: 0.625,
  },
  errors_24h: { runs_failed: 0, connectors_failed: 0 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(runsOk = true, statsOk = true) {
  return vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    // Ad-hoc run (issue #244): POST queues a trigger; GET reports its status.
    // The `/api/etl/run` prefix would also match `/api/etl/runs`, so this
    // branch is deliberately checked first and only for the exact path (POST)
    // or the `?id=` status query (GET).
    if (url === "/api/etl/run" && opts?.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ trigger_id: 99, status: "pending", connector_name: null }),
      });
    }
    if (url.startsWith("/api/etl/run?")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ id: 99, status: "done", connector_run_id: 1, error_msg: null }),
      });
    }
    if (url.startsWith("/api/etl/runs")) {
      return Promise.resolve({
        ok: runsOk,
        json: () => Promise.resolve(runsOk ? MOCK_RUNS_RESPONSE : { error: "Server error" }),
      });
    }
    if (url.startsWith("/api/etl/stats")) {
      return Promise.resolve({
        ok: statsOk,
        json: () => Promise.resolve(statsOk ? MOCK_STATS_RESPONSE : { error: "Server error" }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EtlMonitorPage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── 1. Loading skeletons ──────────────────────────────────────────────────

  it("shows loading skeletons while fetching", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<EtlMonitorPage />);

    // KpiSkeleton and ChartSkeleton both carry aria-busy="true"
    const busyElements = document.querySelectorAll('[aria-busy="true"]');
    expect(busyElements.length).toBeGreaterThan(0);

    // The page wrapper itself should already be in the DOM
    expect(screen.getByTestId("etl-monitor-page")).toBeInTheDocument();
  });

  // ── 2. KPI row and heading after successful fetches ───────────────────────

  it("renders KPI row and history heading after both fetches succeed", async () => {
    globalThis.fetch = mockFetch();
    render(<EtlMonitorPage />);

    // KPI row appears once loading is done
    await waitFor(() => {
      expect(screen.getByTestId("kpi-row")).toBeInTheDocument();
    });

    // Section heading is always rendered (not gated on loading)
    expect(screen.getByText("Historial de ejecuciones")).toBeInTheDocument();
  });

  // ── 3. Run list rendered after successful fetches ─────────────────────────

  it("renders run list after fetches succeed", async () => {
    globalThis.fetch = mockFetch();
    render(<EtlMonitorPage />);

    await waitFor(() => {
      expect(screen.getByTestId("run-list")).toBeInTheDocument();
    });

    // The single mock run row should be present
    expect(screen.getByTestId("run-row-1")).toBeInTheDocument();
  });

  // ── 4. Error when /api/etl/runs fails ────────────────────────────────────

  it("shows error display when /api/etl/runs fails", async () => {
    globalThis.fetch = mockFetch(false, true);
    render(<EtlMonitorPage />);

    await waitFor(() => {
      expect(screen.getByTestId("error-display")).toBeInTheDocument();
    });

    expect(screen.getByText("Reintentar")).toBeInTheDocument();
  });

  // ── 5. Error when /api/etl/stats fails ───────────────────────────────────

  it("shows error display when /api/etl/stats fails", async () => {
    globalThis.fetch = mockFetch(true, false);
    render(<EtlMonitorPage />);

    await waitFor(() => {
      expect(screen.getByTestId("error-display")).toBeInTheDocument();
    });

    expect(screen.getByText("Reintentar")).toBeInTheDocument();
  });

  // ── 6. handlePageChange calls fetch with new page parameter ──────────────

  it("calls fetch with updated page parameter when page changes", async () => {
    // Provide enough total runs to enable the next-page button (total > perPage=20)
    const multiPageRunsResponse = { ...MOCK_RUNS_RESPONSE, total: 25 };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/etl/runs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(multiPageRunsResponse),
        });
      }
      if (url.startsWith("/api/etl/stats")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_STATS_RESPONSE),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    globalThis.fetch = fetchMock;

    render(<EtlMonitorPage />);

    // Wait for the run list (and therefore the pagination buttons) to appear
    await waitFor(() => {
      expect(screen.getByTestId("run-list")).toBeInTheDocument();
    });

    const nextButton = screen.getByTestId("next-page");
    fireEvent.click(nextButton);

    // After clicking next, a fetch for page=2 must have been made
    await waitFor(() => {
      const runsCalls = fetchMock.mock.calls.filter(([url]: [string]) =>
        url.startsWith("/api/etl/runs")
      );
      const hasPage2Call = runsCalls.some(([url]: [string]) =>
        url.includes("page=2")
      );
      expect(hasPage2Call).toBe(true);
    });
  });

  // ── 7. KPI row shows "—" when there are no runs ──────────────────────────

  it("shows em-dash KPIs when there are no runs", async () => {
    const emptyRunsResponse = { runs: [], total: 0 };
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/etl/runs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(emptyRunsResponse),
        });
      }
      if (url.startsWith("/api/etl/stats")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_STATS_RESPONSE),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });

    render(<EtlMonitorPage />);

    await waitFor(() => {
      expect(screen.getByTestId("kpi-row")).toBeInTheDocument();
    });

    // When no runs exist the first three KPI values should be em-dashes
    const kpiRow = screen.getByTestId("kpi-row");
    const dashValues = kpiRow.querySelectorAll("p.text-xl");
    const dashTexts = Array.from(dashValues).map((el) => el.textContent);
    // "Última sincronización", "Duración", and "Anuncios guardados" all show "—"
    expect(dashTexts.filter((t) => t === "—").length).toBeGreaterThanOrEqual(3);
  });

  // ── 8. EvolutionCharts rendered after successful stats fetch ──────────────

  it("renders evolution charts after stats fetch succeeds", async () => {
    globalThis.fetch = mockFetch();
    render(<EtlMonitorPage />);

    await waitFor(() => {
      expect(screen.getByTestId("evolution-charts")).toBeInTheDocument();
    });
  });

  // ── 9. Ad-hoc "Ejecutar todo ahora" (issue #244, revives #104) ────────────

  it("renders the Ejecutar todo ahora button", async () => {
    // The connector orchestrator now polls etl_manual_trigger
    // (etl/manual_trigger.py), so the full-sweep trigger is a real control
    // again — not the hard 501 it was after issue #104.
    globalThis.fetch = mockFetch();
    render(<EtlMonitorPage />);

    await waitFor(() => {
      expect(screen.getByTestId("kpi-row")).toBeInTheDocument();
    });

    expect(screen.getByTestId("run-now-all")).toBeInTheDocument();
    // The old force-resync affordance stays gone — this is a single "run all"
    // control, not the source project's watermark-resync pair.
    expect(screen.queryByTestId("force-resync-button")).not.toBeInTheDocument();
  });

  it("clicking Ejecutar todo ahora POSTs a full-sweep trigger to /api/etl/run", async () => {
    const fetchMock = mockFetch();
    globalThis.fetch = fetchMock;
    render(<EtlMonitorPage />);

    await waitFor(() => {
      expect(screen.getByTestId("run-now-all")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("run-now-all"));
    });

    const post = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/etl/run" && (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(post).toBeTruthy();
    // Full sweep = an empty body (no connector_name).
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({});
  });

  it("links to the connector management page", async () => {
    globalThis.fetch = mockFetch();
    render(<EtlMonitorPage />);

    await waitFor(() => {
      expect(screen.getByTestId("kpi-row")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("link", { name: /Gestionar conectores/ }),
    ).toHaveAttribute("href", "/etl/connectors");
  });

  // ── 10. Funnel KPIs replace the old row-count/watermark ones ──────────────

  it("renders the discovered/fetched funnel KPIs", async () => {
    globalThis.fetch = mockFetch();
    render(<EtlMonitorPage />);

    await waitFor(() => {
      expect(screen.getByTestId("kpi-last-fetched")).toBeInTheDocument();
    });

    expect(screen.getByTestId("kpi-last-fetched")).toHaveTextContent("45");
    // fetch_rate 0.625 renders as a percentage.
    await waitFor(() => {
      expect(screen.getByTestId("kpi-fetch-rate")).toHaveTextContent("63%");
    });
    // The watermark KPI is gone with the table that fed it.
    expect(screen.queryByTestId("kpi-watermark-age")).not.toBeInTheDocument();
    expect(screen.queryByTestId("kpi-throughput")).not.toBeInTheDocument();
  });

});
