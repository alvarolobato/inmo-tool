// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FreshnessProvider, useFreshness } from "@/components/FreshnessContext";
import type { DataHealthResponse } from "@/app/api/data-health/route";

function FreshnessProbe() {
  const { freshnessText, freshnessStale, freshnessTooltip } = useFreshness();
  return (
    <div>
      <span data-testid="text">{freshnessText}</span>
      <span data-testid="stale">{String(freshnessStale)}</span>
      <span data-testid="tooltip">{freshnessTooltip ?? ""}</span>
    </div>
  );
}

function mockFetch(data: DataHealthResponse | null, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(data ?? {}),
  });
}

describe("FreshnessProvider", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("fetches /api/data-health on mount and exposes tooltip + stale state", async () => {
    const fresh: DataHealthResponse = {
      tables: [
        {
          name: "ps_ventas",
          lastSync: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          isStale: false,
        },
      ],
      overallStale: false,
      stalestTable: {
        name: "ps_ventas",
        lastSync: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      },
    };
    globalThis.fetch = mockFetch(fresh);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("tooltip").textContent).toContain(
        "Última sincronización (ps_ventas):",
      );
    });
    expect(screen.getByTestId("stale").textContent).toBe("false");
    expect(screen.getByTestId("text").textContent).toMatch(/Datos al día · hace/);
  });

  it("marks stale when overallStale is true", async () => {
    const stale: DataHealthResponse = {
      tables: [
        {
          name: "ps_stock",
          lastSync: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
          isStale: true,
        },
      ],
      overallStale: true,
      stalestTable: {
        name: "ps_stock",
        lastSync: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      },
    };
    globalThis.fetch = mockFetch(stale);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("stale").textContent).toBe("true");
    });
    expect(screen.getByTestId("text").textContent).toMatch(/Datos desactualizados/);
    expect(screen.getByTestId("tooltip").textContent).toContain(
      "Última sincronización (ps_stock):",
    );
  });

  it("falls back gracefully when fetch fails (defaults remain)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    // Brief wait to let the failed fetch settle.
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    expect(screen.getByTestId("text").textContent).toBe("Datos al día");
    expect(screen.getByTestId("tooltip").textContent).toBe("");
  });
});
