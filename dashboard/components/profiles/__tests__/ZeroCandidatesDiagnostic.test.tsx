// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ZeroCandidatesDiagnostic } from "../ZeroCandidatesDiagnostic";

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe("ZeroCandidatesDiagnostic (issue #194)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state before the diagnosis resolves", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(pending),
    );
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    expect(screen.getByTestId("zero-diagnostic-loading")).toBeInTheDocument();
    resolveFetch({ ok: true, json: async () => ({ kind: "never_materialized" }) });
    await waitFor(() => expect(screen.queryByTestId("zero-diagnostic-loading")).not.toBeInTheDocument());
  });

  it("never_materialized: renders the exact copy and a Recalcular button", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ kind: "never_materialized" }));
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    await waitFor(() => expect(screen.getByText("Este perfil aún no se ha calculado.")).toBeInTheDocument());
    expect(screen.getByTestId("zero-diagnostic-recalculate")).toBeInTheDocument();
  });

  it("geography_empty (the Dos Hermanas case): names the actual nearest distance and the profile's radius, distinguishing from the pure-zero case", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        kind: "geography_empty",
        radiusKm: 7,
        nearest: { propertyId: 99, distanceKm: 7.6 },
        connectorLastRunFinishedAt: "2026-08-01T10:00:00.000Z",
        areaCoverage: { kind: "crawled", lastCrawledAt: "2026-08-01T10:00:00.000Z" },
      }),
    );
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    await waitFor(() =>
      expect(
        screen.getByText((text) => text.includes("7,6 km") && text.includes("7 km")),
      ).toBeInTheDocument(),
    );
    // No Recalcular button for this branch — recalculating won't fix a
    // geography gap, only new data or a wider radius can.
    expect(screen.queryByTestId("zero-diagnostic-recalculate")).not.toBeInTheDocument();
  });

  it("geography_empty with no nearest property at all (empty inventory): distinguishable from the near-miss case", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        kind: "geography_empty",
        radiusKm: 7,
        nearest: null,
        connectorLastRunFinishedAt: null,
        areaCoverage: { kind: "never_crawled" },
      }),
    );
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    await waitFor(() =>
      expect(screen.getByText(/No hay ningún inmueble con anuncio activo/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Ningún conector ha completado una ejecución/)).toBeInTheDocument();
  });

  // Issue #217 / D-030: these two branches are the whole point of the
  // areaCoverage signal — before it, both rendered the identical "no
  // matches nearby" text as the crawled case, which is the message that
  // sent the owner looking for a filter bug when the real answer was
  // "nobody has crawled Estepona yet".
  it("geography_empty + never_crawled: reports the absence of a crawl record without asserting the area is uncovered", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        kind: "geography_empty",
        radiusKm: 25,
        nearest: { propertyId: 5, distanceKm: 112.5 },
        connectorLastRunFinishedAt: "2026-08-04T07:16:38.000Z",
        areaCoverage: { kind: "never_crawled" },
      }),
    );
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    await waitFor(() =>
      expect(screen.getByText(/No hay constancia de que se haya rastreado/)).toBeInTheDocument(),
    );
    // PR #228 review, nit 7: the old copy asserted "Ningún conector cubre
    // todavía esta zona … hace falta añadir cobertura". Rows only appear
    // once a scope is attempted or budget-skipped, and coverage circles
    // deliberately under-report, so a genuinely covered area lands here for
    // a run or two — where the correct advice is "wait one run", the exact
    // opposite of what was shown.
    expect(screen.queryByText(/Ningún conector cubre todavía esta zona/)).not.toBeInTheDocument();
    expect(screen.getByText(/puede aparecer tras una de las próximas ejecuciones/)).toBeInTheDocument();
    // Must still not claim the area IS covered and merely awaiting its turn.
    expect(screen.queryByText(/Esta zona sí está cubierta/)).not.toBeInTheDocument();
  });

  /**
   * PR #228 review, finding 1. An attempted-but-never-successful scope must
   * read as broken, not as crawled-and-empty: nothing was ever retrieved,
   * so "no hay resultados" says nothing about real inventory.
   */
  it("geography_empty + attempted_never_succeeded: never renders the 'se rastreó el <fecha>' claim", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        kind: "geography_empty",
        radiusKm: 25,
        nearest: { propertyId: 5, distanceKm: 112.5 },
        connectorLastRunFinishedAt: "2026-08-04T07:16:38.000Z",
        areaCoverage: {
          kind: "attempted_never_succeeded",
          connectorNames: ["fotocasa"],
          lastAttemptedAt: "2026-08-04T07:16:38.000Z",
        },
      }),
    );
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    await waitFor(() =>
      expect(screen.getByText(/ningún rastreo ha llegado a completarse/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/fotocasa/)).toBeInTheDocument();
    expect(screen.queryByText(/Esta zona se rastreó por última vez/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Esta zona sí está cubierta/)).not.toBeInTheDocument();
  });

  it("geography_empty + awaiting_turn: says the area IS covered and names the connectors that will get to it", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        kind: "geography_empty",
        radiusKm: 25,
        nearest: { propertyId: 5, distanceKm: 112.5 },
        connectorLastRunFinishedAt: "2026-08-04T07:16:38.000Z",
        areaCoverage: { kind: "awaiting_turn", connectorNames: ["fotocasa"] },
      }),
    );
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    await waitFor(() =>
      expect(screen.getByText(/todavía no le ha tocado el turno/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/fotocasa/)).toBeInTheDocument();
    expect(screen.queryByText(/Ningún conector cubre todavía esta zona/)).not.toBeInTheDocument();
  });

  it("type_empty: names the geography count and the excluded property types", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({ kind: "type_empty", geographyCount: 14, propertyTypes: ["piso"] }),
    );
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    await waitFor(() =>
      expect(screen.getByText(/Hay 14 inmuebles en la zona, pero ninguno del tipo que buscas \(piso\)/)).toBeInTheDocument(),
    );
  });

  it("price_size_empty: names the actual price bound from the profile's scope", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        kind: "price_size_empty",
        typeCount: 14,
        priceMin: 150000,
        priceMax: 220000,
        sizeMin: undefined,
        sizeMax: undefined,
      }),
    );
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    await waitFor(() =>
      expect(
        screen.getByText((text) => text.includes("150.000") && text.includes("220.000")),
      ).toBeInTheDocument(),
    );
  });

  it("exclusion_empty: names which exclusion is doing it", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({ kind: "exclusion_empty", priceSizeCount: 3, excludedBy: ["el filtro de ascensor"] }),
    );
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    await waitFor(() =>
      expect(screen.getByText(/3 candidatos cumplen todo salvo el filtro de ascensor/)).toBeInTheDocument(),
    );
  });

  it("stale_materialization: renders the recalculate call-to-action distinctly from never_materialized's copy", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ kind: "stale_materialization", funnelCount: 5 }));
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    await waitFor(() =>
      expect(screen.getByText(/no se ha recalculado desde el último cambio/)).toBeInTheDocument(),
    );
    expect(screen.getByTestId("zero-diagnostic-recalculate")).toBeInTheDocument();
  });

  it("clicking Recalcular POSTs to the materialize endpoint and refetches the diagnosis", async () => {
    const fetchMock = vi
      .fn()
      // initial GET diagnostics
      .mockResolvedValueOnce({ ok: true, json: async () => ({ kind: "never_materialized" }) })
      // POST materialize
      .mockResolvedValueOnce({ ok: true, json: async () => ({}), text: async () => "" })
      // refetch GET diagnostics (now resolved)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ kind: "not_zero", matchedCount: 4 }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<ZeroCandidatesDiagnostic profileId={7} />);
    await waitFor(() => expect(screen.getByTestId("zero-diagnostic-recalculate")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("zero-diagnostic-recalculate"));

    await waitFor(() => expect(screen.getByText(/ya tiene 4 candidatos/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/profiles/7/materialize", { method: "POST" });
  });

  it("renders an error surface (not a silent blank) when the diagnostics call fails", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ error: "boom", code: "DB_QUERY", timestamp: "x", requestId: "r" }, false, 500));
    render(<ZeroCandidatesDiagnostic profileId={1} />);
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });
});
