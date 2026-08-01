/**
 * Normalize legacy review JSON (v1) into review_schema_version 2 for UI/API.
 */

import {
  REVIEW_DASHBOARD_KEYS,
  ReviewContentV2Schema,
  type ReviewContent,
  type ReviewDashboardKey,
} from "./review-schema";
import { defaultDueDateThursdayAfter } from "./review-dates";

function slugKey(text: string, index: number): string {
  const base = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return base || `accion_${index + 1}`;
}

function titleToDomainKey(title: string): ReviewDashboardKey {
  const t = title.toLowerCase();
  if (t.includes("mayorista")) return "canal_mayorista";
  if (t.includes("stock") || t.includes("logística") || t.includes("logistica")) return "stock";
  if (t.includes("compra")) return "compras";
  return "ventas_retail";
}

function defaultEvidenceForDomain(key: ReviewDashboardKey): string[] {
  switch (key) {
    case "ventas_retail":
      return ["ventas_semana_cerrada", "ventas_semana_previa"];
    case "canal_mayorista":
      return ["facturacion_mayorista_semana_cerrada", "top3_clientes_mayorista_semana_cerrada"];
    case "stock":
      return ["stock_total_unidades", "articulos_stock_critico"];
    case "compras":
      return ["compras_semana_cerrada", "compras_semana_previa"];
    default:
      return ["ventas_semana_cerrada"];
  }
}

export function normalizeReviewContent(raw: unknown, weekStartIso: string): ReviewContent {
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { review_schema_version?: unknown }).review_schema_version === 2
  ) {
    const parsed = ReviewContentV2Schema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }
    const stripped: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    delete stripped.review_schema_version;
    return normalizeReviewContent(stripped, weekStartIso);
  }

  const obj = raw as Record<string, unknown>;
  const execRaw = obj.executive_summary;
  const executive_summary =
    typeof execRaw === "string"
      ? execRaw
          .split("\n")
          .map((l) => l.trim().replace(/^[•\-–*]\s*/, ""))
          .filter(Boolean)
          .slice(0, 5)
      : Array.isArray(execRaw)
        ? (execRaw as string[]).filter((s) => typeof s === "string" && s.trim()).slice(0, 5)
        : [];

  while (executive_summary.length < 3) {
    executive_summary.push("Punto pendiente de detalle (revisión heredada sin bullets suficientes).");
  }

  const sectionsIn = Array.isArray(obj.sections) ? (obj.sections as { title?: string; content?: string }[]) : [];
  const sections = REVIEW_DASHBOARD_KEYS.map((key, idx) => {
    const match =
      sectionsIn.find((s) => titleToDomainKey(String(s.title ?? "")) === key) ?? sectionsIn[idx] ?? {
        title: key,
        content: "",
      };
    const title = String(match.title ?? key);
    const narrative = String(match.content ?? "").trim() || "Sin narrativa (revisión heredada).";
    return {
      key,
      title,
      narrative,
      kpis: [narrative.split("\n\n")[0]?.slice(0, 200) ?? narrative.slice(0, 200)],
      evidence_queries: defaultEvidenceForDomain(key),
      dashboard_key: key,
    };
  });

  const actionsIn = Array.isArray(obj.action_items) ? (obj.action_items as unknown[]) : [];
  const action_items = actionsIn.map((item, i) => {
    const text = typeof item === "string" ? item : JSON.stringify(item);
    const priorityMatch = text.match(/(alta|media|baja)/i);
    const priority = (priorityMatch?.[1]?.toLowerCase() ?? "media") as "alta" | "media" | "baja";
    const domain = titleToDomainKey(text);
    return {
      action_key: slugKey(text, i),
      priority,
      owner_role: "Dirección",
      owner_name: "",
      due_date: defaultDueDateThursdayAfter(weekStartIso),
      action: text,
      expected_impact: "Por concretar (acción migrada desde revisión v1).",
      evidence_queries: defaultEvidenceForDomain(domain).slice(0, 2),
      dashboard_key: domain,
    };
  });

  while (action_items.length < 3) {
    action_items.push({
      action_key: `accion_placeholder_${action_items.length + 1}`,
      priority: "baja",
      owner_role: "Dirección",
      owner_name: "",
      due_date: defaultDueDateThursdayAfter(weekStartIso),
      action: "Completar plan de acción (revisión heredada incompleta).",
      expected_impact: "Estabilizar seguimiento semanal.",
      evidence_queries: defaultEvidenceForDomain("ventas_retail").slice(0, 1),
      dashboard_key: "ventas_retail",
    });
  }

  return {
    review_schema_version: 2,
    executive_summary,
    sections,
    action_items,
    data_quality_notes: ["Revisión importada desde formato v1: evidencia y enlaces son aproximados."],
    generated_at: typeof obj.generated_at === "string" ? obj.generated_at : new Date().toISOString(),
    quality_status: "degraded",
  };
}
