// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FreshnessProvider, useFreshness } from "@/components/FreshnessContext";
import type { DataHealthResponse } from "@/app/api/data-health/route";

function FreshnessProbe() {
  const { freshnessText, freshnessStale, freshnessUnknown, freshnessTooltip } = useFreshness();
  return (
    <div>
      <span data-testid="text">{freshnessText}</span>
      <span data-testid="stale">{String(freshnessStale)}</span>
      <span data-testid="unknown">{String(freshnessUnknown)}</span>
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
          inScope: true,
          lastSuccessAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          lastRunAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          lastRunStatus: "ok",
          state: "fresh",
          isStale: false,
        },
      ],
      overallStale: false,
      overallRefreshing: false,
      overallUnknown: false,
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
          inScope: true,
          lastSuccessAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
          lastRunAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          lastRunStatus: "failed",
          state: "due",
          isStale: true,
        },
      ],
      overallStale: true,
      overallRefreshing: false,
      overallUnknown: false,
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
          inScope: true,
          lastSuccessAt: null,
          lastRunAt: null,
          lastRunStatus: null,
          state: "due",
          isStale: true,
        },
      ],
      overallStale: true,
      overallRefreshing: false,
      overallUnknown: false,
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

  it("shows 'Refrescando datos' when a connector is mid-cycle and nothing is stale (issue #295)", async () => {
    const refreshing: DataHealthResponse = {
      connectors: [
        {
          connector: "fotocasa",
          enabled: true,
          inScope: true,
          lastSuccessAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          lastRunAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          lastRunStatus: "ok",
          state: "refreshing",
          isStale: false,
        },
      ],
      overallStale: false,
      overallRefreshing: true,
      overallUnknown: false,
      stalestConnector: {
        connector: "fotocasa",
        lastSuccessAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        lastRunStatus: "ok",
      },
      freshestSuccessAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    };
    globalThis.fetch = mockFetch(refreshing);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("text").textContent).toMatch(/Refrescando datos · hace/);
    });
    // Refreshing is NOT stale — the pill must not read as a problem.
    expect(screen.getByTestId("stale").textContent).toBe("false");
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

  // ── Issue #586 — fail dark, never green ────────────────────────────────

  it("shows 'Estado desconocido' (unknown), never 'Datos al día', when the server reports overallUnknown", async () => {
    const unknown: DataHealthResponse = {
      connectors: [],
      overallStale: false,
      overallRefreshing: false,
      overallUnknown: true,
      stalestConnector: null,
      freshestSuccessAt: null,
    };
    globalThis.fetch = mockFetch(unknown);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unknown").textContent).toBe("true");
    });
    // The mutation-guard assertion: a naive fix could satisfy `unknown` while
    // still rendering the old green-implying copy. Must not.
    expect(screen.getByTestId("text").textContent).toBe("Estado desconocido");
    expect(screen.getByTestId("text").textContent).not.toBe("Datos al día");
    // Unknown is never simultaneously reported as "stale" — it is its own
    // state, distinct from both fine and broken.
    expect(screen.getByTestId("stale").textContent).toBe("false");
  });

  it("treats a null stalestConnector as unknown too, even if overallUnknown were somehow unset (defensive)", async () => {
    const noStalest = {
      connectors: [],
      overallStale: false,
      overallRefreshing: false,
      overallUnknown: false,
      stalestConnector: null,
      freshestSuccessAt: null,
    } as unknown as DataHealthResponse;
    globalThis.fetch = mockFetch(noStalest);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unknown").textContent).toBe("true");
    });
    expect(screen.getByTestId("text").textContent).toBe("Estado desconocido");
  });
});
