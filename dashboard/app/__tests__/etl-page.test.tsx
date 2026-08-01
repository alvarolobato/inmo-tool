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
      total_tables: 22,
      tables_ok: 22,
      tables_failed: 0,
      total_rows_synced: 45000,
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
      total_tables: 22,
      tables_ok: 0,
      tables_failed: 0,
      total_rows_synced: 0,
      trigger: "manual",
    },
  ],
  total: 1,
};

const MOCK_STATS_RESPONSE = {
  duration_trend: [
    { started_at: "2026-04-10T02:00:00Z", duration_ms: 3600000, status: "success" },
  ],
  rows_trend: [
    { started_at: "2026-04-10T02:00:00Z", total_rows_synced: 45000 },
  ],
  table_durations: [
    { table_name: "ps_ventas", avg_duration_ms: 900000, last_duration_ms: 850000 },
  ],
  top_tables_by_rows: [
    { table_name: "ps_ventas", rows_synced: 45000 },
  ],
  success_rate: { total: 10, success: 9, partial: 1, failed: 0 },
  last_run: {
    run_id: 1,
    duration_ms: 3600000,
    total_rows_synced: 45000,
    throughput_rows_per_sec: 12.5,
  },
  watermarks: { max_age_seconds: 3600, table_name: "ps_ventas" },
  errors_24h: { runs_failed: 0, tables_failed: 0 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(runsOk = true, statsOk = true) {
  return vi.fn().mockImplementation((url: string) => {
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
    // "Última sincronización", "Duración", and "Filas sincronizadas" all show "—"
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

  // ── 9. "Sincronizar ahora" button renders and is enabled when idle ────────

  it("renders the sync button enabled when no run is active", async () => {
    globalThis.fetch = mockFetch();
    render(<EtlMonitorPage />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-now-button")).toBeInTheDocument();
    });

    const button = screen.getByTestId("sync-now-button");
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent("Sincronizar ahora");
  });

  // ── 10. Button is disabled and shows spinner when a run is running ────────

  it("disables the sync button and shows spinner while a run is running", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/etl/runs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_RUNNING_RUNS_RESPONSE),
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
      expect(screen.getByTestId("sync-now-button")).toBeDisabled();
    });

    const button = screen.getByTestId("sync-now-button");
    expect(button).toHaveTextContent("Sincronizando…");
  });

  // ── 11. Clicking button calls POST /api/etl/run ───────────────────────────

  it("calls POST /api/etl/run when clicked and is idle", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url === "/api/etl/run" && options?.method === "POST") {
        return Promise.resolve({ ok: true, status: 202, json: () => Promise.resolve({ trigger_id: 1 }) });
      }
      if (url.startsWith("/api/etl/runs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_RUNS_RESPONSE),
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

    await waitFor(() => {
      expect(screen.getByTestId("sync-now-button")).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-now-button"));
    });

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        ([url, opts]: [string, RequestInit | undefined]) =>
          url === "/api/etl/run" && opts?.method === "POST"
      );
      expect(postCalls.length).toBe(1);
    });
  });

  // ── 12. 409 response keeps UI in running state without showing error ───────

  it("handles 409 from POST /api/etl/run silently", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url === "/api/etl/run" && options?.method === "POST") {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: "already_running", run_id: 2 }) });
      }
      if (url.startsWith("/api/etl/runs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_RUNS_RESPONSE),
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

    await waitFor(() => {
      expect(screen.getByTestId("sync-now-button")).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-now-button"));
    });

    // No error message should appear for a 409
    await waitFor(() => {
      expect(screen.queryByText("Error al iniciar la sincronización")).not.toBeInTheDocument();
    });
  });

  // ── 13. Button stays disabled while POST is in-flight ─────────────────────

  it("button stays disabled while POST /api/etl/run is in-flight", async () => {
    let resolvePost!: (value: Response) => void;
    const postPromise = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });

    const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url === "/api/etl/run" && options?.method === "POST") {
        return postPromise;
      }
      if (url.startsWith("/api/etl/runs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_RUNS_RESPONSE),
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

    // Wait for idle state
    await waitFor(() => {
      expect(screen.getByTestId("sync-now-button")).not.toBeDisabled();
    });

    // Click the button to start the POST (in-flight)
    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-now-button"));
    });

    // While POST is pending the button must be disabled and show "Iniciando…"
    expect(screen.getByTestId("sync-now-button")).toBeDisabled();
    expect(screen.getByTestId("sync-now-button")).toHaveTextContent("Iniciando…");

    // Resolve the POST → button re-enables (no active run in this mock)
    await act(async () => {
      resolvePost({
        ok: true,
        status: 202,
        json: () => Promise.resolve({ trigger_id: 1 }),
      } as unknown as Response);
    });

    await waitFor(() => {
      expect(screen.getByTestId("sync-now-button")).not.toBeDisabled();
    });
  });
});
