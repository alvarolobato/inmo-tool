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
      connectors: [
        {
          connector: "fotocasa",
          enabled: true,
          lastSuccessAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          lastRunAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          lastRunStatus: "ok",
          isStale: false,
        },
      ],
      overallStale: false,
      stalestConnector: {
        connector: "fotocasa",
        lastSuccessAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        lastRunStatus: "ok",
      },
      freshestSuccessAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    };
    globalThis.fetch = mockFetch(fresh);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("tooltip").textContent).toContain(
        "Última ejecución correcta (fotocasa):",
      );
    });
    expect(screen.getByTestId("stale").textContent).toBe("false");
    expect(screen.getByTestId("text").textContent).toMatch(/Datos al día · hace/);
  });

  it("marks stale when overallStale is true", async () => {
    const stale: DataHealthResponse = {
      connectors: [
        {
          connector: "milanuncios",
          enabled: true,
          lastSuccessAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
          lastRunAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          lastRunStatus: "failed",
          isStale: true,
        },
      ],
      overallStale: true,
      stalestConnector: {
        connector: "milanuncios",
        lastSuccessAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        lastRunStatus: "failed",
      },
      freshestSuccessAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
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
      "Última ejecución correcta (milanuncios):",
    );
  });

  it("shows 'sin sincronizar' when an enabled connector has never succeeded", async () => {
    const neverRan: DataHealthResponse = {
      connectors: [
        {
          connector: "solvia",
          enabled: true,
          lastSuccessAt: null,
          lastRunAt: null,
          lastRunStatus: null,
          isStale: true,
        },
      ],
      overallStale: true,
      stalestConnector: {
        connector: "solvia",
        lastSuccessAt: null,
        lastRunStatus: null,
      },
      freshestSuccessAt: null,
    };
    globalThis.fetch = mockFetch(neverRan);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("text").textContent).toBe("Datos sin sincronizar");
    });
    expect(screen.getByTestId("stale").textContent).toBe("true");
    expect(screen.getByTestId("tooltip").textContent).toContain(
      "solvia: sin ejecución correcta",
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
