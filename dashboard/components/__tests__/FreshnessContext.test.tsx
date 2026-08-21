// @vitest-environment jsdom
/**
 * Issue #638 — the TopBar pill is repointed at `/api/etl/source-health` (the
 * Estado board's worst-of rollup), replacing the prior connector-cycle-based
 * `/api/data-health` source. See components/FreshnessContext.tsx's header.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FreshnessProvider, useFreshness } from "@/components/FreshnessContext";
import type { SourceHealthResponse } from "@/app/api/etl/source-health/route";

function FreshnessProbe() {
  const { freshnessText, freshnessStale, freshnessRefreshing, freshnessUnknown, freshnessTooltip } =
    useFreshness();
  return (
    <div>
      <span data-testid="text">{freshnessText}</span>
      <span data-testid="stale">{String(freshnessStale)}</span>
      <span data-testid="refreshing">{String(freshnessRefreshing)}</span>
      <span data-testid="unknown">{String(freshnessUnknown)}</span>
      <span data-testid="tooltip">{freshnessTooltip ?? ""}</span>
    </div>
  );
}

function mockFetch(data: SourceHealthResponse | Record<string, never>, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(data),
  });
}

function sourceRow(
  overrides: Partial<SourceHealthResponse["sources"][number]> = {},
): SourceHealthResponse["sources"][number] {
  return {
    source: "fotocasa",
    kind: "crawl",
    status: "fresco",
    disabled: false,
    freshnessIntervalHours: 24,
    lastActivityAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    ageHours: 0.5,
    due: false,
    pastDoubleWindow: false,
    captureFailureRate7d: null,
    reason: "fresh",
    new24h: 5,
    sparkline7d: [0, 0, 1, 2, 0, 3, 5],
    latestRunStatus: "ok",
    latestRunFailureClassification: null,
    captureFailed7d: 0,
    captureTotal7d: 0,
    ultimaPasadaCompletaAt: null,
    ...overrides,
  };
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

  it("fetches /api/etl/source-health on mount and exposes tooltip + stale=false when fresco", async () => {
    const fresh: SourceHealthResponse = {
      sources: [sourceRow()],
      rollupStatus: "fresco",
      generatedAt: new Date().toISOString(),
    };
    globalThis.fetch = mockFetch(fresh);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("tooltip").textContent).toContain("fotocasa");
    });
    expect(screen.getByTestId("stale").textContent).toBe("false");
    expect(screen.getByTestId("text").textContent).toMatch(/Datos al día · hace/);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/etl/source-health");
  });

  it("marks stale when the rollup is atascado (starving-but-ok, never green)", async () => {
    const atascado: SourceHealthResponse = {
      sources: [
        sourceRow({
          source: "fotocasa",
          status: "atascado",
          reason: "soft_block_stale",
          ageHours: 40,
          due: true,
          pastDoubleWindow: true,
          latestRunStatus: "ok",
          latestRunFailureClassification: "soft_block",
          new24h: 0,
        }),
      ],
      rollupStatus: "atascado",
      generatedAt: new Date().toISOString(),
    };
    globalThis.fetch = mockFetch(atascado);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("stale").textContent).toBe("true");
    });
    expect(screen.getByTestId("text").textContent).toMatch(/Datos desactualizados/);
    expect(screen.getByTestId("tooltip").textContent).toContain("fotocasa");
  });

  it("marks stale (fallando) with distinct copy on a classified fatal failure", async () => {
    const fallando: SourceHealthResponse = {
      sources: [
        sourceRow({
          source: "milanuncios",
          status: "fallando",
          reason: "run_failed",
          ageHours: 2,
          latestRunStatus: "failed",
        }),
      ],
      rollupStatus: "fallando",
      generatedAt: new Date().toISOString(),
    };
    globalThis.fetch = mockFetch(fallando);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("stale").textContent).toBe("true");
    });
    expect(screen.getByTestId("text").textContent).toMatch(/Fallo de sincronización/);
  });

  it("a pendiente rollup (e.g. a capture source merely awaiting capture) is NOT stale", async () => {
    const pending: SourceHealthResponse = {
      sources: [
        sourceRow({
          source: "idealista",
          kind: "capture",
          status: "pendiente",
          reason: "pendiente_de_captura",
          ageHours: 96,
          due: true,
          new24h: 0,
        }),
      ],
      rollupStatus: "pendiente",
      generatedAt: new Date().toISOString(),
    };
    globalThis.fetch = mockFetch(pending);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("refreshing").textContent).toBe("true");
    });
    // The load-bearing assertion: "pendiente" (owner-paced, bursty capture)
    // must never read as a problem on the pill.
    expect(screen.getByTestId("stale").textContent).toBe("false");
    expect(screen.getByTestId("text").textContent).toMatch(/Sincronización pendiente/);
  });

  it("shows 'sin sincronizar' when the worst source has never had activity", async () => {
    const neverRan: SourceHealthResponse = {
      sources: [
        sourceRow({
          source: "solvia",
          status: "atascado",
          reason: "stale_2x_window",
          lastActivityAt: null,
          ageHours: null,
          due: true,
          pastDoubleWindow: true,
        }),
      ],
      rollupStatus: "atascado",
      generatedAt: new Date().toISOString(),
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
    expect(screen.getByTestId("tooltip").textContent).toContain("solvia");
  });

  it("falls back gracefully when fetch fails (defaults remain)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    expect(screen.getByTestId("text").textContent).toBe("Datos al día");
    expect(screen.getByTestId("tooltip").textContent).toBe("");
  });

  // ── Fail dark, never green (mirrors the retired D-125 posture) ─────────

  it("shows 'Estado desconocido', never 'Datos al día', when rollupStatus is null", async () => {
    const unknown: SourceHealthResponse = {
      sources: [],
      rollupStatus: null,
      generatedAt: new Date().toISOString(),
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
    expect(screen.getByTestId("text").textContent).toBe("Estado desconocido");
    expect(screen.getByTestId("text").textContent).not.toBe("Datos al día");
    expect(screen.getByTestId("stale").textContent).toBe("false");
  });

  it("a disabled source is never picked to drive the rollup/tooltip", async () => {
    const withDisabled: SourceHealthResponse = {
      sources: [
        sourceRow({ source: "escogecasa", status: "fallando", disabled: true, ageHours: 1000 }),
        sourceRow({ source: "fotocasa", status: "fresco", disabled: false, ageHours: 0.5 }),
      ],
      rollupStatus: "fresco",
      generatedAt: new Date().toISOString(),
    };
    globalThis.fetch = mockFetch(withDisabled);

    render(
      <FreshnessProvider>
        <FreshnessProbe />
      </FreshnessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("tooltip").textContent).toContain("fotocasa");
    });
    expect(screen.getByTestId("tooltip").textContent).not.toContain("escogecasa");
    expect(screen.getByTestId("stale").textContent).toBe("false");
  });
});
