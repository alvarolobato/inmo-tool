import { describe, it, expect } from "vitest";
import { substituteDateParams } from "../date-params";
import { TEMPLATES } from "../templates";

describe("substituteDateParams on built-in templates", () => {
  const ranges = {
    curr: {
      from: new Date(Date.UTC(2026, 2, 1)),
      to: new Date(Date.UTC(2026, 2, 31)),
    },
  };

  it("Retail YoY KPI SQL stays valid PostgreSQL after token substitution", () => {
    const general = TEMPLATES.find((t) => t.slug === "general");
    const kpi = general!.spec.widgets.find((w) => w.id === "general-kpis");
    expect(kpi?.type).toBe("kpi_row");
    if (kpi?.type !== "kpi_row") {
      throw new Error("expected general-kpis to be kpi_row");
    }
    const raw = kpi.items.find((i) => i.label === "Retail YoY %")!.sql;
    const sql = substituteDateParams(raw, ranges);
    expect(sql).not.toMatch(/:curr_from|:curr_to/);
    expect(sql).toMatch(/'2026-03-01'::date\s*-\s*INTERVAL\s+'1 year'/);
    expect(sql).toMatch(/'2026-03-31'::date\s*-\s*INTERVAL\s+'1 year'/);
  });
});
