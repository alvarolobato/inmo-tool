// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PortalCaptureCard } from "../PortalCaptureCard";
import type { PortalCaptureView } from "@/lib/captura-view";

function makeView(over: Partial<PortalCaptureView> = {}): PortalCaptureView {
  return {
    portal: "aliseda",
    searchUrl: "https://www.alisedainmobiliaria.com/venta?precioMax=200000",
    loosened: [],
    summary: {
      source_portal: "aliseda",
      total: 10,
      pending: 4,
      captured: 5,
      failed: 1,
      skipped: 0,
    },
    capturedPct: 50,
    ...over,
  };
}

describe("PortalCaptureCard", () => {
  it("renders the portal label and a pre-filtered 'Abrir búsqueda' link", () => {
    render(<PortalCaptureCard view={makeView()} />);
    expect(screen.getByTestId("captura-portal-aliseda")).toBeInTheDocument();
    const link = screen.getByTestId("captura-open-aliseda");
    expect(link).toHaveAttribute("href", "https://www.alisedainmobiliaria.com/venta?precioMax=200000");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText("Aliseda")).toBeInTheDocument();
  });

  it("shows the worklist progress and an accessible progress bar", () => {
    render(<PortalCaptureCard view={makeView()} />);
    expect(screen.getByTestId("captura-captured-aliseda")).toHaveTextContent("5/10 capturadas");
    const bar = screen.getByTestId("captura-progress-aliseda");
    expect(bar).toHaveAttribute("role", "progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("4 pendientes")).toBeInTheDocument();
    expect(screen.getByText("1 fallidas")).toBeInTheDocument();
  });

  it("surfaces loosened-constraint notes as 'búsqueda ampliada'", () => {
    render(
      <PortalCaptureCard
        view={makeView({
          loosened: [{ constraint: "geography", reason: "Aliseda no busca por radio." }],
        })}
      />,
    );
    const note = screen.getByTestId("captura-loosened-aliseda");
    expect(note).toHaveTextContent("búsqueda ampliada");
    expect(note).toHaveTextContent("Aliseda no busca por radio.");
  });

  it("renders no loosened block when there are no loosened constraints", () => {
    render(<PortalCaptureCard view={makeView({ loosened: [] })} />);
    expect(screen.queryByTestId("captura-loosened-aliseda")).not.toBeInTheDocument();
  });

  it("shows an 'aún sin lista' hint when the portal has no worklist rows yet", () => {
    render(<PortalCaptureCard view={makeView({ summary: null, capturedPct: 0 })} />);
    expect(screen.getByTestId("captura-nolist-aliseda")).toBeInTheDocument();
    expect(screen.queryByTestId("captura-progress-aliseda")).not.toBeInTheDocument();
  });

  it("hides the failed/skipped counters when those counts are zero", () => {
    render(
      <PortalCaptureCard
        view={makeView({
          summary: { source_portal: "aliseda", total: 5, pending: 2, captured: 3, failed: 0, skipped: 0 },
        })}
      />,
    );
    expect(screen.queryByText(/fallidas/)).not.toBeInTheDocument();
    expect(screen.queryByText(/omitidas/)).not.toBeInTheDocument();
  });
});
