// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import NewDashboard from "../dashboard/new/page";

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({}),
}));

// Mock DataFreshnessBanner to avoid uncontrolled fetch calls during tests
vi.mock("@/components/DataFreshnessBanner", () => ({
  DataFreshnessBanner: () => null,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockDashboardList = [
  { id: 1, name: "Panel de Ventas", description: "Ventas mensuales", updated_at: "2026-04-01T10:00:00Z" },
  { id: 2, name: "Panel de Stock", description: null, updated_at: "2026-04-02T15:30:00Z" },
];

const mockGaps = [
  { area: "Análisis de Compras", description: "No tienes un panel de compras.", suggestedPrompt: "Crea un dashboard de compras..." },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NewDashboard page — smart creation sections", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Tabs & keyboard nav ─────────────────────────────────────────────────

  it("renders exactly 2 creation mode tabs: Plantillas and Crear con IA", () => {
    render(<NewDashboard />);
    expect(screen.getByTestId("creation-tab-templates")).toBeInTheDocument();
    expect(screen.getByTestId("creation-tab-free")).toBeInTheDocument();
    expect(screen.queryByTestId("creation-tab-assistant")).not.toBeInTheDocument();
  });

  it("moves tab selection with Arrow keys (roving tabindex)", async () => {
    render(<NewDashboard />);
    const templatesBtn = screen.getByTestId("creation-tab-templates");
    templatesBtn.focus();
    await act(async () => {
      fireEvent.keyDown(templatesBtn, { key: "ArrowRight" });
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("creation-tab-free"));
    });

    const freeBtn = screen.getByTestId("creation-tab-free");
    await act(async () => {
      fireEvent.keyDown(freeBtn, { key: "ArrowLeft" });
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(templatesBtn);
    });
  });

  // ── Gap analysis section ────────────────────────────────────────────────

  it("renders the gap analysis section heading inside the Crear con IA tab", () => {
    render(<NewDashboard />);
    fireEvent.click(screen.getByTestId("creation-tab-free"));
    expect(screen.getByText("¿Qué me falta?")).toBeInTheDocument();
  });

  it("renders the Analizar cobertura button", () => {
    render(<NewDashboard />);
    fireEvent.click(screen.getByTestId("creation-tab-free"));
    expect(screen.getByTestId("analyze-gaps-button")).toBeInTheDocument();
    expect(screen.getByText("Analizar cobertura")).toBeInTheDocument();
  });

  it("clicking Analizar cobertura fetches gaps and shows results", async () => {
    const fetchMock = vi.fn()
      // GET /api/dashboards
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockDashboardList),
      })
      // GET /api/dashboard/1
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 1,
            name: "Panel de Ventas",
            description: "Ventas mensuales",
            spec: {
              title: "Panel de Ventas",
              widgets: [
                { type: "number", title: "Ventas Netas", sql: "SELECT 1", format: "number" },
              ],
            },
          }),
      })
      // GET /api/dashboard/2
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 2,
            name: "Panel de Stock",
            spec: {
              title: "Panel de Stock",
              widgets: [
                { type: "number", title: "Stock Total", sql: "SELECT 1", format: "number" },
              ],
            },
          }),
      })
      // POST /api/dashboard/gaps
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ gaps: mockGaps }),
      });
    globalThis.fetch = fetchMock;

    render(<NewDashboard />);
    fireEvent.click(screen.getByTestId("creation-tab-free"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("analyze-gaps-button"));
    });

    // Should show gaps after loading
    await waitFor(() => {
      expect(screen.getByText("Análisis de Compras")).toBeInTheDocument();
    });
    expect(screen.getByText("No tienes un panel de compras.")).toBeInTheDocument();
  });

  it("shows loading spinner while analyzing gaps", async () => {
    // Return a never-resolving promise to hold the loading state
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    globalThis.fetch = fetchMock;

    render(<NewDashboard />);
    fireEvent.click(screen.getByTestId("creation-tab-free"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("analyze-gaps-button"));
    });

    // Should show loading spinner
    expect(screen.getByLabelText("Analizando cobertura")).toBeInTheDocument();
    expect(screen.getByText("Analizando...")).toBeInTheDocument();
  });

  it("clicking 'Usar este prompt' on a gap pre-fills the textarea and does not auto-generate", async () => {
    const fetchMock = vi.fn()
      // GET /api/dashboards
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      })
      // POST /api/dashboard/gaps
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ gaps: mockGaps }),
      });
    globalThis.fetch = fetchMock;

    render(<NewDashboard />);
    fireEvent.click(screen.getByTestId("creation-tab-free"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("analyze-gaps-button"));
    });

    await waitFor(() => {
      expect(screen.getByText("Análisis de Compras")).toBeInTheDocument();
    });

    const usarBtn = screen.getByRole("button", { name: "Usar este prompt" });
    await act(async () => {
      fireEvent.click(usarBtn);
    });

    const textarea = screen.getByPlaceholderText("Describe el dashboard que necesitas...");
    expect(textarea).toHaveValue(mockGaps[0]!.suggestedPrompt);

    // No generate call should have been made
    const generateCall = fetchMock.mock.calls.find(
      (call) => String(call[0]).includes("/api/dashboard/generate"),
    );
    expect(generateCall).toBeUndefined();
  });

  // ── Existing sections still work ────────────────────────────────────────

  it("still renders free-form prompt textarea", () => {
    render(<NewDashboard />);
    fireEvent.click(screen.getByTestId("creation-tab-free"));
    expect(
      screen.getByPlaceholderText("Describe el dashboard que necesitas...")
    ).toBeInTheDocument();
    expect(screen.getByText("Generar Dashboard")).toBeInTheDocument();
  });

  it("still renders template cards section", () => {
    render(<NewDashboard />);
    fireEvent.click(screen.getByTestId("creation-tab-templates"));
    expect(screen.getByText("Plantillas predefinidas")).toBeInTheDocument();
  });

  it("disables gap analysis button while generation is in progress", async () => {
    // Hang the fetch so loading state is captured
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));

    render(<NewDashboard />);
    fireEvent.click(screen.getByTestId("creation-tab-free"));

    const textarea = screen.getByPlaceholderText("Describe el dashboard que necesitas...");
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Dashboard de ventas" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Generar Dashboard"));
    });

    // While loading, gap analysis button should be disabled
    expect(screen.getByTestId("analyze-gaps-button")).toBeDisabled();
  });
});
