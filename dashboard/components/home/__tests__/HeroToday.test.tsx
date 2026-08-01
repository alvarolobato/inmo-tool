// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { HeroToday } from "../HeroToday";
import type { HomeViewModel } from "@/lib/home-types";

const BASE_HERO: HomeViewModel["hero"] = {
  todayValue: 38420,
  forecastEOD: 39800,
  todayPace: 0.062,
  vsYesterday: 0.082,
  vsLY: -0.114,
  yesterday: 35510,
  lastYear: 43370,
  comparisonCutoffHour: null,
  yesterdayCutoff: null,
  lastYearCutoff: null,
  status: "on-pace",
  hourly: [
    null, null, null, null, null, null, null, null,
    1200, 6500, 12200, 18420,
    null, null, null, null, null, null, null, null,
    null, null, null, null,
  ],
  hourlyComparison: [
    0, 0, 0, 0, 0, 0, 0, 0,
    1100, 5900, 10800, 16800, 22500, 28200, 33100, 35200,
    35510, 35510, 35510, 35510, 35510, 35510, 35510, 35510,
  ],
  comparisonLabel: "Lunes anterior",
};

describe("HeroToday", () => {
  it("renders the hero value", () => {
    render(<HeroToday hero={BASE_HERO} asOf="lun 04 may · 11:42" />);
    const value = screen.getByTestId("hero-value");
    expect(value.textContent).toContain("38");
  });

  it("renders the status badge", () => {
    render(<HeroToday hero={BASE_HERO} asOf="lun 04 may · 11:42" />);
    const badge = screen.getByTestId("hero-status");
    expect(badge.textContent).toBe("En ritmo previsto");
  });

  it("renders the 'AHORA' marker when data exists", () => {
    render(<HeroToday hero={BASE_HERO} asOf="lun 04 may · 11:42" />);
    const marker = screen.getByTestId("ahora-marker");
    expect(marker).toBeInTheDocument();
  });

  it("renders the hero container", () => {
    render(<HeroToday hero={BASE_HERO} asOf="lun 04 may · 11:42" />);
    expect(screen.getByTestId("hero-today")).toBeInTheDocument();
  });

  it("renders the dynamic comparison legend label", () => {
    const hero = { ...BASE_HERO, comparisonLabel: "Sábado anterior" };
    render(<HeroToday hero={hero} asOf="sáb 03 may · 11:42" />);
    expect(screen.getByText("Sábado anterior")).toBeInTheDocument();
  });

  describe("pre-9am state (no hourly data)", () => {
    const preOpenHero: HomeViewModel["hero"] = {
      ...BASE_HERO,
      todayValue: 0,
      hourly: new Array(24).fill(null) as null[],
    };

    it("shows '0 €' for pre-open state", () => {
      render(<HeroToday hero={preOpenHero} asOf="07:30" />);
      const value = screen.getByTestId("hero-value");
      expect(value.textContent).toContain("0");
    });

    it("shows 'Sin actividad' status badge", () => {
      render(<HeroToday hero={preOpenHero} asOf="07:30" />);
      const badge = screen.getByTestId("hero-status");
      expect(badge.textContent).toBe("Sin actividad");
    });

    it("does not render the AHORA marker", () => {
      render(<HeroToday hero={preOpenHero} asOf="07:30" />);
      expect(screen.queryByTestId("ahora-marker")).not.toBeInTheDocument();
    });
  });

  describe("same-hour-cutoff caption", () => {
    it("does NOT show '(hasta las HH:00)' when cutoff is null", () => {
      render(<HeroToday hero={BASE_HERO} asOf="11:42" />);
      expect(screen.queryByText(/hasta las/)).not.toBeInTheDocument();
    });

    it("shows '(hasta las HH:00)' on both delta cells when cutoff is set", () => {
      const hero: HomeViewModel["hero"] = {
        ...BASE_HERO,
        comparisonCutoffHour: 14,
        yesterdayCutoff: 22000,
        lastYearCutoff: 28000,
      };
      render(<HeroToday hero={hero} asOf="14:30" />);
      const captions = screen.getAllByText(/hasta las 14:00/);
      // Two captions: VS AYER and VS AÑO PASADO.
      expect(captions.length).toBe(2);
    });

    it("shows the cutoff value as the primary supporting line and the full day in light grey", () => {
      const hero: HomeViewModel["hero"] = {
        ...BASE_HERO,
        comparisonCutoffHour: 14,
        yesterdayCutoff: 22000,
        lastYearCutoff: 28000,
      };
      render(<HeroToday hero={hero} asOf="14:30" />);
      // Cutoff values surface first; full-day shown as "día completo: …".
      expect(screen.getAllByText(/día completo/).length).toBe(2);
    });
  });

  describe("status badges", () => {
    it("shows 'Por debajo del previsto' for below status", () => {
      const hero = { ...BASE_HERO, status: "below" as const };
      render(<HeroToday hero={hero} asOf="11:42" />);
      expect(screen.getByTestId("hero-status").textContent).toBe("Por debajo del previsto");
    });

    it("shows 'Por encima del previsto' for above status", () => {
      const hero = { ...BASE_HERO, status: "above" as const };
      render(<HeroToday hero={hero} asOf="11:42" />);
      expect(screen.getByTestId("hero-status").textContent).toBe("Por encima del previsto");
    });
  });
});
