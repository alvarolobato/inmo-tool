// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PeriodGrid } from "../PeriodGrid";
import type { HomeViewModel } from "@/lib/home-types";

const PERIODS: HomeViewModel["periods"] = [
  {
    id: "hoy",
    label: "Hoy",
    value: 38420,
    deltaPrev: 0.082,
    prevLabel: "vs ayer",
    deltaYoY: -0.114,
    yoyLabel: "vs lun 5 may 2025",
    spark: [29200, 31100, 33800, 28900, 35510, 30200, 38420],
    sparkLabels: ["mar", "mié", "jue", "vie", "sáb", "dom", "hoy"],
  },
  {
    id: "semana",
    label: "Semana",
    value: 218400,
    deltaPrev: -0.043,
    prevLabel: "vs sem ant",
    deltaYoY: -0.092,
    yoyLabel: "vs sem 18 2025",
    spark: [195400, 210800, 228180, 232400, 205100, 218400],
    sparkLabels: ["s14", "s15", "s16", "s17", "s18", "s19"],
  },
  {
    id: "mes",
    label: "Mes",
    value: 134802,
    deltaPrev: -0.189,
    prevLabel: "vs abril",
    deltaYoY: -0.132,
    yoyLabel: "vs may 2025",
    spark: [142100, 148300, 159200, 166217, 134802],
    sparkLabels: ["ene", "feb", "mar", "abr", "may"],
  },
  {
    id: "anyo",
    label: "Año (YTD)",
    value: 1842600,
    deltaPrev: 0.034,
    prevLabel: "vs YTD 2025",
    deltaYoY: 0.034,
    yoyLabel: "vs 2025 mismo tramo",
    spark: [320100, 389200, 415300, 477200, 134802],
    sparkLabels: ["ene", "feb", "mar", "abr", "may"],
  },
];

describe("PeriodGrid", () => {
  it("renders all 4 period cards", () => {
    render(<PeriodGrid periods={PERIODS} />);
    expect(screen.getByTestId("period-card-hoy")).toBeInTheDocument();
    expect(screen.getByTestId("period-card-semana")).toBeInTheDocument();
    expect(screen.getByTestId("period-card-mes")).toBeInTheDocument();
    expect(screen.getByTestId("period-card-anyo")).toBeInTheDocument();
  });

  it("renders positive deltaPrev in Hoy card", () => {
    render(<PeriodGrid periods={PERIODS} />);
    const hoyCard = screen.getByTestId("period-card-hoy");
    expect(hoyCard.textContent).toContain("+8,2%");
  });

  it("renders negative deltaYoY in Hoy card", () => {
    render(<PeriodGrid periods={PERIODS} />);
    const hoyCard = screen.getByTestId("period-card-hoy");
    expect(hoyCard.textContent).toContain("-11,4%");
  });

  it("renders correct section title", () => {
    render(<PeriodGrid periods={PERIODS} />);
    expect(screen.getByRole("heading", { name: "Comparativa por periodo" })).toBeInTheDocument();
  });

  it("renders 'vs año pasado' label in each card", () => {
    render(<PeriodGrid periods={PERIODS} />);
    const labels = screen.getAllByText("vs año pasado");
    expect(labels).toHaveLength(4);
  });

  it("renders em-dash when deltaYoY is null", () => {
    const periodsWithMissingYoY: HomeViewModel["periods"] = [
      { ...PERIODS[0], deltaYoY: null },
    ];
    render(<PeriodGrid periods={periodsWithMissingYoY} />);
    expect(screen.getByTestId("period-card-hoy").textContent).toContain("—");
  });

  it("renders custom title and subtitle when provided", () => {
    render(
      <PeriodGrid
        periods={PERIODS}
        title="Margen bruto"
        subtitle="Margen — actual vs periodo anterior y vs año pasado"
      />,
    );
    expect(screen.getByRole("heading", { name: "Margen bruto" })).toBeInTheDocument();
    expect(
      screen.getByText("Margen — actual vs periodo anterior y vs año pasado"),
    ).toBeInTheDocument();
  });
});

const MARGIN_PERIODS: HomeViewModel["marginPeriods"] = [
  {
    id: "hoy",
    label: "Hoy",
    value: 0.521,
    deltaPrev: -0.03,
    prevLabel: "vs ayer",
    deltaYoY: -0.015,
    yoyLabel: "vs lun 5 may 2025",
    spark: [0.54, 0.53, 0.52, 0.51, 0.52, 0.53, 0.521],
    sparkLabels: ["mar", "mié", "jue", "vie", "sáb", "dom", "hoy"],
  },
  {
    id: "semana",
    label: "Semana",
    value: 0.48,
    deltaPrev: 0.01,
    prevLabel: "vs sem ant",
    deltaYoY: null,
    yoyLabel: "vs sem 18 2025",
    spark: [0.47, 0.48, 0.49, 0.48, 0.47, 0.48],
    sparkLabels: ["s14", "s15", "s16", "s17", "s18", "s19"],
  },
  {
    id: "mes",
    label: "Mes",
    value: 0.502,
    deltaPrev: -0.02,
    prevLabel: "vs abril",
    deltaYoY: -0.01,
    yoyLabel: "vs may 2025",
    spark: [0.51, 0.51, 0.50, 0.50, 0.502],
    sparkLabels: ["ene", "feb", "mar", "abr", "may"],
  },
  {
    id: "anyo",
    label: "Año (YTD)",
    value: 0.495,
    deltaPrev: 0.005,
    prevLabel: "vs YTD 2025",
    deltaYoY: 0.005,
    yoyLabel: "vs 2025 mismo tramo",
    spark: [0.49, 0.49, 0.50, 0.50, 0.495],
    sparkLabels: ["ene", "feb", "mar", "abr", "may"],
  },
];

describe("PeriodGrid — margin (pct format)", () => {
  it("renders margin PeriodGrid with pct format", () => {
    render(
      <PeriodGrid
        periods={MARGIN_PERIODS}
        title="Margen bruto"
        subtitle="Margen — actual vs periodo anterior y vs año pasado"
        format="pct"
      />,
    );
    expect(screen.getByRole("heading", { name: "Margen bruto" })).toBeInTheDocument();
    expect(screen.getByTestId("period-card-hoy")).toBeInTheDocument();
    expect(screen.getByTestId("period-card-semana")).toBeInTheDocument();
    expect(screen.getByTestId("period-card-mes")).toBeInTheDocument();
    expect(screen.getByTestId("period-card-anyo")).toBeInTheDocument();
  });

  it("renders value as percentage for pct format (52,1 %)", () => {
    render(
      <PeriodGrid periods={MARGIN_PERIODS} title="Margen bruto" format="pct" />,
    );
    const hoyCard = screen.getByTestId("period-card-hoy");
    // Intl.NumberFormat es-ES percent style produces "52,1 %" (narrow-no-break space before %)
    expect(hoyCard.textContent).toMatch(/52[,.]1\s*%/);
  });

  it("renders sparkline in margin cards", () => {
    render(
      <PeriodGrid periods={MARGIN_PERIODS} title="Margen bruto" format="pct" />,
    );
    // Each card with a non-empty spark array renders a HomeSparkline (aria-label on svg)
    const hoyCard = screen.getByTestId("period-card-hoy");
    expect(within(hoyCard).getByLabelText("Tendencia Hoy")).toBeInTheDocument();
  });

  it("renders em-dash when deltaYoY is null in margin card", () => {
    render(
      <PeriodGrid periods={MARGIN_PERIODS} title="Margen bruto" format="pct" />,
    );
    const semCard = screen.getByTestId("period-card-semana");
    expect(semCard.textContent).toContain("—");
  });

  it("renders em-dash for value when margin value is null (no-revenue period)", () => {
    const periodsWithNullValue: HomeViewModel["marginPeriods"] = [
      { ...MARGIN_PERIODS[0], value: null },
    ];
    render(<PeriodGrid periods={periodsWithNullValue} title="Margen bruto" format="pct" />);
    const hoyCard = screen.getByTestId("period-card-hoy");
    expect(hoyCard.textContent).toContain("—");
  });
});
