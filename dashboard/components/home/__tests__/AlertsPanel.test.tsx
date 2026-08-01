// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AlertsPanel } from "../AlertsPanel";
import type { HomeAlert } from "@/lib/home-types";

const ALERTS: HomeAlert[] = [
  { sev: "crit", store: "97 — Toledo Centro",       reason: "0€ ventas hoy · ayer 1.245€", expected: "Lun-Vie operativa", since: "hace 4h",   action: "Llamar tienda" },
  { sev: "crit", store: "804 — Outlet San Fernando", reason: "0€ ventas hoy · ayer 1.890€", expected: "L-D operativa",    since: "hace 4h",   action: "Llamar tienda" },
  { sev: "warn", store: "601 — Zaragoza Independ.",  reason: "Ventas −14,2% · margen 27,8%", expected: "Media red 61%",  since: "3 días",     action: "Revisar descuentos" },
  { sev: "warn", store: "606 — Bilbao Gran Vía",     reason: "Ventas −6,4% vs ayer",         expected: "Promedio +2%",   since: "hoy",        action: "Comparar familias" },
  { sev: "info", store: "159 — Vigo Príncipe",       reason: "Cerrada por reforma",           expected: "Reapertura 12 may", since: "hace 6 días", action: "Ignorar" },
];

describe("AlertsPanel", () => {
  it("renders alerts panel container", () => {
    render(<AlertsPanel alerts={ALERTS} />);
    expect(screen.getByTestId("alerts-panel")).toBeInTheDocument();
  });

  it("renders CRÍTICO pill for crit alerts", () => {
    render(<AlertsPanel alerts={ALERTS} />);
    const critItems = screen.getAllByText("CRÍTICO");
    expect(critItems).toHaveLength(2);
  });

  it("renders AVISO pill for warn alerts", () => {
    render(<AlertsPanel alerts={ALERTS} />);
    const warnItems = screen.getAllByText("AVISO");
    expect(warnItems).toHaveLength(2);
  });

  it("renders INFO pill for info alert", () => {
    render(<AlertsPanel alerts={ALERTS} />);
    expect(screen.getByText("INFO")).toBeInTheDocument();
  });

  it("shows store name in each alert", () => {
    render(<AlertsPanel alerts={ALERTS} />);
    expect(screen.getByText("97 — Toledo Centro")).toBeInTheDocument();
    expect(screen.getByText("159 — Vigo Príncipe")).toBeInTheDocument();
  });

  it("shows action button for each alert", () => {
    render(<AlertsPanel alerts={ALERTS} />);
    const llamarBtns = screen.getAllByText("Llamar tienda →");
    expect(llamarBtns).toHaveLength(2);
  });

  it("renders empty state when no alerts", () => {
    render(<AlertsPanel alerts={[]} />);
    expect(screen.getByTestId("alerts-empty")).toBeInTheDocument();
    expect(screen.getByText(/Todo bajo control/)).toBeInTheDocument();
  });

  it("shows active count subtitle", () => {
    render(<AlertsPanel alerts={ALERTS} />);
    // 4 non-info alerts
    expect(screen.getByText(/4 activas/)).toBeInTheDocument();
  });

  it("gives every alert a unique data-testid even when severities repeat", () => {
    render(<AlertsPanel alerts={ALERTS} />);
    // 5 alerts → 5 distinct testids, indexed
    expect(screen.getByTestId("alert-item-crit-0")).toBeInTheDocument();
    expect(screen.getByTestId("alert-item-crit-1")).toBeInTheDocument();
    expect(screen.getByTestId("alert-item-warn-2")).toBeInTheDocument();
    expect(screen.getByTestId("alert-item-warn-3")).toBeInTheDocument();
    expect(screen.getByTestId("alert-item-info-4")).toBeInTheDocument();
  });

  it("disables action button when alert has no href", () => {
    // None of the mock alerts have href → all action buttons must be disabled.
    render(<AlertsPanel alerts={ALERTS} />);
    const buttons = screen.getAllByRole("button", { name: /Llamar tienda|Revisar|Comparar|Ignorar/ });
    expect(buttons.length).toBeGreaterThan(0);
    buttons.forEach((b) => expect(b).toBeDisabled());
  });

  it("enables action button when alert has href", () => {
    const withHref: HomeViewModel["alerts"] = [
      { sev: "crit", store: "X", reason: "r", expected: "e", since: "now", action: "Abrir", href: "https://example.test" },
    ];
    render(<AlertsPanel alerts={withHref} />);
    const btn = screen.getByRole("button", { name: /Abrir/ });
    expect(btn).not.toBeDisabled();
  });

  it("disables 'Configurar reglas' button (placeholder until wired up)", () => {
    render(<AlertsPanel alerts={ALERTS} />);
    const btn = screen.getByRole("button", { name: /Configurar reglas/ });
    expect(btn).toBeDisabled();
  });
});
