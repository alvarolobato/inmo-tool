// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import InicioPage from "../inicio/page";
import type { HomeViewModel } from "@/lib/home-types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => "/inicio",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/WeeklySummaryButton", () => ({
  default: () => <button data-testid="weekly-summary-btn">✦ Resumen semanal</button>,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    style,
    "aria-label": ariaLabel,
  }: {
    href: string;
    children: React.ReactNode;
    style?: React.CSSProperties;
    "aria-label"?: string;
  }) => (
    <a href={href} style={style} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Mock HomeViewModel fixture
// ---------------------------------------------------------------------------

const MOCK_DATA: HomeViewModel = {
  asOf: "lun 04 may · 11:42",
  asOfDate: "2026-05-04",
  maxAvailableDate: "2026-05-04",
  hero: {
    todayValue: 38420,
    forecastEOD: 38420,
    todayPace: 0,
    vsYesterday: 0.082,
    vsLY: -0.114,
    yesterday: 35510,
    lastYear: 43370,
    comparisonCutoffHour: null,
    yesterdayCutoff: null,
    lastYearCutoff: null,
    status: "on-pace",
    // Empty arrays — mirror has only date granularity (no time-of-day).
    hourly: [],
    hourlyComparison: [],
    comparisonLabel: "Lunes anterior",
  },
  periods: [
    { id: "hoy",    label: "Hoy",       value: 38420,   deltaPrev: 0.082,  prevLabel: "vs ayer",    deltaYoY: -0.114, yoyLabel: "vs lun 5 may 2025", spark: [1, 2, 3], sparkLabels: ["a"], trendDirection: "up" },
    { id: "semana", label: "Semana",    value: 218400,  deltaPrev: -0.043, prevLabel: "vs sem ant", deltaYoY: -0.092, yoyLabel: "vs sem 18 2025",    spark: [1, 2, 3], sparkLabels: ["a"], streakWeeks: 4, trendDirection: "down" },
    { id: "mes",    label: "Mes",       value: 134802,  deltaPrev: -0.189, prevLabel: "vs abril",   deltaYoY: -0.132, yoyLabel: "vs may 2025",       spark: [1, 2, 3], sparkLabels: ["a"], trendDirection: "down" },
    { id: "anyo",   label: "Año (YTD)", value: 1842600, deltaPrev: 0.034,  prevLabel: "vs YTD",     deltaYoY: 0.034,  yoyLabel: "vs 2025",           spark: [1, 2, 3], sparkLabels: ["a"], trendDirection: "flat" },
  ],
  marginPeriods: [
    { id: "hoy",    label: "Hoy",       value: 0.521, deltaPrev: -0.03, prevLabel: "vs ayer",    deltaYoY: -0.015, yoyLabel: "vs lun 5 may 2025", spark: [0.52, 0.53, 0.521], sparkLabels: ["a"] },
    { id: "semana", label: "Semana",    value: 0.48,  deltaPrev: 0.01,  prevLabel: "vs sem ant", deltaYoY: null,   yoyLabel: "vs sem 18 2025",    spark: [0.47, 0.48, 0.48],  sparkLabels: ["a"] },
    { id: "mes",    label: "Mes",       value: 0.502, deltaPrev: -0.02, prevLabel: "vs abril",   deltaYoY: -0.01,  yoyLabel: "vs may 2025",       spark: [0.51, 0.50, 0.502], sparkLabels: ["a"] },
    { id: "anyo",   label: "Año (YTD)", value: 0.495, deltaPrev: 0.005, prevLabel: "vs YTD",     deltaYoY: 0.005,  yoyLabel: "vs 2025",           spark: [0.49, 0.50, 0.495], sparkLabels: ["a"] },
  ],
  dailyTrend: [{ day: 1, actual: 8000, ly: 8500 }, { day: 2, actual: null, ly: 9000 }],
  topStores: [
    { code: "611", name: "Valencia Alcantara", sales: 4920, delta: 0.082, deltaYoY: 0.031,  spark: [1, 2, 3], status: "ok",    streakWeeks: 0, margin: 0.521, returnsRate: 0.032, tickets: 42, ticketMedio: 117 },
    { code: "608", name: "Montijo",            sales: 3960, delta: -0.012, deltaYoY: -0.025, spark: [1, 2, 3], status: "watch", streakWeeks: 4, margin: 0.512, returnsRate: 0.028, tickets: 35, ticketMedio: 113 },
    { code: "601", name: "Badajoz",            sales: 2820, delta: -0.142, deltaYoY: -0.200, spark: [1, 2, 3], status: "alert", streakWeeks: 0, margin: 0.478, returnsRate: null,  tickets: 0,  ticketMedio: 0 },
  ],
  inactiveStores: [],
  networkReturnRate30d: 0.035,
  opsRetail: [
    { id: "ticket", label: "Ticket medio", value: 26.55, format: "eur2", delta: 0 },
    { id: "margen", label: "Margen mes", value: 0.52, format: "pct", delta: 0.02, deltaUnit: "pp" as const, sub: "vs mes ant" },
    { id: "tasa-devol", label: "Tasa devol.", value: 0.031, format: "pct", delta: -0.05, inverted: true, sub: "120 €" },
  ],
  health: { syncAge: "12 min", lastEtl: "11:30 · OK", anomalies: 2, rows: 1842600 },
};

function mockFetch(data: HomeViewModel, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(data),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InicioPage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders the page container", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<InicioPage />);
    expect(screen.getByTestId("inicio-page")).toBeInTheDocument();
  });

  it("shows the page header with H1 greeting", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<InicioPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      /Hola.*— esto es lo que pasa hoy/,
    );
  });

  it("shows the refresh button", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<InicioPage />);
    expect(screen.getByTestId("refresh-btn")).toBeInTheDocument();
  });

  it("shows the weekly summary button in the page header", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<InicioPage />);
    expect(screen.getByTestId("weekly-summary-btn")).toBeInTheDocument();
  });

  it("shows EN VIVO chip", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<InicioPage />);
    expect(screen.getByText("EN VIVO")).toBeInTheDocument();
  });

  it("renders hero section after data loads", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("hero-today")).toBeInTheDocument();
    });
  });

  it("renders period grid after data loads", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      // Two period grids: sales (Comparativa por periodo) and margin (Margen bruto)
      const grids = screen.getAllByTestId("period-grid");
      expect(grids).toHaveLength(2);
    });
  });

  it("does NOT render the alerts panel (removed in retail-only redesign)", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("daily-trend-chart")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("alerts-panel")).not.toBeInTheDocument();
  });

  it("does NOT render the wholesale operations row", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("operations-row-retail")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("operations-row-mayorista")).not.toBeInTheDocument();
  });

  it("renders the date navigator with the as-of date", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("date-navigator")).toBeInTheDocument();
    });
    expect(screen.getByTestId("date-input")).toHaveValue("2026-05-04");
  });

  it("renders daily trend chart after data loads", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("daily-trend-chart")).toBeInTheDocument();
    });
  });

  it("renders operations retail section after data loads", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("operations-row-retail")).toBeInTheDocument();
    });
  });

  it("renders top stores table after data loads", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("top-stores-table")).toBeInTheDocument();
    });
  });

  it("renders health footer after data loads", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("health-footer")).toBeInTheDocument();
    });
  });

  it("does NOT render chat sidebar", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("hero-today")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("chat-sidebar")).not.toBeInTheDocument();
  });

  it("does NOT render save button", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("hero-today")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /guardar/i })).not.toBeInTheDocument();
  });

  it("renders the WeeklySummaryButton in the page header", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<InicioPage />);
    expect(screen.getByTestId("weekly-summary-btn")).toBeInTheDocument();
    expect(screen.getByTestId("weekly-summary-btn")).toHaveTextContent("Resumen semanal");
  });

  it("shows streak badge when streakWeeks >= 3 on Semana period", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId("period-grid")[0]).toBeInTheDocument();
    });
    // MOCK_DATA has semana.streakWeeks = 4 → badge should be visible
    expect(screen.getByTestId("streak-badge")).toBeInTheDocument();
    expect(screen.getByTestId("streak-badge")).toHaveTextContent("4 sem ▼");
  });

  it("hides streak badge when streakWeeks < 3", async () => {
    const dataNoStreak: HomeViewModel = {
      ...MOCK_DATA,
      periods: MOCK_DATA.periods.map((p) =>
        p.id === "semana" ? { ...p, streakWeeks: 2 } : p,
      ),
    };
    globalThis.fetch = mockFetch(dataNoStreak);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId("period-grid")[0]).toBeInTheDocument();
    });
    expect(screen.queryByTestId("streak-badge")).not.toBeInTheDocument();
  });

  it("renders racha column in stores table", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("top-stores-table")).toBeInTheDocument();
    });
    // The Racha column header should be present
    expect(screen.getByRole("columnheader", { name: /racha/i })).toBeInTheDocument();
    // Store 608 has streakWeeks=4 → should show "4▼"
    expect(screen.getByTestId("racha-608")).toHaveTextContent("4▼");
    // Store 611 has streakWeeks=0 → should show "—"
    expect(screen.getByTestId("racha-611")).toHaveTextContent("—");
  });

  it("shows trend indicator on sparklines", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId("period-grid")[0]).toBeInTheDocument();
    });
    // MOCK_DATA has trendDirection for hoy (up) and semana (down)
    // Both should render a sparkline-with-trend wrapper
    const trendIndicators = screen.getAllByTestId(/^trend-indicator-(up|down)$/);
    expect(trendIndicators.length).toBeGreaterThan(0);
  });

  it("margen delta uses pp semantics", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("metric-cell-margen")).toBeInTheDocument();
    });
    const margenCell = screen.getByTestId("metric-cell-margen");
    // delta=0.02 with unit="pp" → "+2.0 pp" (absolute pp difference, not relative %)
    expect(margenCell).toHaveTextContent("2,0 pp");
  });

  it("margen delta renders pp unit", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("metric-cell-margen")).toBeInTheDocument();
    });
    const margenCell = screen.getByTestId("metric-cell-margen");
    // The Delta chip has aria-label="delta +2,0 pp" for pp units
    const deltaChip = margenCell.querySelector('[aria-label^="delta "]');
    expect(deltaChip).not.toBeNull();
    expect(deltaChip!.getAttribute("aria-label")).toMatch(/pp$/);
    expect(deltaChip!.getAttribute("aria-label")).not.toMatch(/%$/);
  });

  it("tasa-devol delta renders relative percent", async () => {
    globalThis.fetch = mockFetch(MOCK_DATA);
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByTestId("metric-cell-tasa-devol")).toBeInTheDocument();
    });
    const tasaCell = screen.getByTestId("metric-cell-tasa-devol");
    // The Delta chip has aria-label="delta -5,0%" for relative % units (no deltaUnit)
    const deltaChip = tasaCell.querySelector('[aria-label^="delta "]');
    expect(deltaChip).not.toBeNull();
    expect(deltaChip!.getAttribute("aria-label")).toMatch(/%$/);
    expect(deltaChip!.getAttribute("aria-label")).not.toMatch(/pp$/);
  });

  it("renders structured error details (ErrorDisplay) when /api/home returns a 500", async () => {
    const apiError = {
      error: "No se pudo cargar el inicio.",
      code: "DB_QUERY",
      details: "could not resize shared memory segment",
      timestamp: "2026-06-03T08:00:00.000Z",
      requestId: "req_test123",
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve(apiError),
    });
    render(<InicioPage />);
    await waitFor(() => {
      expect(screen.getByText("Error al cargar los datos")).toBeInTheDocument();
    });
    // Structured ApiErrorResponse → expandable technical details + copy-as-JSON,
    // mirroring how widget errors render (not a bare "HTTP 500" string).
    expect(screen.getByText("No se pudo cargar el inicio.")).toBeInTheDocument();
    expect(screen.getByText("Detalles técnicos")).toBeInTheDocument();
    expect(screen.getByText("Copiar como JSON")).toBeInTheDocument();
  });
});
