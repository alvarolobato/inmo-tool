"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type {
  WorklistPortalSummary,
  WorklistRow,
  WorklistStatus,
} from "@/lib/worklist";

/**
 * Guided capture worklist (issue #237) — "the page with all the places to
 * visit one by one" the owner asked for. It lists the URLs to open for each
 * capture portal (Aliseda today), tracks per-URL progress, and takes manually
 * pasted URLs (Aliseda has no usable sitemap — D-019 — so seeding is manual
 * paste for now).
 *
 * Lives under /etl so middleware.ts already admin-gates it (and its
 * `/api/etl/worklist` API), same as the connector-management page.
 *
 * The owner still does the actual browsing: "Abrir" opens the listing in a new
 * tab, they let the Angular page finish rendering, then click the extension
 * popup to capture. etl/capture.py flips the row to 'captured' when the capture
 * lands — this page never navigates or captures anything itself.
 */

const STATUS_LABEL: Record<WorklistStatus, string> = {
  pending: "Pendiente",
  captured: "Capturada",
  failed: "Fallida",
  skipped: "Omitida",
};

const STATUS_COLOR: Record<WorklistStatus, string> = {
  pending: "var(--fg-muted)",
  captured: "#16a34a",
  failed: "#dc2626",
  skipped: "var(--fg-muted)",
};

function StatusBadge({ status, id }: { status: WorklistStatus; id: number }) {
  return (
    <span
      data-testid={`worklist-status-${id}`}
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: STATUS_COLOR[status],
        whiteSpace: "nowrap",
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export default function CapturaWorklistPage() {
  const [rows, setRows] = useState<WorklistRow[]>([]);
  const [summaries, setSummaries] = useState<WorklistPortalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<string | null>(null);

  const fetchWorklist = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/etl/worklist");
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        setError(isApiErrorResponse(errBody) ? errBody : "Error al cargar la lista de captura");
        return;
      }
      const body = await res.json();
      setRows(body.rows ?? []);
      setSummaries(body.summaries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar la lista de captura");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorklist();
  }, [fetchWorklist]);

  const handleAdd = useCallback(async () => {
    setAdding(true);
    setAddResult(null);
    setError(null);
    try {
      const res = await fetch("/api/etl/worklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: pasteText }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(isApiErrorResponse(body) ? body : "No se pudieron añadir las URLs");
        return;
      }
      const invalidNote =
        body.invalid?.length > 0 ? `, ${body.invalid.length} inválida(s)` : "";
      setAddResult(
        `${body.added} añadida(s), ${body.duplicate} duplicada(s)${invalidNote}.`,
      );
      setPasteText("");
      await fetchWorklist();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron añadir las URLs");
    } finally {
      setAdding(false);
    }
  }, [pasteText, fetchWorklist]);

  const handleSetStatus = useCallback(
    async (id: number, status: WorklistStatus) => {
      setError(null);
      try {
        const res = await fetch(`/api/etl/worklist/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(isApiErrorResponse(body) ? body : "No se pudo actualizar la fila");
          return;
        }
        await fetchWorklist();
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo actualizar la fila");
      }
    },
    [fetchWorklist],
  );

  const grandTotal = useMemo(
    () => summaries.reduce((acc, s) => acc + s.total, 0),
    [summaries],
  );

  return (
    <main style={{ padding: 24, maxWidth: 980 }} data-testid="worklist-page">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--fg)", margin: 0 }}>
          Captura guiada
        </h1>
        <Link
          href="/etl/connectors"
          style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none", marginLeft: "auto" }}
        >
          Conectores →
        </Link>
      </div>

      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8 }}>
        Lista de anuncios a visitar uno por uno para portales que solo se pueden
        capturar con la extensión del navegador (Aliseda no publica los datos por
        HTTP — ver D-019). Pulsa <strong>Abrir</strong>, espera a que la página
        termine de cargar en tu navegador y captura con la extensión. La lista se
        marca sola como capturada cuando llega la captura.
      </p>

      {error && (
        <div style={{ marginTop: 16 }}>
          <ErrorDisplay error={error} />
        </div>
      )}

      {/* ── Progress summary ─────────────────────────────────────────── */}
      <section data-testid="worklist-summary" style={{ marginTop: 16 }}>
        {summaries.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--fg-muted)" }} data-testid="worklist-summary-empty">
            Aún no hay URLs en la lista.
          </p>
        ) : (
          summaries.map((s) => (
            <div
              key={s.source_portal}
              data-testid={`worklist-summary-${s.source_portal}`}
              style={{
                display: "flex",
                gap: 16,
                alignItems: "baseline",
                padding: "8px 12px",
                border: "1px solid var(--border)",
                borderRadius: 8,
                marginBottom: 8,
                fontSize: 13,
                flexWrap: "wrap",
              }}
            >
              <strong style={{ color: "var(--fg)", textTransform: "capitalize" }}>
                {s.source_portal}
              </strong>
              <span style={{ color: "var(--fg)" }}>
                {s.captured}/{s.total} capturadas
              </span>
              <span style={{ color: "var(--fg-muted)" }}>{s.pending} pendientes</span>
              {s.failed > 0 && <span style={{ color: "#dc2626" }}>{s.failed} fallidas</span>}
              {s.skipped > 0 && <span style={{ color: "var(--fg-muted)" }}>{s.skipped} omitidas</span>}
            </div>
          ))
        )}
      </section>

      {/* ── Manual URL entry ─────────────────────────────────────────── */}
      <section style={{ marginTop: 20 }}>
        <label
          htmlFor="worklist-paste"
          style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--fg)", marginBottom: 6 }}
        >
          Añadir URLs (una por línea)
        </label>
        <textarea
          id="worklist-paste"
          data-testid="worklist-paste"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder="https://www.alisedainmobiliaria.com/inmueble/ant..."
          rows={4}
          style={{
            width: "100%",
            fontSize: 13,
            fontFamily: "monospace",
            padding: 8,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-1)",
            color: "var(--fg)",
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
          <button
            data-testid="worklist-add-btn"
            onClick={handleAdd}
            disabled={adding || pasteText.trim().length === 0}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 8,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              cursor: adding || pasteText.trim().length === 0 ? "not-allowed" : "pointer",
              opacity: adding || pasteText.trim().length === 0 ? 0.6 : 1,
            }}
          >
            {adding ? "Añadiendo…" : "Añadir"}
          </button>
          {addResult && (
            <span data-testid="worklist-add-result" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
              {addResult}
            </span>
          )}
        </div>
      </section>

      {/* ── Worklist table ───────────────────────────────────────────── */}
      <section style={{ marginTop: 24 }}>
        {loading ? (
          <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>Cargando…</p>
        ) : rows.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--fg-muted)" }} data-testid="worklist-empty">
            No hay URLs en la lista todavía. Pega arriba las URLs de los anuncios
            de Aliseda que quieras capturar.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--fg-muted)", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "6px 8px", fontWeight: 500 }}>Portal</th>
                  <th style={{ padding: "6px 8px", fontWeight: 500 }}>URL</th>
                  <th style={{ padding: "6px 8px", fontWeight: 500 }}>Estado</th>
                  <th style={{ padding: "6px 8px", fontWeight: 500 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    data-testid={`worklist-row-${r.id}`}
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <td style={{ padding: "6px 8px", color: "var(--fg-muted)", textTransform: "capitalize" }}>
                      {r.source_portal}
                    </td>
                    <td style={{ padding: "6px 8px", maxWidth: 460, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid={`worklist-open-${r.id}`}
                        style={{ color: "var(--accent)", textDecoration: "none" }}
                        title={r.url}
                      >
                        {r.url}
                      </a>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <StatusBadge status={r.status} id={r.id} />
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap" }}>
                      {r.status !== "skipped" && r.status !== "captured" && (
                        <button
                          data-testid={`worklist-skip-${r.id}`}
                          onClick={() => handleSetStatus(r.id, "skipped")}
                          style={{
                            fontSize: 12,
                            color: "var(--fg-muted)",
                            background: "none",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            padding: "2px 8px",
                            cursor: "pointer",
                          }}
                        >
                          Omitir
                        </button>
                      )}
                      {(r.status === "skipped" || r.status === "failed") && (
                        <button
                          data-testid={`worklist-reset-${r.id}`}
                          onClick={() => handleSetStatus(r.id, "pending")}
                          style={{
                            fontSize: 12,
                            color: "var(--fg-muted)",
                            background: "none",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            padding: "2px 8px",
                            marginLeft: 6,
                            cursor: "pointer",
                          }}
                        >
                          Reactivar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 8 }}>
              {grandTotal} URL(s) en total.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
