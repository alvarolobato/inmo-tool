"use client";

/**
 * Fuentes (issue #642 P1, part of #636's admin-IA deletion pass) — the
 * merged connector-management + capture-worklist surface, replacing
 * `/etl/connectors` and `/etl/captura` (both deleted outright, 301 via
 * `next.config.js`).
 *
 * ONE route, an optional catch-all (`[[...name]]`), rather than two separate
 * page files for the list and the detail view. This is deliberate, not just
 * a shortcut: the owner's standing complaint on this tracker is "solo has
 * añadido, no has eliminado nada" — this phase must end with FEWER routes
 * than it started with. Two old routes (`/etl/connectors`, `/etl/captura`)
 * merging into two NEW routes (a list page + a `[name]` detail page) nets
 * ZERO — repeating the complaint in a subtler shape. One catch-all route
 * handling both `/admin/fuentes` (list) and `/admin/fuentes/<name>` (detail)
 * is a genuine reduction: 2 routes → 1.
 *
 * - No `name` segment → `<FuentesList>`: a lean list — one compact row per
 *   source (status dot reusing the SAME `lib/source-health.ts` derivation
 *   the Estado board uses, never a second computation; identity;
 *   active/inactive; one-line last-run), linking to its own detail page.
 * - A `name` segment → `<FuenteDetail>`: one source's whole operator
 *   surface. Per the #636 disposition table:
 *     - Config + última ejecución + run-now → `<ConnectorCard
 *       defaultExpanded>` (component reused verbatim — same testids, same
 *       behaviour — a single-source page has nothing left to collapse
 *       behind, unlike the list's "ConnectorCard prose collapses behind a
 *       disclosure").
 *     - The capture worklist (paste-seeding, status filter,
 *       skip/reactivate, "abrir siguiente pendiente") → scoped to this
 *       portal automatically (no portal picker needed — the route param IS
 *       the scope).
 *     - Calidad por fuente (D-084/D-086), Captura por portal
 *       (`extension_capture` activity — NEVER `capture_task_run`, D-048),
 *       Búsquedas sin resultados (D-092), Deriva de portales (D-090/D-093) —
 *       all filtered from the SAME `/api/etl/data-health` /
 *       `/api/etl/drift-reports` reads `/etl/salud` uses today; nothing is
 *       recomputed here, only re-displayed scoped to one source. `/etl/salud`
 *       itself is untouched (P2 deletes it once Estado/Actividad have
 *       absorbed its remaining sections).
 *
 * Admin-gated by middleware.ts (every UI page is), same as every other
 * surface under `/admin`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card } from "@tremor/react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { ConnectorCard } from "@/components/connectors/ConnectorCard";
import { ExtensionCta } from "@/components/extension/ExtensionCta";
import { DriftReport } from "@/components/etl/DriftReport";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { ConnectorConfigPatch, ConnectorView } from "@/lib/connectors-schema";
import { CAPTURE_PORTAL_NAMES, firstPendingUrl, WORKLIST_STATUSES } from "@/lib/worklist";
import type { WorklistPortalSummary, WorklistRow, WorklistStatus } from "@/lib/worklist";
import type { DataHealthResponse } from "@/lib/data-health";
import { LOW_PHOTO_THRESHOLD, isLowPhotoCoverage, isStuckPending, captureSuccessRate } from "@/lib/data-health";
import type { PortalDriftStatus } from "@/lib/search-url/drift-check";
import type { SourceHealthResponse } from "@/app/api/etl/source-health/route";
import { SOURCE_STATUS_LABEL, type SourceStatus } from "@/lib/source-health";

// Same palette as the Estado board (app/admin/page.tsx) — one status
// vocabulary, one set of colors, never a second definition (#636 verdict).
// Shared by both the list's row dot and the detail page's header dot.
const HEALTH_DOT_COLOR: Record<SourceStatus, string> = {
  fresco: "#16a34a",
  pendiente: "#d97706",
  atascado: "#92400e",
  fallando: "#dc2626",
};

// ─── Top-level route: dispatch on the optional catch-all segment ───────────

export default function FuentesPage() {
  const { name } = useParams<{ name?: string[] }>();
  const sourceName = name?.[0];
  return sourceName ? <FuenteDetail name={sourceName} /> : <FuentesList />;
}

// ─── List (was /etl/connectors + /etl/captura's identity, now /admin/fuentes) ─

function FuentesList() {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [health, setHealth] = useState<SourceHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [connectorsRes, healthRes] = await Promise.all([
        fetch("/api/etl/connectors"),
        fetch("/api/etl/source-health").catch(() => null),
      ]);
      if (!connectorsRes.ok) {
        const errBody = await connectorsRes.json().catch(() => null);
        setError(isApiErrorResponse(errBody) ? errBody : "Error al cargar las fuentes");
        return;
      }
      const body = await connectorsRes.json();
      setConnectors(body.connectors ?? []);
      if (healthRes && healthRes.ok) {
        setHealth((await healthRes.json()) as SourceHealthResponse);
      } else {
        setHealth(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar las fuentes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const healthByName = new Map((health?.sources ?? []).map((s) => [s.source, s]));

  return (
    <main className="route-shell" style={{ maxWidth: 900 }} data-testid="fuentes-page">
      <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--fg)", margin: 0 }}>Fuentes</h1>
      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8 }}>
        Cada fila es un conector o portal de captura. Toca una fila para ver y
        cambiar su configuración, su cola de captura y su calidad de datos.
      </p>

      {error && (
        <div style={{ marginTop: 16 }}>
          <ErrorDisplay error={error} />
        </div>
      )}

      {/* Inline install/link CTA (#509): capture-only sources depend on the
          extension being linked — shown only while it isn't. */}
      <div style={{ marginTop: 16 }}>
        <ExtensionCta context="connectors" />
      </div>

      {loading && connectors.length === 0 ? (
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>Cargando…</p>
      ) : connectors.length === 0 ? (
        <p
          style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}
          data-testid="fuentes-empty"
        >
          No hay fuentes registradas todavía. El ETL publica su registro al
          arrancar — si acabas de desplegar, ejecuta el contenedor ETL una vez.
        </p>
      ) : (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {connectors.map((c) => {
            const isCaptureOnly = !c.supports_discovery;
            const active = isCaptureOnly ? c.capture_enabled : c.enabled;
            const h = healthByName.get(c.name);
            return (
              <Link
                key={c.name}
                href={`/admin/fuentes/${encodeURIComponent(c.name)}`}
                data-testid={`fuente-row-${c.name}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  background: "var(--bg-1)",
                  textDecoration: "none",
                  opacity: active ? 1 : 0.65,
                  minHeight: 44,
                }}
              >
                {h && !h.disabled && (
                  <span
                    aria-hidden
                    data-testid={`fuente-dot-${c.name}`}
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: HEALTH_DOT_COLOR[h.status],
                      flexShrink: 0,
                    }}
                  />
                )}
                <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", flexShrink: 0 }}>
                  {c.name}
                </span>
                <span
                  data-testid={`fuente-status-${c.name}`}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "2px 8px",
                    borderRadius: 999,
                    textTransform: "uppercase",
                    letterSpacing: "0.03em",
                    background: active ? "rgba(34,197,94,0.15)" : "var(--bg-2)",
                    color: active ? "rgb(34,197,94)" : "var(--fg-muted)",
                    flexShrink: 0,
                  }}
                >
                  {active ? "activo" : "desactivado"}
                </span>
                {isCaptureOnly && (
                  <span style={{ fontSize: 11, color: "var(--fg-muted)", flexShrink: 0 }}>
                    solo captura
                  </span>
                )}
                <span
                  data-testid={`fuente-lastrun-${c.name}`}
                  style={{
                    fontSize: 12,
                    color: "var(--fg-muted)",
                    marginLeft: "auto",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0,
                  }}
                >
                  {c.lastRun
                    ? `${c.lastRun.status} · ${c.lastRun.fetched_count} descargados`
                    : "sin ejecuciones"}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}

// ─── Detail (was /etl/connectors' config + /etl/captura's ledger + salud
//     per-source slices, now /admin/fuentes/[name]) ────────────────────────

type StatusFilter = WorklistStatus | "all";

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "Todas",
  pending: "Pendientes",
  captured: "Capturadas",
  failed: "Fallidas",
  skipped: "Omitidas",
  stale: "Obsoletas",
};

const WORKLIST_STATUS_LABEL: Record<WorklistStatus, string> = {
  pending: "Pendiente",
  captured: "Capturada",
  failed: "Fallida",
  skipped: "Omitida",
  stale: "Obsoleta",
};

const WORKLIST_STATUS_COLOR: Record<WorklistStatus, string> = {
  pending: "var(--fg-muted)",
  captured: "#16a34a",
  failed: "#dc2626",
  skipped: "var(--fg-muted)",
  stale: "var(--fg-muted)",
};

function isWorklistStatus(v: string | null): v is WorklistStatus {
  return v != null && (WORKLIST_STATUSES as readonly string[]).includes(v);
}

function formatAge(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "nunca";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 2) return "hace un momento";
    if (mins < 60) return `hace ${mins} min`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `hace ${h} h`;
    return `hace ${Math.floor(h / 24)} d`;
  } catch {
    return iso;
  }
}

function formatPct(fraction: number | null): string {
  if (fraction === null || Number.isNaN(fraction)) return "—";
  return `${Math.round(fraction * 100)}%`;
}

function formatRatio(fraction: number | null): string {
  if (fraction === null || Number.isNaN(fraction)) return "—";
  return `${(fraction * 100).toFixed(0)}%`;
}

function formatNum(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return n.toFixed(1);
}

function WorklistStatusBadge({ status, id }: { status: WorklistStatus; id: number }) {
  return (
    <span
      data-testid={`worklist-status-${id}`}
      style={{ fontSize: 12, fontWeight: 600, color: WORKLIST_STATUS_COLOR[status], whiteSpace: "nowrap" }}
    >
      {WORKLIST_STATUS_LABEL[status]}
    </span>
  );
}

function FuenteDetail({ name }: { name: string }) {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [connectorsLoaded, setConnectorsLoaded] = useState(false);
  const [connectorsError, setConnectorsError] = useState<ApiErrorResponse | string | null>(null);

  const [health, setHealth] = useState<SourceHealthResponse | null>(null);

  const [rows, setRows] = useState<WorklistRow[]>([]);
  const [summaries, setSummaries] = useState<WorklistPortalSummary[]>([]);
  const [worklistLoaded, setWorklistLoaded] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Apply `?status=` once on mount (client-only; the page is already a client
  // component, so read straight off the URL — no Suspense boundary needed as
  // would be with useSearchParams, same pattern the old /etl/captura page
  // used). `?portal=` is now implicit in the route param, not a query param.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    if (isWorklistStatus(status)) setStatusFilter(status);
  }, []);

  const [dataHealth, setDataHealth] = useState<DataHealthResponse | null>(null);
  const [drift, setDrift] = useState<PortalDriftStatus[] | null>(null);
  const [driftError, setDriftError] = useState<string | null>(null);
  const [checkingDrift, setCheckingDrift] = useState(false);

  const fetchConnectors = useCallback(async () => {
    setConnectorsError(null);
    try {
      const res = await fetch("/api/etl/connectors");
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        setConnectorsError(isApiErrorResponse(errBody) ? errBody : "Error al cargar la fuente");
        return;
      }
      const body = await res.json();
      setConnectors(body.connectors ?? []);
    } catch (err) {
      setConnectorsError(err instanceof Error ? err.message : "Error al cargar la fuente");
    } finally {
      setConnectorsLoaded(true);
    }
  }, []);

  const fetchWorklist = useCallback(async () => {
    try {
      const res = await fetch(`/api/etl/worklist?portal=${encodeURIComponent(name)}`);
      if (!res.ok) return;
      const body = await res.json();
      setRows(body.rows ?? []);
      setSummaries(body.summaries ?? []);
    } catch {
      // Best-effort — a source with no capture activity just shows nothing here.
    } finally {
      setWorklistLoaded(true);
    }
  }, [name]);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/etl/source-health");
      if (res.ok) setHealth((await res.json()) as SourceHealthResponse);
    } catch {
      setHealth(null);
    }
  }, []);

  const fetchDataHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/etl/data-health");
      if (res.ok) setDataHealth((await res.json()) as DataHealthResponse);
    } catch {
      // Additive section — a failure here must not take down the page.
    }
  }, []);

  const fetchDrift = useCallback(async () => {
    try {
      const res = await fetch("/api/etl/drift-reports");
      if (res.ok) {
        const body = await res.json();
        setDrift((body.reports ?? []) as PortalDriftStatus[]);
      }
    } catch {
      // Additive section — same posture as fetchDataHealth.
    }
  }, []);

  useEffect(() => {
    void fetchConnectors();
    void fetchWorklist();
    void fetchHealth();
    void fetchDataHealth();
    void fetchDrift();
  }, [fetchConnectors, fetchWorklist, fetchHealth, fetchDataHealth, fetchDrift]);

  const handlePatch = useCallback(
    async (connectorName: string, patch: ConnectorConfigPatch) => {
      setConnectorsError(null);
      try {
        const res = await fetch(`/api/etl/connectors/${encodeURIComponent(connectorName)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => null);
          setConnectorsError(
            isApiErrorResponse(errBody) ? errBody : `No se pudo actualizar ${connectorName}`,
          );
          return;
        }
        await fetchConnectors();
      } catch (err) {
        setConnectorsError(err instanceof Error ? err.message : `No se pudo actualizar ${connectorName}`);
      }
    },
    [fetchConnectors],
  );

  const handleAdd = useCallback(async () => {
    setAdding(true);
    setAddResult(null);
    try {
      const res = await fetch("/api/etl/worklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: pasteText }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setAddResult(null);
        return;
      }
      const invalidNote = body.invalid?.length > 0 ? `, ${body.invalid.length} inválida(s)` : "";
      setAddResult(`${body.added} añadida(s), ${body.duplicate} duplicada(s)${invalidNote}.`);
      setPasteText("");
      await fetchWorklist();
    } finally {
      setAdding(false);
    }
  }, [pasteText, fetchWorklist]);

  const handleSetStatus = useCallback(
    async (id: number, status: WorklistStatus) => {
      try {
        const res = await fetch(`/api/etl/worklist/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (res.ok) await fetchWorklist();
      } catch {
        // Row stays as-is; the operator can retry the click.
      }
    },
    [fetchWorklist],
  );

  const checkDriftNow = useCallback(async () => {
    setCheckingDrift(true);
    setDriftError(null);
    try {
      const res = await fetch(`/api/etl/discovery/${encodeURIComponent(name)}/refresh`, {
        method: "POST",
      });
      if (!res.ok) {
        setDriftError("No se pudo comprobar la deriva ahora.");
        return;
      }
      await fetchDrift();
    } catch {
      setDriftError("No se pudo comprobar la deriva ahora.");
    } finally {
      setCheckingDrift(false);
    }
  }, [name, fetchDrift]);

  const nextPendingUrl = useMemo(() => firstPendingUrl(rows), [rows]);
  const handleOpenNext = useCallback(() => {
    if (!nextPendingUrl) return;
    window.open(nextPendingUrl, "_blank", "noopener,noreferrer");
  }, [nextPendingUrl]);

  const visibleRows = useMemo(
    () => (statusFilter === "all" ? rows : rows.filter((r) => r.status === statusFilter)),
    [rows, statusFilter],
  );

  const connector = connectors.find((c) => c.name === name);
  const healthRow = health?.sources.find((s) => s.source === name) ?? null;
  const showWorklist = CAPTURE_PORTAL_NAMES.includes(name) || summaries.length > 0;

  const portalHealth = dataHealth?.portals.find((p) => p.portal === name) ?? null;
  const sourceQuality = dataHealth?.sources.find((s) => s.source === name) ?? null;
  const zeroResultRows = dataHealth?.zero_result_regressions.filter((z) => z.connector === name) ?? [];
  const driftReport = drift?.find((r) => r.connector === name) ?? null;

  return (
    <main className="route-shell" style={{ maxWidth: 900 }} data-testid="fuente-detail-page">
      <Link
        href="/admin/fuentes"
        style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none" }}
      >
        ← Fuentes
      </Link>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
        {healthRow && !healthRow.disabled && (
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: HEALTH_DOT_COLOR[healthRow.status],
              flexShrink: 0,
            }}
          />
        )}
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--fg)", margin: 0 }}>{name}</h1>
        {healthRow && (
          <span data-testid="fuente-health-label" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
            {SOURCE_STATUS_LABEL[healthRow.status]}
          </span>
        )}
      </div>

      {connectorsError && (
        <div style={{ marginTop: 16 }}>
          <ErrorDisplay error={connectorsError} />
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <ExtensionCta context="connectors" />
      </div>

      {connectorsLoaded && !connector ? (
        <p
          style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}
          data-testid="fuente-not-found"
        >
          No hay ningún conector registrado llamado «{name}».
        </p>
      ) : !connectorsLoaded ? (
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>Cargando…</p>
      ) : (
        <div style={{ marginTop: 16 }}>
          <ConnectorCard
            connector={connector!}
            onPatch={handlePatch}
            onRunFinished={fetchConnectors}
            defaultExpanded
          />
        </div>
      )}

      {/* ── Captura (worklist ledger, from /etl/captura) ─────────────────── */}
      {showWorklist && (
        <section style={{ marginTop: 28 }} data-testid="fuente-worklist">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--fg)" }}>Captura</h2>
          <p style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 4 }}>
            El libro de capturas de esta fuente: lo que la extensión está
            drenando. La captura se decide y se lanza desde{" "}
            <Link
              href="/captura"
              data-testid="worklist-to-captura"
              style={{ color: "var(--accent)", textDecoration: "none" }}
            >
              Captura
            </Link>
            ; aquí observas y reparas la cola — filtras por estado, siembras a
            mano URLs sueltas y omites o reactivas filas.
          </p>

          <section data-testid="worklist-summary" style={{ marginTop: 12 }}>
            {summaries.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--fg-muted)" }} data-testid="worklist-summary-empty">
                Aún no hay URLs en la lista.
              </p>
            ) : (
              summaries.map((s) => {
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
                      <span style={{ color: "var(--fg)" }}>
                        {s.captured}/{s.total} capturadas
                      </span>
                      <span style={{ color: "var(--fg-muted)" }}>{s.pending} pendientes</span>
                      {s.failed > 0 && <span style={{ color: "#dc2626" }}>{s.failed} fallidas</span>}
                      {s.skipped > 0 && <span style={{ color: "var(--fg-muted)" }}>{s.skipped} omitidas</span>}
                      {s.stale > 0 && <span style={{ color: "var(--fg-muted)" }}>{s.stale} obsoletas</span>}
                      <Link
                        href="/captura"
                        data-testid={`worklist-portal-captura-${s.source_portal}`}
                        style={{ color: "var(--accent)", textDecoration: "none" }}
                      >
                        ver en Captura →
                      </Link>
                      <span style={{ color: "var(--fg-muted)", marginLeft: "auto" }}>{pct}%</span>
                    </div>
                    <div
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${pct}% capturadas`}
                      style={{ marginTop: 8, height: 6, borderRadius: 4, background: "var(--border)", overflow: "hidden" }}
                    >
                      <div style={{ width: `${pct}%`, height: "100%", background: "#16a34a", transition: "width 0.2s" }} />
                    </div>
                  </div>
                );
              })
            )}
          </section>

          <section style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              data-testid="worklist-open-next"
              onClick={handleOpenNext}
              disabled={!nextPendingUrl}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "6px 16px",
                minHeight: 44,
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
              type="button"
              data-testid="worklist-refresh"
              onClick={fetchWorklist}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "6px 16px",
                minHeight: 44,
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-1)",
                color: "var(--fg)",
                cursor: "pointer",
              }}
            >
              Actualizar
            </button>
          </section>

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
                type="button"
                data-testid="worklist-add-btn"
                onClick={handleAdd}
                disabled={adding || pasteText.trim().length === 0}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "6px 16px",
                  minHeight: 44,
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

          {rows.length > 0 && (
            <section
              data-testid="worklist-filters"
              style={{ marginTop: 20, display: "flex", gap: 8, flexWrap: "wrap" }}
            >
              {(["all", ...WORKLIST_STATUSES] as StatusFilter[]).map((f) => {
                const active = statusFilter === f;
                const count = f === "all" ? rows.length : rows.filter((r) => r.status === f).length;
                return (
                  <button
                    key={f}
                    type="button"
                    data-testid={`worklist-filter-${f}`}
                    aria-pressed={active}
                    onClick={() => setStatusFilter(f)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      padding: "4px 12px",
                      minHeight: 44,
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

          <section style={{ marginTop: 12 }}>
            {!worklistLoaded ? (
              <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>Cargando…</p>
            ) : rows.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--fg-muted)" }} data-testid="worklist-empty">
                No hay URLs en la lista todavía. Pega arriba las URLs de anuncios
                que quieras capturar.
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
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>URL</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Estado</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r) => (
                      <tr key={r.id} data-testid={`worklist-row-${r.id}`} style={{ borderBottom: "1px solid var(--border)" }}>
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
                          <WorklistStatusBadge status={r.status} id={r.id} />
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap" }}>
                          {r.status !== "skipped" && r.status !== "captured" && r.status !== "stale" && (
                            <button
                              type="button"
                              data-testid={`worklist-skip-${r.id}`}
                              onClick={() => handleSetStatus(r.id, "skipped")}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                fontSize: 12,
                                minHeight: 44,
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
                              type="button"
                              data-testid={`worklist-reset-${r.id}`}
                              onClick={() => handleSetStatus(r.id, "pending")}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                fontSize: 12,
                                minHeight: 44,
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
              </div>
            )}
          </section>
        </section>
      )}

      {/* ── Captura por portal (extension_capture activity, D-048: never
          capture_task_run) ────────────────────────────────────────────── */}
      {portalHealth && (
        <section style={{ marginTop: 28 }} data-testid="fuente-portal-health">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--fg)" }}>Captura por portal</h2>
          <Card className="p-4" style={{ marginTop: 8 }}>
            <dl style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <dt style={{ color: "var(--fg-muted)" }}>Pendientes</dt>
                <dd
                  style={{
                    fontWeight: 600,
                    color: isStuckPending(portalHealth.oldest_pending_age_seconds)
                      ? "var(--danger, #b91c1c)"
                      : "var(--fg)",
                  }}
                >
                  {portalHealth.pending_count}
                  {portalHealth.pending_count > 0 && (
                    <span style={{ color: "var(--fg-muted)", marginLeft: 6, fontWeight: 400 }}>
                      (más antiguo: {formatAge(portalHealth.oldest_pending_age_seconds)})
                    </span>
                  )}
                </dd>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <dt style={{ color: "var(--fg-muted)" }}>Éxito (7d)</dt>
                <dd style={{ fontWeight: 600 }}>
                  {formatPct(captureSuccessRate(portalHealth.done_7d, portalHealth.failed_7d))}{" "}
                  <span style={{ color: "var(--fg-muted)", fontWeight: 400 }}>
                    ({portalHealth.done_7d}✓ / {portalHealth.failed_7d}✗)
                  </span>
                </dd>
              </div>
              {portalHealth.listing_7d > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <dt style={{ color: "var(--fg-muted)" }}>Páginas de resultados (7d)</dt>
                  <dd style={{ fontWeight: 600 }}>{portalHealth.listing_7d}</dd>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <dt style={{ color: "var(--fg-muted)" }}>Completitud</dt>
                <dd style={{ fontWeight: 600 }}>{formatRatio(portalHealth.avg_fields_ratio_7d)}</dd>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <dt style={{ color: "var(--fg-muted)" }}>Fotos/anuncio</dt>
                <dd style={{ fontWeight: 600 }}>{formatNum(portalHealth.avg_photo_count_7d)}</dd>
              </div>
            </dl>
          </Card>
        </section>
      )}

      {/* ── Calidad (D-084/D-086) ─────────────────────────────────────── */}
      {sourceQuality && (
        <section style={{ marginTop: 28 }} data-testid="fuente-quality">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--fg)" }}>Calidad</h2>
          <Card className="p-4" style={{ marginTop: 8 }}>
            <dl style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <dt style={{ color: "var(--fg-muted)" }}>Anuncios almacenados</dt>
                <dd style={{ fontWeight: 600 }}>{sourceQuality.listing_count}</dd>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <dt style={{ color: "var(--fg-muted)" }}>Fotos/anuncio</dt>
                <dd style={{ fontWeight: 600 }}>
                  <span
                    style={
                      isLowPhotoCoverage(sourceQuality.avg_photo_count)
                        ? { color: "var(--danger, #b91c1c)" }
                        : undefined
                    }
                  >
                    {formatNum(sourceQuality.avg_photo_count)}
                  </span>
                  {isLowPhotoCoverage(sourceQuality.avg_photo_count) && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "1px 8px",
                        borderRadius: 999,
                        background: "var(--danger-soft, #fee2e2)",
                        color: "var(--danger, #b91c1c)",
                      }}
                    >
                      &lt; {LOW_PHOTO_THRESHOLD}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </Card>
        </section>
      )}

      {/* ── Búsquedas sin resultados (D-092) ─────────────────────────── */}
      {zeroResultRows.length > 0 && (
        <section style={{ marginTop: 28 }} data-testid="fuente-zero-result-regressions">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--fg)" }}>
            Búsquedas que dejaron de devolver resultados
          </h2>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {zeroResultRows.map((z) => (
              <Card
                key={z.scope_key}
                className="p-4"
                data-testid={`zero-result-regression-${z.connector}-${z.scope_key}`}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>{z.scope_key}</span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "1px 8px",
                      borderRadius: 999,
                      background: "var(--danger-soft, #fee2e2)",
                      color: "var(--danger, #b91c1c)",
                    }}
                  >
                    {z.consecutive_zeros} ejec. a 0
                  </span>
                </div>
                <p style={{ marginTop: 8, fontSize: 12, color: "var(--danger, #b91c1c)" }}>
                  Antes devolvía{" "}
                  {z.last_nonzero_count !== null ? `${z.last_nonzero_count} anuncio(s)` : "resultados"}
                  ; ahora 0 desde {formatRelative(z.drift_started_at)}.
                </p>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* ── Deriva de portales (D-090/D-093) ─────────────────────────── */}
      {driftReport && (
        <section style={{ marginTop: 28 }} data-testid="fuente-drift">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--fg)" }}>Deriva de portales</h2>
            <button
              type="button"
              data-testid="fuente-drift-check"
              onClick={() => void checkDriftNow()}
              disabled={checkingDrift}
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: 44,
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 500,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-1)",
                color: "var(--accent)",
                cursor: checkingDrift ? "not-allowed" : "pointer",
                opacity: checkingDrift ? 0.6 : 1,
              }}
            >
              {checkingDrift ? "Comprobando…" : "Comprobar ahora"}
            </button>
          </div>
          <p style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 4 }}>
            Última comprobación: {driftReport.capturedAt ? formatRelative(driftReport.capturedAt) : "nunca"}.
          </p>
          {driftError && (
            <p style={{ fontSize: 12, color: "var(--danger, #b91c1c)", marginTop: 4 }}>{driftError}</p>
          )}
          <div style={{ marginTop: 8 }}>
            {driftReport.drift && driftReport.drift.hasCatalog ? (
              <DriftReport drift={driftReport.drift} />
            ) : (
              <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>
                Aún no se ha capturado ningún catálogo para «{name}». Pulsa
                «Comprobar ahora» para ejecutar el extractor estático.
              </p>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
