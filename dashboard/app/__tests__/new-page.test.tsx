// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import NewDashboard from "../dashboard/new/page";
import type { DashboardSpec } from "@/lib/schema";
import { TASK_PROMPTS } from "@/lib/task-prompts";
import {
  mockJsonFetchOk,
  mockNdjsonGenerateSuccess,
  mockNdjsonGenerateHang,
} from "./helpers/stream-generate-mock";

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const generatedSpec: DashboardSpec = {
  title: "Ventas Marzo 2026",
  description: "Panel de ventas",
  widgets: [
    {
      type: "number",
      title: "Total",
      sql: "SELECT 1",
      format: "number",
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NewDashboard page", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders exactly 2 tabs: Plantillas and Crear con IA", () => {
    render(<NewDashboard />);
    expect(screen.getByTestId("creation-tab-templates")).toBeInTheDocument();
    expect(screen.getByTestId("creation-tab-free")).toBeInTheDocument();
    expect(screen.queryByTestId("creation-tab-assistant")).not.toBeInTheDocument();
  });

  it("renders prompt textarea and generate button", () => {
    render(<NewDashboard />);
    fireEvent.click(screen.getByTestId("creation-tab-free"));

    expect(
      screen.getByPlaceholderText("Describe el dashboard que necesitas..."),
    ).toBeInTheDocument();
    expect(screen.getByText("Generar Dashboard")).toBeInTheDocument();
  });

  it("disables generate button when prompt is empty", () => {
    render(<NewDashboard />);
    fireEvent.click(screen.getByTestId("creation-tab-free"));

    const btn = screen.getByText("Generar Dashboard");
    expect(btn).toBeDisabled();
  });

  it("enables generate button when prompt has text", async () => {
    render(<NewDashboard />);
    fireEvent.click(screen.getByTestId("creation-tab-free"));

    const textarea = screen.getByPlaceholderText(
      "Describe el dashboard que necesitas...",
    );
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "Dashboard de ventas" },
      });
    });

    expect(screen.getByText("Generar Dashboard")).not.toBeDisabled();
  });

  it("clicking a task chip pre-fills the textarea and does not trigger generation", async () => {
    const fetchMock = vi.fn().mockImplementation((url: RequestInfo) => {
      const u = typeof url === "string" ? url : String(url);
      if (u.includes("data-health")) {
        return Promise.resolve(
          mockJsonFetchOk({ tables: [], overallStale: false, stalestTable: null }),
        );
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    globalThis.fetch = fetchMock;

    render(<NewDashboard />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("creation-tab-free"));
    });

    const firstTask = TASK_PROMPTS[0]!;
    const chip = screen.getByTestId(`task-chip-${firstTask.id}`);
    await act(async () => {
      fireEvent.click(chip);
    });

    const textarea = screen.getByPlaceholderText("Describe el dashboard que necesitas...");
    expect(textarea).toHaveValue(firstTask.prompt);

    // No generate call should have been made
    const generateCall = fetchMock.mock.calls.find(
      (call) => String(call[0]).includes("/api/dashboard/generate"),
    );
    expect(generateCall).toBeUndefined();
  });

  it("all task chips are rendered in the free-form tab", async () => {
    render(<NewDashboard />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("creation-tab-free"));
    });

    for (const task of TASK_PROMPTS) {
      expect(screen.getByTestId(`task-chip-${task.id}`)).toBeInTheDocument();
    }
  });

  it("chip-prefilled prompt can be edited before generating", async () => {
    render(<NewDashboard />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("creation-tab-free"));
    });

    const firstTask = TASK_PROMPTS[0]!;
    await act(async () => {
      fireEvent.click(screen.getByTestId(`task-chip-${firstTask.id}`));
    });

    const textarea = screen.getByPlaceholderText("Describe el dashboard que necesitas...");
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Prompt editado por el usuario" } });
    });

    expect(textarea).toHaveValue("Prompt editado por el usuario");
  });

  it("generates and saves dashboard, then redirects", async () => {
    // URL-based dispatch instead of positional mockResolvedValueOnce so we
    // don't depend on the exact order or count of background fetches (e.g.
    // the freshness provider may or may not run depending on whether a
    // FreshnessProvider is mounted in the test tree).
    const fetchMock = vi.fn().mockImplementation((url: RequestInfo) => {
      const u = typeof url === "string" ? url : String(url);
      if (u.includes("data-health")) {
        return Promise.resolve(
          mockJsonFetchOk({ tables: [], overallStale: false, stalestTable: null }),
        );
      }
      if (u.includes("/api/dashboard/generate")) {
        return Promise.resolve(
          mockNdjsonGenerateSuccess(generatedSpec as unknown as Record<string, unknown>),
        );
      }
      if (u.includes("/api/dashboard") && u.match(/\/api\/dashboard\/?$/)) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ id: 42, ...generatedSpec }),
        });
      }
      // Fallback for the save endpoint (POST /api/dashboard).
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ id: 42, ...generatedSpec }),
      });
    });
    globalThis.fetch = fetchMock;

    render(<NewDashboard />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("creation-tab-free"));
    });

    const textarea = screen.getByPlaceholderText(
      "Describe el dashboard que necesitas...",
    );

    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "Ventas del mes" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Generar Dashboard"));
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/dashboard/42");
    });

    // Verify generate and save API calls were made
    const generateCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/dashboard/generate"
    );
    expect(generateCall).toBeDefined();
    expect(generateCall![1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "Ventas del mes", stream: true }),
      }),
    );
  });

  it("shows loading spinner while generating", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: RequestInfo) => {
      const u = typeof url === "string" ? url : String(url);
      if (u.includes("data-health")) {
        return Promise.resolve(
          mockJsonFetchOk({ tables: [], overallStale: false, stalestTable: null }),
        );
      }
      if (u.includes("/api/dashboard/generate")) {
        return Promise.resolve(mockNdjsonGenerateHang());
      }
      return new Promise(() => {});
    });

    render(<NewDashboard />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("creation-tab-free"));
    });

    await act(async () => {
      fireEvent.change(
        screen.getByPlaceholderText("Describe el dashboard que necesitas..."),
        { target: { value: "Test" } },
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Generar Dashboard"));
    });

    expect(screen.getByText("Generando...")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Generando panel con IA" })).toBeInTheDocument();
  });

  it("shows error message on generation failure", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: RequestInfo) => {
      const u = typeof url === "string" ? url : String(url);
      if (u.includes("data-health")) {
        return Promise.resolve(
          mockJsonFetchOk({ tables: [], overallStale: false, stalestTable: null }),
        );
      }
      if (u.includes("/api/dashboard/generate")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              error: "LLM error: timeout",
              code: "LLM_ERROR",
              timestamp: new Date().toISOString(),
              requestId: "req_err_test",
            }),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });

    render(<NewDashboard />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("creation-tab-free"));
    });

    await act(async () => {
      fireEvent.change(
        screen.getByPlaceholderText("Describe el dashboard que necesitas..."),
        { target: { value: "Test" } },
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Generar Dashboard"));
    });

    await waitFor(() => {
      expect(screen.getByText("LLM error: timeout")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    });

    // Button should be re-enabled for retry
    expect(screen.getByText("Generar Dashboard")).not.toBeDisabled();
  });
});
