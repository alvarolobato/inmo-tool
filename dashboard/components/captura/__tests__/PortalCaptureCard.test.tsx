// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PortalCaptureCard } from "../PortalCaptureCard";
import type { PortalCaptureView, CaptureTaskLink } from "@/lib/captura-view";

const TASK_ID = "aliseda:pisos:0000abcd";
const TASK_URL =
  "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000";

function makeTask(over: Partial<CaptureTaskLink> = {}): CaptureTaskLink {
  return {
    id: over.id ?? TASK_ID,
    label: over.label ?? "Aliseda — pisos en Malaga ≤200.000 €",
    url: over.url ?? TASK_URL,
    loosened: over.loosened ?? [],
  };
}

function makeView(over: Partial<PortalCaptureView> = {}): PortalCaptureView {
  return {
    portal: "aliseda",
    tasks: over.tasks ?? [makeTask()],
    summary:
      over.summary === undefined
        ? { source_portal: "aliseda", total: 10, pending: 4, captured: 5, failed: 1, skipped: 0 }
        : over.summary,
    capturedPct: over.capturedPct ?? 50,
  };
}

describe("PortalCaptureCard", () => {
  it("renders the portal label and a pre-filtered 'Abrir búsqueda' link per task", () => {
    render(<PortalCaptureCard view={makeView()} />);
    expect(screen.getByTestId("captura-portal-aliseda")).toBeInTheDocument();
    const link = screen.getByTestId(`captura-open-${TASK_ID}`);
    expect(link).toHaveAttribute("href", TASK_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText("Aliseda")).toBeInTheDocument();
    expect(screen.getByText("Aliseda — pisos en Malaga ≤200.000 €")).toBeInTheDocument();
  });

  it("renders one launch link per task", () => {
    render(
      <PortalCaptureCard
        view={makeView({
          tasks: [
            makeTask({ id: "aliseda:pisos:1", url: "https://a/pisos" }),
            makeTask({ id: "aliseda:aticos:2", url: "https://a/aticos" }),
          ],
        })}
      />,
    );
    expect(screen.getByTestId("captura-open-aliseda:pisos:1")).toHaveAttribute("href", "https://a/pisos");
    expect(screen.getByTestId("captura-open-aliseda:aticos:2")).toHaveAttribute("href", "https://a/aticos");
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

  it("surfaces a task's loosened-constraint notes as 'búsqueda ampliada'", () => {
    render(
      <PortalCaptureCard
        view={makeView({
          tasks: [makeTask({ loosened: [{ constraint: "geography", reason: "Aliseda no busca por radio." }] })],
        })}
      />,
    );
    const note = screen.getByTestId(`captura-loosened-${TASK_ID}`);
    expect(note).toHaveTextContent("búsqueda ampliada");
    expect(note).toHaveTextContent("Aliseda no busca por radio.");
  });

  it("renders no loosened block when a task has no loosened constraints", () => {
    render(<PortalCaptureCard view={makeView({ tasks: [makeTask({ loosened: [] })] })} />);
    expect(screen.queryByTestId(`captura-loosened-${TASK_ID}`)).not.toBeInTheDocument();
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
