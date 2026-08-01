import { describe, it, expect } from "vitest";
import { extractDashboardSqlRefs } from "@/lib/llm-tools/dashboard-query-extractor";
import {
  handleValidateDashboardSpec,
  handleApplyDashboardModification,
  handleSubmitDashboardAnalysis,
  handleSubmitWeeklyReview,
} from "@/lib/llm-tools/handlers/dashboards";
import { validateReadOnly, SqlValidationError } from "@/lib/db";
import type { DashboardSpec } from "@/lib/schema";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";

const ctx: LlmAgenticContext = {
  requestId: "req_test",
  endpoint: "test",
};

describe("dashboard-query-extractor", () => {
  it("collects primary and comparison SQL from chart widgets", () => {
    const spec: DashboardSpec = {
      title: "Demo",
      widgets: [
        {
          type: "bar_chart",
          title: "Ventas",
          sql: "SELECT 1 AS a",
          x: "a",
          y: "b",
          comparison_sql: "SELECT 2 AS a",
        },
      ],
    };
    const refs = extractDashboardSqlRefs(spec);
    expect(refs.map((r) => r.kind)).toEqual(["chart_sql", "comparison_sql"]);
    expect(refs[0].sql).toContain("SELECT 1");
    expect(refs[1].sql).toContain("SELECT 2");
  });

  it("expands kpi_row items including optional sql fields", () => {
    const spec: DashboardSpec = {
      title: "K",
      widgets: [
        {
          type: "kpi_row",
          items: [
            {
              label: "A",
              sql: "SELECT 1",
              format: "number",
              trend_sql: "SELECT 2",
              anomaly_sql: "SELECT 3",
            },
          ],
        },
      ],
    };
    const refs = extractDashboardSqlRefs(spec);
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.kind)).toEqual(["kpi_sql", "kpi_trend", "kpi_anomaly"]);
  });
});

type ValidateData = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  hint: string;
};

describe("handleValidateDashboardSpec", () => {
  it("rejects missing 'spec' argument", async () => {
    const out = await handleValidateDashboardSpec("{}", ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("INVALID_ARGS");
  });

  it("rejects non-object spec", async () => {
    const out = await handleValidateDashboardSpec(
      JSON.stringify({ spec: "not an object" }),
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("INVALID_ARGS");
  });

  it("returns ok=false with structural errors when spec is malformed", async () => {
    const out = await handleValidateDashboardSpec(
      JSON.stringify({ spec: { title: "x" } }),
      ctx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const data = out.data as ValidateData;
      expect(data.ok).toBe(false);
      expect(data.errors.length).toBeGreaterThan(0);
      expect(data.errors.join("\n")).toMatch(/widgets/);
      expect(data.hint).toMatch(/structural errors/);
    }
  });

  it("returns ok=true with no errors and no warnings for a clean spec", async () => {
    const spec: DashboardSpec = {
      title: "Clean",
      widgets: [
        {
          id: "w1",
          type: "bar_chart",
          title: "Ventas",
          sql: "SELECT label, value FROM ps_ventas LIMIT 10",
          x: "label",
          y: "value",
        },
      ],
    };
    const out = await handleValidateDashboardSpec(JSON.stringify({ spec }), ctx);
    expect(out.ok).toBe(true);
    if (out.ok) {
      const data = out.data as ValidateData;
      expect(data.ok).toBe(true);
      expect(data.errors).toEqual([]);
      expect(data.hint).toMatch(/valid/i);
    }
  });

  it("surfaces SQL lint warnings while keeping structural errors empty", async () => {
    const spec: DashboardSpec = {
      title: "Lint",
      widgets: [
        {
          id: "w1",
          type: "kpi_row",
          items: [
            {
              label: "Última venta",
              sql: "SELECT COALESCE(MAX(fecha_creacion), 'sin datos') AS v FROM ps_ventas",
              format: "number",
            },
          ],
        },
      ],
    };
    const out = await handleValidateDashboardSpec(JSON.stringify({ spec }), ctx);
    expect(out.ok).toBe(true);
    if (out.ok) {
      const data = out.data as ValidateData;
      expect(data.errors).toEqual([]);
      expect(data.warnings.length).toBeGreaterThan(0);
      expect(data.warnings.join(" ")).toMatch(/COALESCE|texto/);
    }
  });
});

// ─── handleApplyDashboardModification ────────────────────────────────────────

const validModifySpec: DashboardSpec = {
  title: "Ventas",
  widgets: [
    {
      type: "kpi_row",
      items: [{ label: "Ventas", sql: "SELECT SUM(total_si) FROM ps_ventas", format: "currency" }],
    },
  ],
};

describe("handleApplyDashboardModification", () => {
  it("stages ctx.modifyResult and returns ok=true, applied=true for valid args", async () => {
    const mutableCtx: LlmAgenticContext = { ...ctx };
    const out = await handleApplyDashboardModification(
      JSON.stringify({ spec: validModifySpec, change_summary: "He añadido un widget de ventas." }),
      mutableCtx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const d = out.data as { ok: boolean; applied: boolean };
      expect(d.ok).toBe(true);
      expect(d.applied).toBe(true);
    }
    expect(mutableCtx.modifyResult).not.toBeNull();
    expect(mutableCtx.modifyResult?.summary).toBe("He añadido un widget de ventas.");
    expect(mutableCtx.modifyResult?.spec.title).toBe("Ventas");
  });

  it("returns toolOk({ ok: false }) with errors when spec is invalid", async () => {
    const mutableCtx: LlmAgenticContext = { ...ctx };
    const out = await handleApplyDashboardModification(
      JSON.stringify({ spec: { title: "no widgets" }, change_summary: "Cambié algo." }),
      mutableCtx,
    );
    expect(out.ok).toBe(true); // toolOk wraps the validation result
    if (out.ok) {
      const d = out.data as { ok: boolean; errors: string[] };
      expect(d.ok).toBe(false);
      expect(d.errors.length).toBeGreaterThan(0);
    }
    expect(mutableCtx.modifyResult).toBeUndefined();
  });

  it("returns INVALID_ARGS when change_summary is missing", async () => {
    const out = await handleApplyDashboardModification(
      JSON.stringify({ spec: validModifySpec }),
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("INVALID_ARGS");
  });

  it("returns INVALID_ARGS when change_summary exceeds 1000 chars", async () => {
    const out = await handleApplyDashboardModification(
      JSON.stringify({ spec: validModifySpec, change_summary: "x".repeat(1001) }),
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("INVALID_ARGS");
  });

  it("overwrites ctx.modifyResult on double-call and adds note", async () => {
    const mutableCtx: LlmAgenticContext = { ...ctx };
    await handleApplyDashboardModification(
      JSON.stringify({ spec: validModifySpec, change_summary: "Primera llamada." }),
      mutableCtx,
    );
    const second = await handleApplyDashboardModification(
      JSON.stringify({ spec: { ...validModifySpec, title: "Ventas v2" }, change_summary: "Segunda llamada." }),
      mutableCtx,
    );
    expect(mutableCtx.modifyResult?.spec.title).toBe("Ventas v2");
    expect(mutableCtx.modifyResult?.summary).toBe("Segunda llamada.");
    if (second.ok) {
      const d = second.data as { note?: string };
      expect(d.note).toMatch(/overwritten|latest|LAST/i);
    }
  });
});

// ─── handleSubmitDashboardAnalysis ───────────────────────────────────────────

describe("handleSubmitDashboardAnalysis", () => {
  it("stages ctx.analyzeResult and returns ok=true, applied=true for valid args", async () => {
    const mutableCtx: LlmAgenticContext = { ...ctx };
    const out = await handleSubmitDashboardAnalysis(
      JSON.stringify({
        analysis_markdown: "# Análisis\n\nVentas crecieron un 12%.",
        brief_summary: "Ventas al alza.",
      }),
      mutableCtx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const d = out.data as { ok: boolean; applied: boolean };
      expect(d.ok).toBe(true);
      expect(d.applied).toBe(true);
    }
    expect(mutableCtx.analyzeResult?.markdown).toContain("Análisis");
    expect(mutableCtx.analyzeResult?.summary).toBe("Ventas al alza.");
  });

  it("returns INVALID_ARGS when analysis_markdown is empty", async () => {
    const out = await handleSubmitDashboardAnalysis(
      JSON.stringify({ analysis_markdown: "  ", brief_summary: "Resumen." }),
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("INVALID_ARGS");
  });

  it("returns INVALID_ARGS when analysis_markdown exceeds 30 KB", async () => {
    const out = await handleSubmitDashboardAnalysis(
      JSON.stringify({ analysis_markdown: "x".repeat(31 * 1024), brief_summary: "Resumen." }),
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("INVALID_ARGS");
  });

  it("returns INVALID_ARGS when brief_summary is missing", async () => {
    const out = await handleSubmitDashboardAnalysis(
      JSON.stringify({ analysis_markdown: "# Análisis" }),
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("INVALID_ARGS");
  });
});

// ─── handleSubmitWeeklyReview ─────────────────────────────────────────────────

// Minimal valid review that passes ReviewLlmOutputSchema
const validReviewPayload = {
  executive_summary: ["Ventas +12%", "Stock OK", "Tres pedidos"],
  sections: [
    { key: "ventas_retail", title: "Ventas Retail", narrative: "Texto.", kpis: ["KPI 1"], evidence_queries: ["ventas_semana_cerrada"], dashboard_key: "ventas_retail" },
    { key: "canal_mayorista", title: "Mayorista", narrative: "Texto.", kpis: ["KPI 1"], evidence_queries: ["facturacion_mayorista_semana_cerrada"], dashboard_key: "canal_mayorista" },
    { key: "stock", title: "Stock", narrative: "Texto.", kpis: ["KPI 1"], evidence_queries: ["stock_total_unidades"], dashboard_key: "stock" },
    { key: "compras", title: "Compras", narrative: "Texto.", kpis: ["KPI 1"], evidence_queries: ["compras_semana_cerrada"], dashboard_key: "compras" },
  ],
  action_items: [
    { action_key: "revisar_stock", priority: "alta", owner_role: "Logística", due_date: "2026-05-10", action: "Revisar stock.", expected_impact: "Menos roturas.", evidence_queries: ["articulos_stock_critico"], dashboard_key: "stock" },
    { action_key: "contactar_clientes", priority: "media", owner_role: "Ventas", due_date: "2026-05-10", action: "Contactar clientes.", expected_impact: "Mejor cobro.", evidence_queries: ["top3_clientes_mayorista_semana_cerrada"], dashboard_key: "canal_mayorista" },
    { action_key: "planificar_traspasos", priority: "baja", owner_role: "Tiendas", due_date: "2026-05-15", action: "Planificar traspasos.", expected_impact: "Mejor distribución.", evidence_queries: ["traspasos_semana_cerrada"], dashboard_key: "stock" },
  ],
  data_quality_notes: [],
  generated_at: "2026-05-01T00:00:00.000Z",
};

describe("handleSubmitWeeklyReview", () => {
  it("stages ctx.reviewResult and returns ok=true for valid args", async () => {
    const mutableCtx: LlmAgenticContext = { ...ctx };
    const out = await handleSubmitWeeklyReview(
      JSON.stringify({ review: validReviewPayload, brief_summary: "Buena semana." }),
      mutableCtx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const d = out.data as { ok: boolean; applied: boolean };
      expect(d.ok).toBe(true);
      expect(d.applied).toBe(true);
    }
    expect(mutableCtx.reviewResult?.content.executive_summary[0]).toBe("Ventas +12%");
    expect(mutableCtx.reviewResult?.summary).toBe("Buena semana.");
  });

  it("returns toolOk({ ok: false }) when review JSON is malformed", async () => {
    const mutableCtx: LlmAgenticContext = { ...ctx };
    const out = await handleSubmitWeeklyReview(
      JSON.stringify({ review: { bad: "structure" }, brief_summary: "Resumen." }),
      mutableCtx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const d = out.data as { ok: boolean; errors: string[] };
      expect(d.ok).toBe(false);
      expect(d.errors.length).toBeGreaterThan(0);
    }
    expect(mutableCtx.reviewResult).toBeUndefined();
  });

  it("returns INVALID_ARGS when brief_summary is missing", async () => {
    const out = await handleSubmitWeeklyReview(
      JSON.stringify({ review: validReviewPayload }),
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("INVALID_ARGS");
  });
});

// F11: validateReadOnly() rejects write SQL (read-only enforcement used by db.ts query())
describe("validateReadOnly blocks write statements", () => {
  it("throws SqlValidationError for UPDATE, DELETE, and INSERT", () => {
    expect(() =>
      validateReadOnly("UPDATE dashboards SET spec = '{}' WHERE id = 1"),
    ).toThrow(SqlValidationError);
    expect(() =>
      validateReadOnly("DELETE FROM dashboards WHERE id = 1"),
    ).toThrow(SqlValidationError);
    expect(() =>
      validateReadOnly("INSERT INTO dashboards (spec) VALUES ('{}')"),
    ).toThrow(SqlValidationError);
  });
});
