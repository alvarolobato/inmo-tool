"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { ExtensionCta } from "@/components/extension/ExtensionCta";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import { firstPendingUrl, WORKLIST_STATUSES } from "@/lib/worklist";
import type {
  WorklistPortalSummary,
  WorklistRow,
  WorklistStatus,
} from "@/lib/worklist";

type StatusFilter = WorklistStatus | "all";

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "Todas",
  pending: "Pendientes",
  captured: "Capturadas",
  failed: "Fallidas",
  skipped: "Omitidas",
  stale: "Obsoletas",
};

/**
 * Captura (admin) — the capture worklist LEDGER (issue #237 → reconciled in
 * #512).
 *
 * Role split (#512): capture is DECIDED AND LAUNCHED from `/captura` (the
 * TopBar surface: per-profile tasks, staleness, "Abrir búsqueda ↗" that
 * auto-starts the extension batch). THIS admin page only OBSERVES AND REPAIRS
 * the queue the extension drains — the "libro de capturas": per-portal
 * progress, status filters, manual paste-seeding of hand-collected URLs, and
 * per-row skip / reactivate. It never launches a capture cycle itself.
 *
 * Lives under /etl so middleware.ts already admin-gates it (and its
 * `/api/etl/worklist` API), same as the connector-management page.
 *
 * Deep-linkable (#512): `?portal=<portal>&status=<status>` presets the portal
 * and status filters, so the queue chips on `/captura` can land straight on a
 * portal's pending rows.
 */

const STATUS_LABEL: Record<WorklistStatus, string> = {
  pending: "Pendiente",
  captured: "Capturada",
  failed: "Fallida",
  skipped: "Omitida",
  // 'stale' (issue #273): the listing left the portal's sitemap (sold/delisted).
  stale: "Obsoleta",
};

const STATUS_COLOR: Record<WorklistStatus, string> = {
  pending: "var(--fg-muted)",
  captured: "#16a34a",
  failed: "#dc2626",
  skipped: "var(--fg-muted)",
  stale: "var(--fg-muted)",
};

function isWorklistStatus(v: string | null): v is WorklistStatus {
  return v != null && (WORKLIST_STATUSES as readonly string[]).includes(v);
}

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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Deep-link portal focus (#512): a queue chip on /captura lands here filtered
  // to one portal. null = every portal (the default admin view).
  const [portalFilter, setPortalFilter] = useState<string | null>(null);

  // Apply `?portal=&status=` once on mount (client-only; the page is already a
  // client component, so read straight off the URL — no Suspense boundary
  // needed as would be with useSearchParams).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    if (isWorklistStatus(status)) setStatusFilter(status);
    const portal = params.get("portal")?.trim();
    if (portal) setPortalFilter(portal);
  }, []);

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

  // Rows/summaries the portal deep-link focuses on (all portals when null).
  const scopedRows = useMemo(
    () => (portalFilter ? rows.filter((r) => r.source_portal === portalFilter) : rows),
    [rows, portalFilter],
  );
  const scopedSummaries = useMemo(
    () => (portalFilter ? summaries.filter((s) => s.source_portal === portalFilter) : summaries),
    [summaries, portalFilter],
  );

  const grandTotal = useMemo(
    () => scopedSummaries.reduce((acc, s) => acc + s.total, 0),
    [scopedSummaries],
  );

  const nextPendingUrl = useMemo(() => firstPendingUrl(scopedRows), [scopedRows]);

  // Manual fallback advance (issue #262, D-043): open the NEXT pending URL in a
  // new tab, one per click. This used to be the PRIMARY flow (#254's deliberate
  // human-paced design), but batch capture now lives in the browser extension:
  // from a listing page the extension harvests every detail link and runs the
  // whole worklist itself — open → activate → auto-capture → close → advance,
  // with jittered pacing for WAF safety (see the extension's batch.js / D-043).
  // This button remains only for opening a single pending listing by hand.
  const handleOpenNext = useCallback(() => {
    if (!nextPendingUrl) return;
    window.open(nextPendingUrl, "_blank", "noopener,noreferrer");
  }, [nextPendingUrl]);

  const visibleRows = useMemo(
    () =>
      statusFilter === "all"
        ? scopedRows
        : scopedRows.filter((r) => r.status === statusFilter),
    [scopedRows, statusFilter],
  );

  return (
    <main style={{ padding: 24, maxWidth: 980 }} data-testid="worklist-page">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--fg)", margin: 0 }}>
          Captura (admin)
        </h1>
        <Link
          href="/etl/connectors"
          style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none", marginLeft: "auto" }}
        >
          Conectores →
        </Link>
      </div>

      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8 }}>
        El <strong>libro de capturas</strong>: el registro de lo que la extensión
        está drenando, no desde donde se captura. La captura se decide y se lanza
        desde{" "}
        <Link
          href="/captura"
          data-testid="worklist-to-captura"
          style={{ color: "var(--accent)", textDecoration: "none" }}
        >
          Captura
        </Link>
        , donde cada perfil abre su búsqueda y la extensión captura sola con{" "}
        <strong>«Capturar todas»</strong> (issue #262). Aquí solo{" "}
        <strong>observas y reparas la cola</strong>: sigues el progreso por
        portal, filtras por estado, siembras a mano URLs sueltas y omites o
        reactivas filas. La lista se marca sola como capturada cuando llega cada
        captura.
      </p>

      {error && (
        <div style={{ marginTop: 16 }}>
          <ErrorDisplay error={error} />
        </div>
      )}

      {/* Inline install/link CTA (#509) — a banner shown only while the
          extension is not linked; the whole worklist depends on it. */}
      <div style={{ marginTop: 16 }}>
        <ExtensionCta context="worklist" />
      </div>

      {/* Deep-link portal focus (#512): show which portal we're scoped to and a
          one-click way back to the full ledger. */}
      {portalFilter && (
        <div
          data-testid="worklist-portal-focus"
          style={{
            marginTop: 16,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13,
            color: "var(--fg-muted)",
          }}
        >
          <span>
            Mostrando solo <strong style={{ color: "var(--fg)", textTransform: "capitalize" }}>{portalFilter}</strong>.
          </span>
          <button
            data-testid="worklist-portal-focus-clear"
            onClick={() => setPortalFilter(null)}
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
            Ver todos los portales
          </button>
        </div>
      )}

      {/* ── Human-paced "Siguiente" advance (repair affordance) ──────────── */}
      <section style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          data-testid="worklist-open-next"
          onClick={handleOpenNext}
          disabled={!nextPendingUrl}
          title={
            nextPendingUrl
              ? "Abre el siguiente anuncio pendiente en una pestaña nueva"
              : "No hay anuncios pendientes"
          }
          style={{
            padding: "6px 16px",
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 8,
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            cursor: nextPendingUrl ? "pointer" : "not-allowed",
            opacity: nextPendingUrl ? 1 : 0.6,
          }}
        >
          Abrir siguiente pendiente →
        </button>
        <button
          data-testid="worklist-refresh"
          onClick={fetchWorklist}
          disabled={loading}
          style={{
            padding: "6px 16px",
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--bg-1)",
            color: "var(--fg)",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          Actualizar
        </button>
        <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          Abre un anuncio cada vez que pulsas. Navega tú y espera a que cargue: la
          extensión lo captura sola.
        </span>
      </section>

      {/* ── Progress summary ─────────────────────────────────────────── */}
      <section data-testid="worklist-summary" style={{ marginTop: 16 }}>
        {scopedSummaries.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--fg-muted)" }} data-testid="worklist-summary-empty">
            Aún no hay URLs en la lista.
          </p>
        ) : (
          scopedSummaries.map((s) => {
            const pct = s.total > 0 ? Math.round((s.captured / s.total) * 100) : 0;
            return (
              <div
                key={s.source_portal}
                data-testid={`worklist-summary-${s.source_portal}`}
                style={{
                  padding: "8px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  marginBottom: 8,
                  fontSize: 13,
                }}
              >
                <div style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong style={{ color: "var(--fg)", textTransform: "capitalize" }}>
                    {s.source_portal}
                  </strong>
                  <span style={{ color: "var(--fg)" }}>
                    {s.captured}/{s.total} capturadas
                  </span>
                  <span style={{ color: "var(--fg-muted)" }}>{s.pending} pendientes</span>
                  {s.failed > 0 && <span style={{ color: "#dc2626" }}>{s.failed} fallidas</span>}
                  {s.skipped > 0 && <span style={{ color: "var(--fg-muted)" }}>{s.skipped} omitidas</span>}
                  {s.stale > 0 && <span style={{ color: "var(--fg-muted)" }}>{s.stale} obsoletas</span>}
                  {/* Cross-link back to where this portal's queue is fed from —
                      the profiles/tasks on /captura (#512). */}
                  <Link
                    href="/captura"
                    data-testid={`worklist-portal-captura-${s.source_portal}`}
                    style={{ color: "var(--accent)", textDecoration: "none" }}
                  >
                    ver en Captura →
                  </Link>
                  <span style={{ color: "var(--fg-muted)", marginLeft: "auto" }}>{pct}%</span>
                </div>
                {/* Visual progress bar (issue #260): captured share of the portal. */}
                <div
                  data-testid={`worklist-progress-${s.source_portal}`}
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${s.source_portal}: ${pct}% capturadas`}
                  style={{
                    marginTop: 8,
                    height: 6,
                    borderRadius: 4,
                    background: "var(--border)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      background: "#16a34a",
                      transition: "width 0.2s",
                    }}
                  />
                </div>
              </div>
            );
          })
        )}
      </section>

      {/* ── Manual URL entry (the only seed path for hand-collected URLs) ── */}
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

      {/* ── Status filter tabs ───────────────────────────────────────── */}
      {scopedRows.length > 0 && (
        <section
          data-testid="worklist-filters"
          style={{ marginTop: 24, display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          {(["all", ...WORKLIST_STATUSES] as StatusFilter[]).map((f) => {
            const active = statusFilter === f;
            const count = f === "all" ? scopedRows.length : scopedRows.filter((r) => r.status === f).length;
            return (
              <button
                key={f}
                data-testid={`worklist-filter-${f}`}
                aria-pressed={active}
                onClick={() => setStatusFilter(f)}
                style={{
                  padding: "4px 12px",
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  borderRadius: 999,
                  border: "1px solid var(--border)",
                  background: active ? "var(--accent)" : "var(--bg-1)",
                  color: active ? "#fff" : "var(--fg)",
                  cursor: "pointer",
                }}
              >
                {FILTER_LABEL[f]} ({count})
              </button>
            );
          })}
        </section>
      )}

      {/* ── Worklist table ───────────────────────────────────────────── */}
      <section style={{ marginTop: 12 }}>
        {loading ? (
          <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>Cargando…</p>
        ) : scopedRows.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--fg-muted)" }} data-testid="worklist-empty">
            No hay URLs en la lista todavía. Pega arriba las URLs de los anuncios
            de Aliseda (u otro portal de extensión) que quieras capturar.
          </p>
        ) : visibleRows.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--fg-muted)" }} data-testid="worklist-filter-empty">
            Ninguna URL con el estado «{FILTER_LABEL[statusFilter]}».
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
                {visibleRows.map((r) => (
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
                      {r.status !== "skipped" &&
                        r.status !== "captured" &&
                        r.status !== "stale" && (
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
