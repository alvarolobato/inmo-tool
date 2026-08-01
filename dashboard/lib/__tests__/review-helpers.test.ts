import { describe, it, expect } from "vitest";
import { isCalendarIsoDate } from "@/lib/review-schema";
import { defaultDueDateThursdayAfter } from "@/lib/review-dates";
import {
  addDaysIso,
  buildDashboardReviewHref,
  comparisonWindowForClosedWeek,
  reviewDashboardDisplayName,
} from "@/lib/review-dashboard-links";
import { enrichReviewContent, computeQueryFailureRate } from "@/lib/review-evidence";
import { normalizeReviewContent } from "@/lib/review-normalize";
import type { ReviewContent } from "@/lib/review-schema";
import type { ReviewQueryResult } from "@/lib/review-queries";

describe("review-schema calendar dates", () => {
  it("isCalendarIsoDate rejects impossible dates", () => {
    expect(isCalendarIsoDate("2026-04-10")).toBe(true);
    expect(isCalendarIsoDate("2026-02-30")).toBe(false);
    expect(isCalendarIsoDate("2026-13-01")).toBe(false);
  });
});

describe("review-dates", () => {
  it("defaultDueDateThursdayAfter returns ISO Thursday in week after closed week", () => {
    expect(defaultDueDateThursdayAfter("2026-04-06")).toBe("2026-04-16");
  });
});

describe("review-dashboard-links", () => {
  it("addDaysIso shifts calendar dates", () => {
    expect(addDaysIso("2026-04-06", 6)).toBe("2026-04-12");
    expect(addDaysIso("2026-04-06", -7)).toBe("2026-03-30");
  });

  it("comparisonWindowForClosedWeek returns previous ISO week", () => {
    expect(comparisonWindowForClosedWeek("2026-04-06", "2026-04-12")).toEqual({
      compFrom: "2026-03-30",
      compTo: "2026-04-05",
    });
  });

  it("buildDashboardReviewHref includes date query params", () => {
    const href = buildDashboardReviewHref(42, "2026-04-06", "2026-04-12");
    expect(href).toContain("/dashboard/42?");
    expect(href).toContain("curr_from=2026-04-06");
    expect(href).toContain("curr_to=2026-04-12");
    expect(href).toContain("comp_from=2026-03-30");
    expect(href).toContain("comp_to=2026-04-05");
  });

  it("reviewDashboardDisplayName labels dashboards", () => {
    expect(reviewDashboardDisplayName("ventas_retail")).toContain("Ventas retail");
    expect(reviewDashboardDisplayName("compras")).toContain("Compras");
  });
});

describe("review-normalize", () => {
  it("rebuilds corrupt v2 JSON via the v1 migration path", () => {
    const corrupt = {
      review_schema_version: 2,
      executive_summary: "not-array",
      sections: [],
      action_items: [],
      generated_at: "2026-01-01T00:00:00.000Z",
    };
    const out = normalizeReviewContent(corrupt, "2026-04-06");
    expect(out.review_schema_version).toBe(2);
    expect(out.executive_summary.length).toBeGreaterThanOrEqual(3);
    expect(out.quality_status).toBe("degraded");
  });

  it("passes through v2 content unchanged", () => {
    const v2: ReviewContent = {
      review_schema_version: 2,
      executive_summary: ["a", "b", "c"],
      sections: [
        {
          key: "ventas_retail",
          title: "Ventas Retail",
          narrative: "n1",
          kpis: ["k"],
          evidence_queries: ["ventas_semana_cerrada"],
          dashboard_key: "ventas_retail",
        },
        {
          key: "canal_mayorista",
          title: "Canal Mayorista",
          narrative: "n2",
          kpis: ["k"],
          evidence_queries: ["facturacion_mayorista_semana_cerrada"],
          dashboard_key: "canal_mayorista",
        },
        {
          key: "stock",
          title: "Stock",
          narrative: "n3",
          kpis: ["k"],
          evidence_queries: ["stock_total_unidades"],
          dashboard_key: "stock",
        },
        {
          key: "compras",
          title: "Compras",
          narrative: "n4",
          kpis: ["k"],
          evidence_queries: ["compras_semana_cerrada"],
          dashboard_key: "compras",
        },
      ],
      action_items: [
        {
          action_key: "a1",
          priority: "alta",
          owner_role: "X",
          owner_name: "",
          due_date: "2026-04-10",
          action: "Do",
          expected_impact: "Good",
          evidence_queries: ["ventas_semana_cerrada"],
          dashboard_key: "ventas_retail",
        },
        {
          action_key: "a2",
          priority: "media",
          owner_role: "X",
          owner_name: "",
          due_date: "2026-04-11",
          action: "Do2",
          expected_impact: "Good",
          evidence_queries: ["ventas_semana_previa"],
          dashboard_key: "ventas_retail",
        },
        {
          action_key: "a3",
          priority: "baja",
          owner_role: "X",
          owner_name: "",
          due_date: "2026-04-12",
          action: "Do3",
          expected_impact: "Good",
          evidence_queries: ["compras_semana_cerrada"],
          dashboard_key: "compras",
        },
      ],
      data_quality_notes: [],
      generated_at: "2026-04-05T10:00:00.000Z",
      quality_status: "ok",
    };
    expect(normalizeReviewContent(v2, "2026-04-06")).toStrictEqual(v2);
  });

  it("normalizes legacy v1-shaped payload", () => {
    const raw = {
      executive_summary: "• Primera\n• Segunda",
      sections: [
        { title: "Ventas Retail", content: "Texto retail." },
        { title: "Canal Mayorista", content: "Texto mayorista." },
        { title: "Stock y Logística", content: "Texto stock." },
        { title: "Compras", content: "Texto compras." },
      ],
      action_items: ["Prioridad alta: revisar inventario"],
      generated_at: "2026-01-01T00:00:00.000Z",
    };
    const out = normalizeReviewContent(raw, "2026-04-06");
    expect(out.review_schema_version).toBe(2);
    expect(out.executive_summary[0]).toBe("Primera");
    expect(out.executive_summary[1]).toBe("Segunda");
    expect(out.executive_summary[2]).toContain("pendiente");
    expect(out.sections).toHaveLength(4);
    expect(out.action_items.length).toBeGreaterThanOrEqual(3);
    expect(out.quality_status).toBe("degraded");
  });
});

describe("review-evidence", () => {
  const minimalContent: ReviewContent = {
    review_schema_version: 2,
    executive_summary: ["a", "b", "c"],
    sections: [
      {
        key: "ventas_retail",
        title: "Ventas Retail",
        narrative: "n",
        kpis: ["k"],
        evidence_queries: ["ventas_semana_cerrada"],
        dashboard_key: "ventas_retail",
      },
      {
        key: "canal_mayorista",
        title: "Canal Mayorista",
        narrative: "n",
        kpis: ["k"],
        evidence_queries: ["facturacion_mayorista_semana_cerrada"],
        dashboard_key: "canal_mayorista",
      },
      {
        key: "stock",
        title: "Stock",
        narrative: "n",
        kpis: ["k"],
        evidence_queries: ["stock_total_unidades"],
        dashboard_key: "stock",
      },
      {
        key: "compras",
        title: "Compras",
        narrative: "n",
        kpis: ["k"],
        evidence_queries: ["compras_semana_cerrada"],
        dashboard_key: "compras",
      },
    ],
    action_items: [
      {
        action_key: "x",
        priority: "alta",
        owner_role: "R",
        owner_name: "",
        due_date: "2026-04-10",
        action: "act",
        expected_impact: "imp",
        evidence_queries: ["ventas_semana_cerrada"],
        dashboard_key: "ventas_retail",
      },
      {
        action_key: "y",
        priority: "media",
        owner_role: "R",
        owner_name: "",
        due_date: "2026-04-11",
        action: "act2",
        expected_impact: "imp",
        evidence_queries: ["ventas_semana_previa"],
        dashboard_key: "ventas_retail",
      },
      {
        action_key: "z",
        priority: "baja",
        owner_role: "R",
        owner_name: "",
        due_date: "2026-04-12",
        action: "act3",
        expected_impact: "imp",
        evidence_queries: ["compras_semana_cerrada"],
        dashboard_key: "compras",
      },
    ],
    data_quality_notes: [],
    generated_at: "2026-04-05T10:00:00.000Z",
    quality_status: "ok",
  };

  it("computeQueryFailureRate counts only errors", () => {
    const rows: ReviewQueryResult[] = [
      {
        query: { name: "ventas_semana_cerrada", sql: "s", domain: "ventas_retail" },
        result: { columns: ["a"], rows: [[1]] },
      },
      {
        query: { name: "ventas_semana_previa", sql: "s", domain: "ventas_retail" },
        error: "boom",
      },
    ];
    expect(computeQueryFailureRate([])).toBe(0);
    expect(computeQueryFailureRate(rows)).toBe(0.5);
  });

  it("enrichReviewContent attaches evidence and dashboard URLs", () => {
    const qr: ReviewQueryResult[] = [
      {
        query: { name: "ventas_semana_cerrada", sql: "SELECT 1", domain: "ventas_retail" },
        result: { columns: ["x"], rows: [[42]] },
      },
    ];
    const urls = { ventas_retail: "/dashboard/1?x=1" };
    const out = enrichReviewContent(minimalContent, qr, urls);
    expect(out.sections[0].dashboard_url).toBe("/dashboard/1?x=1");
    expect(out.sections[0].evidence?.[0]?.query_name).toBe("ventas_semana_cerrada");
    expect(out.sections[0].evidence?.[0]?.snapshot).toContain("42");
  });

  it("enrichReviewContent marks unknown query names", () => {
    const out = enrichReviewContent(minimalContent, [], {});
    expect(out.sections[0].evidence?.[0]?.error).toBe("nombre de consulta no reconocido");
  });
});
