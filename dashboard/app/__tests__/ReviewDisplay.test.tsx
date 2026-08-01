// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ReviewDisplay from "@/components/ReviewDisplay";
import type { ReviewContent } from "@/lib/review-schema";

// ─── Test data (weekly review v2) ─────────────────────────────────────────────

const sampleReview: ReviewContent & { id: number; week_start: string } = {
  id: 1,
  week_start: "2026-04-01",
  review_schema_version: 2,
  executive_summary: [
    "Las ventas netas han aumentado un 12% respecto a la semana anterior",
    "La tienda 03 lidera en ventas con 8.200€",
    "El canal mayorista registra 15 nuevas facturas",
  ],
  sections: [
    {
      key: "ventas_retail",
      title: "Ventas Retail",
      narrative:
        "Esta semana las ventas retail alcanzaron 45.230€, un incremento del 12% respecto a la semana anterior.\n\nLa tienda 03 continúa liderando con 8.200€, seguida por las tiendas 01 y 05.",
      kpis: ["Ventas netas +12%"],
      evidence_queries: ["ventas_semana_cerrada", "ventas_semana_previa"],
      dashboard_key: "ventas_retail",
    },
    {
      key: "canal_mayorista",
      title: "Canal Mayorista",
      narrative:
        "La facturación mayorista esta semana asciende a 23.500€ en 15 facturas.\n\nEl cliente MODAS SL sigue siendo el principal cliente con 8.000€.",
      kpis: ["15 facturas"],
      evidence_queries: ["facturacion_mayorista_semana_cerrada"],
      dashboard_key: "canal_mayorista",
    },
    {
      key: "stock",
      title: "Stock y Logística",
      narrative:
        "El stock total asciende a 12.450 unidades en 380 referencias.\n\nSe han identificado 8 artículos con stock crítico (menos de 5 unidades).",
      kpis: ["12.450 uds"],
      evidence_queries: ["stock_total_unidades", "articulos_stock_critico"],
      dashboard_key: "stock",
    },
    {
      key: "compras",
      title: "Compras",
      narrative:
        "Esta semana se han realizado 3 pedidos de compra por un importe total de 15.000€.\n\nEsto supone un incremento del 20% respecto a la semana anterior.",
      kpis: ["3 pedidos"],
      evidence_queries: ["compras_semana_cerrada", "compras_semana_previa"],
      dashboard_key: "compras",
    },
  ],
  action_items: [
    {
      action_key: "revisar_stock_critico",
      priority: "alta",
      owner_role: "Dirección de tiendas",
      owner_name: "",
      due_date: "2026-04-10",
      action: "Revisar stock crítico de 8 referencias con menos de 5 unidades",
      expected_impact: "Reducir roturas en tienda",
      evidence_queries: ["articulos_stock_critico"],
      dashboard_key: "stock",
    },
    {
      action_key: "contactar_clientes_mayorista",
      priority: "media",
      owner_role: "Ventas B2B",
      owner_name: "",
      due_date: "2026-04-12",
      action: "Contactar con los 3 clientes mayoristas pendientes de factura",
      expected_impact: "Mejor cobro",
      evidence_queries: ["top3_clientes_mayorista_semana_cerrada"],
      dashboard_key: "canal_mayorista",
    },
    {
      action_key: "planificar_traspasos",
      priority: "baja",
      owner_role: "Logística",
      owner_name: "",
      due_date: "2026-04-15",
      action: "Planificar traspasos entre tiendas para optimizar el stock",
      expected_impact: "Mejor distribución entre tiendas",
      evidence_queries: ["traspasos_semana_cerrada"],
      dashboard_key: "stock",
    },
  ],
  data_quality_notes: [],
  generated_at: "2026-04-05T10:00:00.000Z",
  quality_status: "ok",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ReviewDisplay", () => {
  const originalClipboard = globalThis.navigator.clipboard;
  let printSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      configurable: true,
      writable: true,
    });
    printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
    printSpy.mockRestore();
  });

  it("renders the executive summary section", () => {
    render(<ReviewDisplay review={sampleReview} />);
    expect(screen.getByTestId("executive-summary")).toBeInTheDocument();
    expect(screen.getByText("Resumen Ejecutivo")).toBeInTheDocument();
  });

  it("renders all executive summary bullet points", () => {
    render(<ReviewDisplay review={sampleReview} />);
    expect(screen.getByText(/Las ventas netas han aumentado/)).toBeInTheDocument();
    expect(screen.getByText(/La tienda 03 lidera en ventas/)).toBeInTheDocument();
  });

  it("renders all 4 domain sections", () => {
    render(<ReviewDisplay review={sampleReview} />);
    expect(screen.getByText("Ventas Retail")).toBeInTheDocument();
    expect(screen.getByText("Canal Mayorista")).toBeInTheDocument();
    expect(screen.getByText("Stock y Logística")).toBeInTheDocument();
    expect(screen.getByText("Compras")).toBeInTheDocument();
  });

  it("renders section content", () => {
    render(<ReviewDisplay review={sampleReview} />);
    expect(screen.getByText(/ventas retail alcanzaron 45\.230€/)).toBeInTheDocument();
  });

  it("renders action items section", () => {
    render(<ReviewDisplay review={sampleReview} />);
    expect(screen.getByTestId("action-items")).toBeInTheDocument();
    expect(screen.getByText("Acciones Recomendadas")).toBeInTheDocument();
  });

  it("renders all action items", () => {
    render(<ReviewDisplay review={sampleReview} />);
    expect(screen.getByText(/Revisar stock crítico/)).toBeInTheDocument();
    expect(screen.getByText(/Contactar con los 3 clientes/)).toBeInTheDocument();
    expect(screen.getByText(/Planificar traspasos/)).toBeInTheDocument();
  });

  it("renders priority badges for action items with priority markers", () => {
    render(<ReviewDisplay review={sampleReview} />);
    const altaBadges = screen.getAllByText("alta");
    expect(altaBadges.length).toBeGreaterThan(0);
  });

  it("renders the generated_at timestamp", () => {
    render(<ReviewDisplay review={sampleReview} />);
    const generatedTexts = screen.getAllByText(/Generado el/);
    expect(generatedTexts.length).toBeGreaterThan(0);
  });

  it("renders week_start in the toolbar", () => {
    render(<ReviewDisplay review={sampleReview} />);
    expect(screen.getByText(/Semana del/)).toBeInTheDocument();
  });

  it("renders the print button", () => {
    render(<ReviewDisplay review={sampleReview} />);
    expect(screen.getByTestId("print-button")).toBeInTheDocument();
    expect(screen.getByText("Imprimir")).toBeInTheDocument();
  });

  it("clicking print button calls window.print", () => {
    render(<ReviewDisplay review={sampleReview} />);
    fireEvent.click(screen.getByTestId("print-button"));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it("renders the copy button", () => {
    render(<ReviewDisplay review={sampleReview} />);
    expect(screen.getByTestId("copy-button")).toBeInTheDocument();
    expect(screen.getByText("Copiar")).toBeInTheDocument();
  });

  it("clicking copy button copies text to clipboard", async () => {
    render(<ReviewDisplay review={sampleReview} />);
    fireEvent.click(screen.getByTestId("copy-button"));
    await waitFor(() => {
      expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    });
    const callArg = (globalThis.navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(callArg).toContain("REVISIÓN SEMANAL");
    expect(callArg).toContain("VENTAS RETAIL");
  });

  it("shows 'Copiado' feedback after copy", async () => {
    render(<ReviewDisplay review={sampleReview} />);
    fireEvent.click(screen.getByTestId("copy-button"));
    await waitFor(() => {
      expect(screen.getByText("Copiado")).toBeInTheDocument();
    });
  });

  // ─── Contrast / amber palette regression tests (issue #399) ────────────────
  // The previous palette used `text-amber-200` on a translucent amber tint,
  // which failed WCAG AA on light theme. Lock in a palette that sits on a
  // darker amber text for light mode and a lighter amber text for dark mode.

  it("renders the 'Calidad de datos degradada' badge with accessible amber classes", () => {
    const degraded: ReviewContent & { id: number; week_start: string } = {
      ...sampleReview,
      quality_status: "degraded",
    };
    render(<ReviewDisplay review={degraded} />);
    const badge = screen.getByTestId("quality-degraded");
    const className = badge.className;
    // Must carry a dark-ink amber text token for light mode.
    expect(className).toMatch(/\btext-amber-(800|900)\b/);
    // Must keep a light-ink amber text token for dark mode.
    expect(className).toMatch(/\bdark:text-amber-(50|100)\b/);
    // Must NOT keep the broken light amber text on light mode.
    expect(className).not.toMatch(/(^|\s)text-amber-(100|200)(\s|$)/);
  });

  it("renders the data-quality-notes panel with warn token styling", () => {
    const withNotes: ReviewContent & { id: number; week_start: string } = {
      ...sampleReview,
      data_quality_notes: ["Faltan ventas de la tienda 07 para el lunes"],
    };
    render(<ReviewDisplay review={withNotes} />);
    const panel = screen.getByTestId("data-quality-notes");
    // Panel is present and renders the note content
    expect(panel).toBeInTheDocument();
    expect(screen.getByText("Faltan ventas de la tienda 07 para el lunes")).toBeInTheDocument();
    // Uses CSS-variable-based warn styling (not hardcoded amber classes)
    const style = panel.getAttribute("style") ?? "";
    expect(style).toContain("var(--warn)");
  });
});
