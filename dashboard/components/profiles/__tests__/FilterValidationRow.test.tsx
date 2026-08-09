// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FilterValidationRow } from "../FilterValidationRow";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const IDEALISTA_URL = "https://www.idealista.com/venta-viviendas/sevilla-sevilla/";

function baseProps() {
  return {
    profileId: 7,
    connector: "idealista",
    label: "Idealista — pisos",
    url: IDEALISTA_URL,
    sectionKey: "venta-viviendas",
    overridden: false,
    loosened: [],
    chips: ["Sección: venta-viviendas", "Zona: sevilla-sevilla"],
    warnings: [],
    unparseable: false,
  };
}

describe("FilterValidationRow (issue #478 P2)", () => {
  beforeEach(() => {
    mockRefresh.mockClear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the 'derivada del perfil' badge and the URL for a non-overridden row", () => {
    render(<FilterValidationRow {...baseProps()} />);
    expect(screen.getByTestId("filter-source-badge")).toHaveTextContent("derivada del perfil");
    expect(screen.getByTestId("filter-url")).toHaveTextContent(IDEALISTA_URL);
  });

  it("shows 'URL fijada' (with source) when overridden", () => {
    render(<FilterValidationRow {...baseProps()} overridden source="extension" />);
    expect(screen.getByTestId("filter-source-badge")).toHaveTextContent("URL fijada (extensión)");
  });

  it("renders decoded chips and mismatch warnings", () => {
    render(
      <FilterValidationRow
        {...baseProps()}
        warnings={["El perfil pide ≤200.000 € pero la URL no filtra por precio máximo; los resultados serán más amplios."]}
      />,
    );
    expect(screen.getByTestId("filter-chips")).toHaveTextContent("Sección: venta-viviendas");
    expect(screen.getByTestId("filter-warnings")).toHaveTextContent("no filtra por precio máximo");
  });

  it("notes 'se usará tal cual' for an unparseable URL", () => {
    render(<FilterValidationRow {...baseProps()} unparseable chips={[]} />);
    expect(screen.getByTestId("filter-unparseable")).toHaveTextContent("se usará tal cual");
  });

  it("Guardar PUTs the edited URL then refreshes", async () => {
    render(<FilterValidationRow {...baseProps()} />);
    const input = screen.getByTestId("filter-url-input");
    const newUrl = "https://www.idealista.com/venta-viviendas/sevilla-sevilla/con-precio-hasta_180000/";
    fireEvent.change(input, { target: { value: newUrl } });
    fireEvent.click(screen.getByTestId("filter-save"));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/profiles/7/connector-filters");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ connector: "idealista", sectionKey: "venta-viviendas", url: newUrl, source: "manual" });
  });

  it("Save is disabled when the draft is unchanged or empty", () => {
    render(<FilterValidationRow {...baseProps()} />);
    // Draft equals url initially → disabled.
    expect(screen.getByTestId("filter-save")).toBeDisabled();
  });

  it("Quitar DELETEs the override then refreshes (only when overridden)", async () => {
    render(<FilterValidationRow {...baseProps()} overridden source="manual" />);
    fireEvent.click(screen.getByTestId("filter-remove"));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("/api/profiles/7/connector-filters?");
    expect(String(url)).toContain("connector=idealista");
    expect(String(url)).toContain("sectionKey=venta-viviendas");
    expect(init.method).toBe("DELETE");
  });

  it("does not render Quitar for a derived (non-overridden) row", () => {
    render(<FilterValidationRow {...baseProps()} />);
    expect(screen.queryByTestId("filter-remove")).not.toBeInTheDocument();
  });

  it("Abrir opens the URL tagged with the validation signal (#478 P3)", () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    render(<FilterValidationRow {...baseProps()} />);
    fireEvent.click(screen.getByTestId("filter-open"));
    // profileId=7, connector="idealista" → #inmo-validate=7:idealista, so the
    // extension enters validation mode (no capture) on the opened tab.
    expect(openSpy).toHaveBeenCalledWith(
      `${IDEALISTA_URL}#inmo-validate=7:idealista`,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("empty-URL row shows the no-URL note and disables Abrir", () => {
    render(<FilterValidationRow {...baseProps()} url="" sectionKey="" chips={[]} connector="altamira" label="Altamira" />);
    expect(screen.getByTestId("filter-no-url")).toBeInTheDocument();
    expect(screen.getByTestId("filter-open")).toBeDisabled();
    expect(screen.queryByTestId("filter-url")).not.toBeInTheDocument();
  });

  it("verbatim-only portal (altamira #497) shows the honest note and 'sin URL fijada' badge", () => {
    render(
      <FilterValidationRow
        {...baseProps()}
        connector="altamira"
        label="Altamira"
        url=""
        sectionKey=""
        chips={[]}
        verbatimOnly
      />,
    );
    expect(screen.getByTestId("filter-verbatim-note")).toHaveTextContent("se usa tal cual");
    expect(screen.getByTestId("filter-source-badge")).toHaveTextContent("sin URL fijada");
  });

  it("verbatim-only portal suppresses the misleading 'no se pudo descodificar' note", () => {
    render(
      <FilterValidationRow
        {...baseProps()}
        connector="altamira"
        label="Altamira"
        url="https://www.altamirainmuebles.com/venta/piso/sevilla"
        overridden
        source="manual"
        sectionKey=""
        chips={[]}
        unparseable
        verbatimOnly
      />,
    );
    // The honest note stands in for the generic unparseable one.
    expect(screen.getByTestId("filter-verbatim-note")).toBeInTheDocument();
    expect(screen.queryByTestId("filter-unparseable")).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-source-badge")).toHaveTextContent("URL fijada");
  });
});
