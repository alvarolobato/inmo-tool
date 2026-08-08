// @vitest-environment jsdom
/**
 * Unit/RTL tests for EtlConnectorPreviewRow's issue #491 additions: param chips
 * with source badges, the honest downstream-filter note, and live URL→params
 * inference (amber diffs + verbatim warning for an unparseable edit).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { EtlConnectorPreviewRow } from "../EtlConnectorPreviewRow";
import type { SearchPreview } from "@/lib/db/connector-search-preview";
import type { SearchUrlGrammar } from "@/lib/connector-url/parse";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const PISOS_GRAMMAR: SearchUrlGrammar = {
  buildTemplate: "https://www.pisos.com/venta/pisos-{geography}/",
  parsePattern: "^https?://(?:www\\.)?pisos\\.com/venta/pisos-(?<geography>[^/]+)/?$",
  params: { geography: { label: "Municipio", source: "profile" } },
};

function pisosPreview(): SearchPreview {
  return {
    label: "Pisos.com — sevilla",
    url: "https://www.pisos.com/venta/pisos-sevilla/",
    kind: "search_page",
    tunable: true,
    notes: null,
    params: [
      { key: "geography", label: "Municipio", value: "sevilla", source: "profile", inUrl: true, notes: null },
      { key: "operation", label: "Operación", value: "venta", source: "constant", inUrl: true, notes: null },
    ],
  };
}

function baseProps() {
  return {
    profileId: 7,
    connector: "pisos",
    preview: pisosPreview(),
    tunable: true,
    grammar: PISOS_GRAMMAR,
    computedAt: null,
    overridden: false,
    pinnedUrl: null,
  };
}

describe("EtlConnectorPreviewRow — params + inference (issue #491)", () => {
  beforeEach(() => {
    mockRefresh.mockClear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders a param chip per resolved param with its source badge", () => {
    render(<EtlConnectorPreviewRow {...baseProps()} />);
    const chips = screen.getAllByTestId("etl-param-chip");
    expect(chips).toHaveLength(2);
    const geo = chips.find((c) => c.getAttribute("data-param-key") === "geography")!;
    expect(geo).toHaveTextContent("Municipio");
    expect(geo).toHaveTextContent("sevilla");
    expect(geo).toHaveTextContent("perfil");
    const op = chips.find((c) => c.getAttribute("data-param-key") === "operation")!;
    expect(op).toHaveTextContent("constante");
  });

  it("renders the honest downstream-filter note wherever the connector has params", () => {
    render(<EtlConnectorPreviewRow {...baseProps()} />);
    expect(screen.getByTestId("etl-downstream-note")).toHaveTextContent(
      /no viajan en esta búsqueda; se aplican después por datos/i,
    );
  });

  it("shows param chips even for a non-tunable connector (no grammar)", () => {
    render(
      <EtlConnectorPreviewRow
        {...baseProps()}
        connector="cimenta2"
        tunable={false}
        grammar={null}
        preview={{
          label: "Cimenta2",
          url: "https://inmuebles.cimenta2.com/inmuebles/s/sitemap.xml",
          kind: "sitemap",
          tunable: false,
          notes: "Barrido nacional",
          params: [
            { key: "operation", label: "Operación", value: "venta", source: "constant", inUrl: false, notes: null },
          ],
        }}
      />,
    );
    expect(screen.getAllByTestId("etl-param-chip")).toHaveLength(1);
    // No inference panel — non-tunable has no editable URL.
    expect(screen.queryByTestId("etl-inference-panel")).toBeNull();
    expect(screen.queryByTestId("etl-url-input")).toBeNull();
  });

  it("infers params live from a valid edited URL and marks a changed value amber", () => {
    render(<EtlConnectorPreviewRow {...baseProps()} />);
    const input = screen.getByTestId("etl-url-input");
    fireEvent.change(input, { target: { value: "https://www.pisos.com/venta/pisos-malaga/" } });
    const panel = screen.getByTestId("etl-inference-panel");
    expect(panel).toHaveTextContent("Esta URL significa:");
    const chip = screen.getByTestId("etl-inferred-chip");
    expect(chip).toHaveAttribute("data-param-key", "geography");
    expect(chip).toHaveTextContent("malaga");
    // Differs from the derived 'sevilla' → amber diff.
    expect(chip).toHaveAttribute("data-differs", "true");
    expect(chip).toHaveTextContent("≠ sevilla");
    expect(screen.queryByTestId("etl-inference-warning")).toBeNull();
  });

  it("does not mark an unchanged value as differing", () => {
    render(<EtlConnectorPreviewRow {...baseProps()} />);
    const input = screen.getByTestId("etl-url-input");
    fireEvent.change(input, { target: { value: "https://www.pisos.com/venta/pisos-sevilla/" } });
    const chip = screen.getByTestId("etl-inferred-chip");
    expect(chip).toHaveAttribute("data-differs", "false");
  });

  it("warns (verbatim) for an unparseable URL and keeps Guardar enabled", () => {
    render(<EtlConnectorPreviewRow {...baseProps()} />);
    const input = screen.getByTestId("etl-url-input");
    // A pisos.com search URL with an extra native-filter segment the grammar
    // doesn't model → unparseable.
    fireEvent.change(input, {
      target: { value: "https://www.pisos.com/venta/pisos-sevilla/1-habitacion/" },
    });
    expect(screen.getByTestId("etl-inference-warning")).toHaveTextContent(
      /no se pueden inferir parámetros.*se usará tal cual/i,
    );
    expect(screen.queryByTestId("etl-inference-panel")).toBeNull();
    // Guardar is NOT blocked by an unparseable edit (only by empty/unchanged).
    expect(screen.getByTestId("etl-save")).not.toBeDisabled();
  });
});
