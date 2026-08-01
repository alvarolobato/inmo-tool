// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { DataFreshnessBanner } from "@/components/DataFreshnessBanner";
import { FreshnessProvider } from "@/components/FreshnessContext";
import type { DataHealthResponse } from "@/app/api/data-health/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FRESH_RESPONSE: DataHealthResponse = {
  tables: [
    {
      name: "ps_ventas",
      lastSync: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      isStale: false,
    },
  ],
  overallStale: false,
  stalestTable: null,
};

const STALE_RESPONSE: DataHealthResponse = {
  tables: [
    {
      name: "ps_ventas",
      lastSync: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      isStale: true,
    },
  ],
  overallStale: true,
  stalestTable: {
    name: "ps_ventas",
    lastSync: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  },
};

function mockFetchWith(data: DataHealthResponse | null, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(ok ? data : { error: "Server error" }),
  });
}

function renderWithProvider() {
  return render(
    <FreshnessProvider>
      <DataFreshnessBanner />
    </FreshnessProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DataFreshnessBanner", () => {
  const originalFetch = globalThis.fetch;
  const originalSessionStorage = globalThis.sessionStorage;

  beforeEach(() => {
    vi.restoreAllMocks();
    // Clear sessionStorage mock between tests
    const store: Record<string, string> = {};
    Object.defineProperty(globalThis, "sessionStorage", {
      value: {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
        removeItem: vi.fn((key: string) => { delete store[key]; }),
        clear: vi.fn(() => { Object.keys(store).forEach(k => delete store[k]); }),
      },
      writable: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "sessionStorage", {
      value: originalSessionStorage,
      writable: true,
    });
  });

  it("does not render banner when data is fresh", async () => {
    globalThis.fetch = mockFetchWith(FRESH_RESPONSE);
    renderWithProvider();

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("data-freshness-banner")).not.toBeInTheDocument();
  });

  it("renders banner when data is stale", async () => {
    globalThis.fetch = mockFetchWith(STALE_RESPONSE);
    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId("data-freshness-banner")).toBeInTheDocument();
    });
    // ps_ventas appears in both the main message and the detail list
    expect(screen.getAllByText(/ps_ventas/).length).toBeGreaterThan(0);
  });

  it("does not render banner on API error (graceful fallback)", async () => {
    globalThis.fetch = mockFetchWith(null, false);
    renderWithProvider();

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("data-freshness-banner")).not.toBeInTheDocument();
  });

  it("does not render banner when fetch throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    renderWithProvider();

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("data-freshness-banner")).not.toBeInTheDocument();
  });

  it("dismisses banner when X button is clicked", async () => {
    globalThis.fetch = mockFetchWith(STALE_RESPONSE);
    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId("data-freshness-banner")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("banner-dismiss"));

    expect(screen.queryByTestId("data-freshness-banner")).not.toBeInTheDocument();
    expect(globalThis.sessionStorage.setItem).toHaveBeenCalledWith(
      "data-health-dismissed",
      "1",
    );
  });

  it("hides banner when sessionStorage already has dismiss flag (but provider still fetches)", async () => {
    // Pre-set dismissed flag
    (globalThis.sessionStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue("1");
    globalThis.fetch = mockFetchWith(STALE_RESPONSE);

    renderWithProvider();

    await waitFor(() => {
      // Provider must still fetch so the TopBar tooltip lights up regardless of dismissal.
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    // Banner stays hidden because of the dismiss flag, even though data is stale.
    expect(screen.queryByTestId("data-freshness-banner")).not.toBeInTheDocument();
  });

  it("collapses and expands the detail list", async () => {
    globalThis.fetch = mockFetchWith(STALE_RESPONSE);
    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId("data-freshness-banner")).toBeInTheDocument();
    });

    // ps_ventas detail should be visible initially
    expect(screen.getAllByText(/ps_ventas/).length).toBeGreaterThan(0);

    // Collapse
    fireEvent.click(screen.getByTestId("banner-collapse-toggle"));

    // After collapse, the detail list should be hidden
    const items = screen.queryAllByRole("listitem");
    expect(items).toHaveLength(0);

    // Expand again
    fireEvent.click(screen.getByTestId("banner-collapse-toggle"));
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  });
});
