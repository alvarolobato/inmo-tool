// @vitest-environment jsdom
// Note: The dashboard list has moved from "/" to "/paneles".
// This test now imports from "../paneles/page" to keep testing the dashboard list logic.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import Home from "../paneles/page";

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

const mockDashboards = [
  {
    id: 1,
    name: "Ventas Marzo",
    description: "Panel de ventas del mes",
    updated_at: "2026-04-01T10:00:00Z",
  },
  {
    id: 2,
    name: "Stock General",
    description: null,
    updated_at: "2026-04-02T15:30:00Z",
  },
];

function mockFetchList(data: unknown[], ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(ok ? data : { error: "Server error" }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Home (dashboard list page)", () => {
  const originalFetch = globalThis.fetch;
  const originalConfirm = globalThis.confirm;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.confirm = originalConfirm;
  });

  it("shows loading spinner initially", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<Home />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders dashboard cards after loading", async () => {
    globalThis.fetch = mockFetchList(mockDashboards);
    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText("Ventas Marzo")).toBeInTheDocument();
    });
    expect(screen.getByText("Stock General")).toBeInTheDocument();
    expect(screen.getByText("Panel de ventas del mes")).toBeInTheDocument();
  });

  it("shows empty state when no dashboards", async () => {
    globalThis.fetch = mockFetchList([]);
    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText("No hay dashboards")).toBeInTheDocument();
    });
    expect(
      screen.getByText("No hay dashboards. Crea el primero."),
    ).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    globalThis.fetch = mockFetchList([], false);
    render(<Home />);

    await waitFor(() => {
      expect(
        screen.getByText("Error al cargar los dashboards"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Reintentar")).toBeInTheDocument();
  });

  it("has links to dashboard view on cards", async () => {
    globalThis.fetch = mockFetchList(mockDashboards);
    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText("Ventas Marzo")).toBeInTheDocument();
    });

    const cardLink = screen.getByTestId("dashboard-card-1");
    expect(cardLink.tagName).toBe("A");
    expect(cardLink.getAttribute("href")).toBe("/dashboard/1");
  });

  it("has a link to create new dashboard", async () => {
    globalThis.fetch = mockFetchList(mockDashboards);
    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText("Ventas Marzo")).toBeInTheDocument();
    });

    const link = screen.getByText("+ Crear nuevo");
    expect(link).toBeInTheDocument();
    expect(link.closest("a")).toHaveAttribute("href", "/dashboard/new");
  });

  it("deletes a dashboard after confirmation", async () => {
    globalThis.confirm = vi.fn().mockReturnValue(true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockDashboards),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
      });
    globalThis.fetch = fetchMock;

    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText("Ventas Marzo")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Eliminar Ventas Marzo"));

    await waitFor(() => {
      expect(screen.queryByText("Ventas Marzo")).not.toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/1", {
      method: "DELETE",
    });
  });

  it("does not delete when confirmation is cancelled", async () => {
    globalThis.confirm = vi.fn().mockReturnValue(false);
    globalThis.fetch = mockFetchList(mockDashboards);

    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText("Ventas Marzo")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Eliminar Ventas Marzo"));

    // Dashboard should still be present
    expect(screen.getByText("Ventas Marzo")).toBeInTheDocument();
  });
});
