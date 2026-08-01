"use client";

/**
 * ReviewDisplay — weekly business review v2 (evidence + deep links).
 */

import { useState, useRef, useEffect } from "react";
import type { ReviewContent, ReviewSectionV2, ReviewActionItemV2 } from "@/lib/review-schema";
import type { ReviewActionRow } from "@/lib/review-actions-db";

export interface ReviewDisplayProps {
  review: ReviewContent & { id?: number | null; week_start?: string };
  actions?: ReviewActionRow[];
  /**
   * Freeform Spanish message from the model describing the review conclusions.
   * When present, shown as a "Resumen del modelo" intro paragraph above the
   * executive summary card.
   */
  modelMessage?: string;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-ES", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function priorityBadgeClass(priority: "alta" | "media" | "baja"): string {
  switch (priority) {
    case "alta":
      return "bg-red-500/20 text-red-400 border border-red-500/30";
    case "media":
      return "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30";
    case "baja":
      return "bg-green-500/20 text-green-400 border border-green-500/30";
    default:
      return "bg-blue-500/20 text-blue-400 border border-blue-500/30";
  }
}

function buildCopyText(review: ReviewContent & { week_start?: string }): string {
  const lines: string[] = [];
  if (review.week_start) {
    lines.push(`REVISIÓN SEMANAL — Semana del ${review.week_start}`);
  } else {
    lines.push("REVISIÓN SEMANAL");
  }
  lines.push("");
  lines.push("RESUMEN EJECUTIVO");
  for (const b of review.executive_summary) lines.push(`• ${b}`);
  lines.push("");
  for (const section of review.sections) {
    lines.push(section.title.toUpperCase());
    lines.push(section.narrative);
    lines.push("");
  }
  lines.push("ACCIONES RECOMENDADAS");
  review.action_items.forEach((item, i) => {
    lines.push(`${i + 1}. [${item.priority}] ${item.action}`);
  });
  lines.push("");
  if (review.generated_at) {
    lines.push(`Generado el ${formatTimestamp(review.generated_at)}`);
  }
  return lines.join("\n");
}

function SectionCard({ section }: { section: ReviewSectionV2 }) {
  const paragraphs = section.narrative.split(/\n\n+/);
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-1)",
        padding: 20,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)", margin: 0 }}>
          {section.title}
        </h3>
        {section.dashboard_url && (
          <a
            href={section.dashboard_url}
            style={{ fontSize: 12, fontWeight: 500, color: "var(--accent)", textDecoration: "none" }}
            data-testid={`section-dashboard-${section.key}`}
          >
            Abrir dashboard explicativo
          </a>
        )}
      </div>
      {section.kpis.length > 0 && (
        <ul style={{ marginBottom: 12, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 2 }}>
          {section.kpis.map((k, i) => (
            <li key={i} style={{ fontSize: 12, color: "var(--fg-subtle)" }}>{k}</li>
          ))}
        </ul>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {paragraphs.map((para, i) => (
          <p
            key={i}
            style={{ fontSize: 13, color: "var(--fg-muted)", margin: 0, whiteSpace: "pre-line", lineHeight: 1.6 }}
          >
            {para.trim()}
          </p>
        ))}
      </div>
      {section.evidence && section.evidence.length > 0 && (
        <div
          style={{
            marginTop: 16,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-2)",
            padding: 12,
          }}
        >
          <p style={{ fontSize: 11, fontWeight: 600, color: "var(--fg)", margin: "0 0 8px" }}>
            Evidencia
          </p>
          <ul style={{ display: "flex", flexDirection: "column", gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
            {section.evidence.map((e, i) => (
              <li key={i} style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                <span style={{ fontFamily: "var(--font-jetbrains, monospace)", color: "var(--accent)" }}>{e.query_name}</span>
                {e.error && <span style={{ color: "var(--down)", marginLeft: 8 }}>({e.error})</span>}
                <pre style={{ marginTop: 4, whiteSpace: "pre-wrap", fontFamily: "var(--font-jetbrains, monospace)", fontSize: 11, lineHeight: 1.4, opacity: 0.9 }}>
                  {e.snapshot}
                </pre>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ActionCard({ item }: { item: ReviewActionItemV2 }) {
  return (
    <li
      style={{
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-1)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${priorityBadgeClass(item.priority)}`}
          >
            {item.priority}
          </span>
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>
            {item.action}
          </span>
        </div>
        {item.dashboard_url && (
          <a
            href={item.dashboard_url}
            style={{ fontSize: 12, fontWeight: 500, color: "var(--accent)", textDecoration: "none" }}
            data-testid={`action-dashboard-${item.action_key}`}
          >
            Abrir dashboard
          </a>
        )}
      </div>
      <p style={{ fontSize: 12, color: "var(--fg-subtle)", margin: 0 }}>
        Responsable sugerido: {item.owner_role}
        {item.owner_name ? ` — ${item.owner_name}` : ""} · Objetivo: {item.due_date}
      </p>
      <p style={{ fontSize: 12, color: "var(--fg-muted)", margin: 0 }}>
        <span style={{ fontWeight: 600 }}>Impacto esperado:</span> {item.expected_impact}
      </p>
      {item.evidence && item.evidence.length > 0 && (
        <div style={{ paddingTop: 8, borderTop: "1px solid var(--border)" }}>
          <p style={{ fontSize: 11, fontWeight: 600, margin: "0 0 4px" }}>Evidencia</p>
          <ul style={{ display: "flex", flexDirection: "column", gap: 4, listStyle: "none", padding: 0, margin: 0 }}>
            {item.evidence.map((e, i) => (
              <li key={i} style={{ fontSize: 11, fontFamily: "var(--font-jetbrains, monospace)", color: "var(--fg-muted)" }}>
                {e.query_name}
                {e.error ? ` — ${e.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export function ReviewDisplay({ review, modelMessage }: ReviewDisplayProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handlePrint = () => {
    window.print();
  };

  const handleCopy = async () => {
    try {
      const text = buildCopyText(review);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 2000);
    } catch {
      // Clipboard not available
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <div className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle flex flex-wrap gap-2">
          {review.generated_at && <span>Generado el {formatTimestamp(review.generated_at)}</span>}
          {review.week_start && (
            <span className="text-tremor-content dark:text-dark-tremor-content">
              — Semana del {review.week_start}
            </span>
          )}
          {review.quality_status === "degraded" && (
            <span
              className="rounded px-2 py-0.5 bg-amber-100 text-amber-900 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-100 dark:border-amber-500/30"
              data-testid="quality-degraded"
            >
              Calidad de datos degradada
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copiar revisión"
            data-testid="copy-button"
            className="rounded-md px-3 py-1.5 text-sm font-medium border border-tremor-border dark:border-dark-tremor-border text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle transition-colors"
          >
            {copied ? "Copiado" : "Copiar"}
          </button>
          <button
            type="button"
            onClick={handlePrint}
            aria-label="Imprimir revisión"
            data-testid="print-button"
            className="rounded-md px-3 py-1.5 text-sm font-medium border border-tremor-border dark:border-dark-tremor-border text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle transition-colors"
          >
            Imprimir
          </button>
        </div>
      </div>

      {modelMessage && modelMessage.trim() && (
        <div
          data-testid="model-message"
          style={{
            borderRadius: 8,
            border: "1px solid rgba(var(--accent-rgb,99,102,241),0.2)",
            background: "rgba(var(--accent-rgb,99,102,241),0.06)",
            padding: "14px 16px",
          }}
        >
          <p style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)", margin: "0 0 6px" }}>
            Resumen del modelo
          </p>
          <p style={{ fontSize: 13, color: "var(--fg-muted)", margin: 0, lineHeight: 1.6 }}>
            {modelMessage.trim()}
          </p>
        </div>
      )}

      {review.data_quality_notes.length > 0 && (
        <div
          style={{
            borderRadius: 6,
            borderLeft: "3px solid var(--warn)",
            background: "var(--warn-bg, rgba(245,158,11,0.08))",
            padding: 16,
          }}
          data-testid="data-quality-notes"
        >
          <p style={{ fontWeight: 600, fontSize: 12, color: "var(--warn)", margin: "0 0 8px" }}>
            Notas de calidad de datos
          </p>
          <ul style={{ listStyle: "disc", paddingLeft: 16, display: "flex", flexDirection: "column", gap: 4 }}>
            {review.data_quality_notes.map((n, i) => (
              <li key={i} style={{ fontSize: 12, color: "var(--fg-muted)" }}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div
        data-testid="executive-summary"
        style={{
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--bg-1)",
          padding: 20,
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", margin: "0 0 12px" }}>
          Resumen Ejecutivo
        </h2>
        <ul style={{ display: "flex", flexDirection: "column", gap: 6, listStyle: "none", padding: 0, margin: 0 }} aria-label="Puntos clave de la semana">
          {review.executive_summary.map((line, i) => (
            <li
              key={i}
              style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "var(--fg-muted)" }}
            >
              <span style={{ marginTop: 2, color: "var(--accent)", flexShrink: 0 }} aria-hidden="true">
                •
              </span>
              {line}
            </li>
          ))}
        </ul>
      </div>

      {review.sections.map((section, i) => (
        <SectionCard key={section.key ?? i} section={section} />
      ))}

      <div
        data-testid="action-items"
        style={{
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--bg-1)",
          padding: 20,
        }}
      >
        <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", margin: "0 0 12px" }}>
          Acciones Recomendadas
        </h3>
        <ul style={{ display: "flex", flexDirection: "column", gap: 12, listStyle: "none", padding: 0, margin: 0 }} aria-label="Acciones recomendadas">
          {review.action_items.map((item) => (
            <ActionCard key={item.action_key} item={item} />
          ))}
        </ul>
      </div>

      <p className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle text-right">
        {review.generated_at && <span>Generado el {formatTimestamp(review.generated_at)}</span>}
      </p>
    </div>
  );
}

export default ReviewDisplay;
