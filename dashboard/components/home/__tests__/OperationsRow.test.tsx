// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { OperationsRow } from "../OperationsRow";
import type { Metric } from "@/lib/home-types";

const RETAIL_METRICS: Metric[] = [
  { id: "ticket",     label: "Ticket medio", value: 26.55, format: "eur2", delta:  0.138 },
  { id: "tickets",    label: "Tickets",      value: 5077,  format: "int",  delta: -0.287 },
  { id: "margen",     label: "Margen",       value: 0.612, format: "pct",  delta: -0.012 },
  { id: "tasa-devol", label: "Tasa devol.",  value: 0.038, format: "pct",  delta:  0.083, inverted: true,
    sub: "12.522 €", baseline: { value: 0.035, label: "media 30d" } },
  { id: "conver",     label: "Conversión",   value: 0.184, format: "pct",  delta:  0.006 },
];

describe("OperationsRow (RETAIL)", () => {
  it("renders all 5 metric cells", () => {
    render(
      <OperationsRow
        sectionLabel="RETAIL"
        title="Operativa retail"
        subtitle="hoy · vs ayer mismo tramo"
        metrics={RETAIL_METRICS}
      />
    );
    expect(screen.getByTestId("metric-cell-ticket")).toBeInTheDocument();
    expect(screen.getByTestId("metric-cell-tickets")).toBeInTheDocument();
    expect(screen.getByTestId("metric-cell-margen")).toBeInTheDocument();
    expect(screen.getByTestId("metric-cell-tasa-devol")).toBeInTheDocument();
    expect(screen.getByTestId("metric-cell-conver")).toBeInTheDocument();
  });

  it("renders section label RETAIL", () => {
    render(
      <OperationsRow
        sectionLabel="RETAIL"
        title="Operativa retail"
        subtitle="hoy · vs ayer mismo tramo"
        metrics={RETAIL_METRICS}
      />
    );
    expect(screen.getByText("RETAIL")).toBeInTheDocument();
  });

  it("renders subtitle", () => {
    render(
      <OperationsRow
        sectionLabel="RETAIL"
        title="Operativa retail"
        subtitle="hoy · vs ayer mismo tramo"
        metrics={RETAIL_METRICS}
      />
    );
    expect(screen.getByText("hoy · vs ayer mismo tramo")).toBeInTheDocument();
  });

  it("renders the Tasa devol. delta with inverted logic (positive delta → down color)", () => {
    render(
      <OperationsRow
        sectionLabel="RETAIL"
        title="Operativa retail"
        subtitle="hoy · vs ayer mismo tramo"
        metrics={RETAIL_METRICS}
      />
    );
    const devoluCell = screen.getByTestId("metric-cell-tasa-devol");
    // The Delta chip for inverted=true, value=0.083 (positive) should render with --down color
    const chipStyle = devoluCell.querySelector("[aria-label]")?.getAttribute("style") ?? "";
    expect(chipStyle).toContain("var(--down)");
  });

  it("renders baseline label when metric has baseline", () => {
    render(
      <OperationsRow
        sectionLabel="RETAIL"
        title="Operativa retail"
        subtitle="hoy · vs ayer mismo tramo"
        metrics={RETAIL_METRICS}
      />
    );
    const devoluCell = screen.getByTestId("metric-cell-tasa-devol");
    const baseline = screen.getByTestId("metric-baseline-tasa-devol");
    expect(baseline).toBeInTheDocument();
    expect(devoluCell.textContent).toContain("media 30d");
  });

  it("highlights baseline when rate exceeds threshold (inverted + >1pp above baseline)", () => {
    const highRateMetric: Metric = {
      id: "tasa-devol",
      label: "Tasa devol.",
      value: 0.06, // 6% — more than 1pp above baseline 3.5%
      format: "pct",
      delta: 0.2,
      inverted: true,
      sub: "500 €",
      baseline: { value: 0.035, label: "media 30d" },
    };
    render(
      <OperationsRow
        sectionLabel="RETAIL"
        title="Operativa retail"
        subtitle="hoy · vs ayer"
        metrics={[highRateMetric]}
      />
    );
    const baseline = screen.getByTestId("metric-baseline-tasa-devol");
    expect(baseline.getAttribute("style")).toContain("var(--down)");
  });

  it("does NOT highlight baseline when rate is within threshold", () => {
    const normalRateMetric: Metric = {
      id: "tasa-devol",
      label: "Tasa devol.",
      value: 0.038, // 3.8% — only 0.3pp above baseline 3.5%
      format: "pct",
      delta: 0.1,
      inverted: true,
      sub: "200 €",
      baseline: { value: 0.035, label: "media 30d" },
    };
    render(
      <OperationsRow
        sectionLabel="RETAIL"
        title="Operativa retail"
        subtitle="hoy · vs ayer"
        metrics={[normalRateMetric]}
      />
    );
    const baseline = screen.getByTestId("metric-baseline-tasa-devol");
    expect(baseline.getAttribute("style")).not.toContain("var(--down)");
  });

  it("does not render baseline element when metric has no baseline", () => {
    render(
      <OperationsRow
        sectionLabel="RETAIL"
        title="Operativa retail"
        subtitle="hoy · vs ayer"
        metrics={[{ id: "ticket", label: "Ticket medio", value: 26.55, format: "eur2", delta: 0.1 }]}
      />
    );
    expect(screen.queryByTestId("metric-baseline-ticket")).not.toBeInTheDocument();
  });

  it("renders — when delta is null (no comparison data available)", () => {
    const metricsWithNull: Metric[] = [
      { id: "ticket", label: "Ticket medio", value: 26.55, format: "eur2", delta: null, sub: "vs ayer" },
      ...RETAIL_METRICS.slice(1),
    ];
    render(
      <OperationsRow
        sectionLabel="RETAIL"
        title="Operativa retail"
        subtitle="hoy · vs ayer"
        metrics={metricsWithNull}
      />
    );
    const ticketCell = screen.getByTestId("metric-cell-ticket");
    // Delta component renders an em dash when value is null
    expect(ticketCell.textContent).toContain("—");
    // The sub label is still shown
    expect(ticketCell.textContent).toContain("vs ayer");
  });

  it("renders correct number of metrics for MAYORISTA", () => {
    const wholesale: Metric[] = [
      { id: "fact",  label: "Facturación",        value: 84200,   format: "eur", delta:  0.041 },
      { id: "pend",  label: "Pedidos pendientes", value: 47,      format: "int", delta:  0.064, sub: "€312k valor" },
      { id: "stock", label: "Valor stock",        value: 2228214, format: "eur", delta: -0.018 },
      { id: "rotac", label: "Rotación",           value: 4.2,     format: "x",   delta:  0.08,  suffix: "x/año" },
    ];
    render(
      <OperationsRow
        sectionLabel="MAYORISTA"
        title="Operativa mayorista"
        subtitle="mes en curso · vs mes anterior"
        metrics={wholesale}
      />
    );
    expect(screen.getByTestId("operations-row-mayorista")).toBeInTheDocument();
    expect(screen.getByTestId("metric-cell-fact")).toBeInTheDocument();
    expect(screen.getByTestId("metric-cell-rotac")).toBeInTheDocument();
    // Sub-text for pedidos pendientes
    expect(screen.getByText("€312k valor")).toBeInTheDocument();
  });
});
