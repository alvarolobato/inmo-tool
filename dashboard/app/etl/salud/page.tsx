"use client";

/**
 * "Salud de datos" — read-only capture/ETL observability (issue #272).
 *
 * One page answers, at a glance: is any connector failing (vs. cleanly
 * budget-stopped)? Is any portal's capture backlog stuck? Is extraction
 * quality where it should be? Is any source under-extracting photos? Is any
 * profile's materialization stale? Display-only — no alerting, no writes, no
 * connector CONFIG (that lives on the Conectores page). Data comes from
 * GET /api/etl/data-health; the clean-vs-error distinction is pre-computed
 * server-side and rendered here as green-with-a-note vs. red.
 */

import { useCallback, useEffect, useState } from "react";
import { Card } from "@tremor/react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse, type ApiErrorResponse } from "@/lib/errors";
import {
  captureSuccessRate,
  connectorHealthLevel,
  hasCleanNotice,
  isLowPhotoCoverage,
  isStuckPending,
  LOW_PHOTO_THRESHOLD,
  type ConnectorHealth,
  type DataHealthResponse,
  type PortalCaptureHealth,
  type SourceDataQuality,
  type StaleProfile,
} from "@/lib/data-health";

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatPct(fraction: number | null): string {
  if (fraction === null || Number.isNaN(fraction)) return "—";
  return `${Math.round(fraction * 100)}%`;
}

function formatRatio(fraction: number | null): string {
  if (fraction === null || Number.isNaN(fraction)) return "—";
  return `${(fraction * 100).toFixed(0)}%`;
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

function formatNum(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return n.toFixed(1);
}

const STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  circuit_open: "Circuito abierto",
  failed: "Fallo",
  skipped: "Omitido",
};

// ─── Small presentational bits ───────────────────────────────────────────────

function Badge({
  children,
  tone,
  testId,
}: {
  children: React.ReactNode;
  tone: "good" | "warn" | "info" | "muted";
  testId?: string;
}) {
  const bg =
    tone === "warn"
      ? "var(--danger-soft, #fee2e2)"
      : tone === "good"
        ? "var(--accent-soft)"
        : tone === "info"
          ? "var(--accent-soft)"
          : "var(--bg-2, #f3f4f6)";
  const fg =
    tone === "warn"
      ? "var(--danger, #b91c1c)"
      : tone === "info"
        ? "var(--accent)"
        : tone === "good"
          ? "var(--accent)"
          : "var(--fg-muted)";
  return (
    <span
      data-testid={testId}
      style={{
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: bg,
        color: fg,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-lg font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
      {children}
    </h2>
  );
}

function EmptyRow({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p
      data-testid={testId}
      className="text-sm text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
    >
      {children}
    </p>
  );
}

// ─── Sections ────────────────────────────────────────────────────────────────

function ConnectorHealthSection({ rows }: { rows: ConnectorHealth[] }) {
  return (
    <section className="space-y-3" data-testid="connector-health">
      <SectionTitle>Conectores — última ejecución</SectionTitle>
      {rows.length === 0 ? (
        <EmptyRow testId="connector-health-empty">
          Todavía no hay ejecuciones de conectores registradas.
        </EmptyRow>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rows.map((c) => {
            const attention = connectorHealthLevel(c.last_status) === "attention";
            const clean = hasCleanNotice(c.last_status, c.notice);
            const trend =
              c.prev_error_count === null
                ? null
                : c.error_count - c.prev_error_count;
            return (
              <Card
                key={c.connector_name}
                className="p-4"
                data-testid={`connector-health-${c.connector_name}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
                    {c.connector_name}
                  </p>
                  <Badge
                    tone={attention ? "warn" : "good"}
                    testId={`connector-status-${c.connector_name}`}
                  >
                    {STATUS_LABEL[c.last_status] ?? c.last_status}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                  {formatRelative(c.last_run_at)} · {c.fetched_count} de{" "}
                  {c.discovered_count} descargados
                  {c.error_count > 0 && (
                    <>
                      {" · "}
                      <span data-testid={`connector-errors-${c.connector_name}`}>
                        {c.error_count} errores
                        {trend !== null && trend !== 0 && (
                          <span aria-hidden="true">{trend > 0 ? " ↑" : " ↓"}</span>
                        )}
                      </span>
                    </>
                  )}
                </p>
                {/* Clean budget/soft-block stop: informational, NOT an error. */}
                {clean && (
                  <p
                    className="mt-2 text-xs"
                    style={{ color: "var(--accent)" }}
                    data-testid={`connector-notice-${c.connector_name}`}
                  >
                    <Badge tone="info">Parada limpia</Badge>{" "}
                    {c.notice}
                  </p>
                )}
                {attention && c.error_msg && (
                  <p
                    className="mt-2 text-xs"
                    style={{ color: "var(--danger, #b91c1c)" }}
                    data-testid={`connector-error-${c.connector_name}`}
                  >
                    {c.error_msg}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PortalHealthSection({ rows }: { rows: PortalCaptureHealth[] }) {
  return (
    <section className="space-y-3" data-testid="portal-health">
      <SectionTitle>Captura por portal</SectionTitle>
      {rows.length === 0 ? (
        <EmptyRow testId="portal-health-empty">
          Todavía no hay capturas registradas.
        </EmptyRow>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((p) => {
            const stuck = isStuckPending(p.oldest_pending_age_seconds);
            const rate = captureSuccessRate(p.done_7d, p.failed_7d);
            return (
              <Card
                key={p.portal}
                className="p-4"
                data-testid={`portal-health-${p.portal}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
                    {p.portal}
                  </p>
                  {stuck && (
                    <Badge tone="warn" testId={`portal-stuck-${p.portal}`}>
                      Atascado
                    </Badge>
                  )}
                </div>
                <dl className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-tremor-content dark:text-dark-tremor-content">
                      Pendientes
                    </dt>
                    <dd
                      className="font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong"
                      data-testid={`portal-pending-${p.portal}`}
                      style={stuck ? { color: "var(--danger, #b91c1c)" } : undefined}
                    >
                      {p.pending_count}
                      {p.pending_count > 0 && (
                        <span
                          className="ml-1 text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
                          data-testid={`portal-oldest-${p.portal}`}
                        >
                          (más antiguo: {formatAge(p.oldest_pending_age_seconds)})
                        </span>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-tremor-content dark:text-dark-tremor-content">
                      Éxito (7d)
                    </dt>
                    <dd
                      className="font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong"
                      data-testid={`portal-success-${p.portal}`}
                    >
                      {formatPct(rate)}
                      <span className="ml-1 text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                        ({p.done_7d}✓ / {p.failed_7d}✗)
                      </span>
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-tremor-content dark:text-dark-tremor-content">
                      Completitud
                    </dt>
                    <dd
                      className="font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong"
                      data-testid={`portal-completeness-${p.portal}`}
                    >
                      {formatRatio(p.avg_fields_ratio_7d)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-tremor-content dark:text-dark-tremor-content">
                      Fotos/anuncio
                    </dt>
                    <dd
                      className="font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong"
                      data-testid={`portal-photos-${p.portal}`}
                    >
                      {formatNum(p.avg_photo_count_7d)}
                    </dd>
                  </div>
                </dl>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SourceQualitySection({ rows }: { rows: SourceDataQuality[] }) {
  return (
    <section className="space-y-3" data-testid="source-quality">
      <SectionTitle>Calidad por fuente</SectionTitle>
      {rows.length === 0 ? (
        <EmptyRow testId="source-quality-empty">
          Todavía no hay anuncios almacenados.
        </EmptyRow>
      ) : (
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b" style={{ borderColor: "var(--border)" }}>
                  <th className="p-3 text-left font-medium text-tremor-content dark:text-dark-tremor-content">
                    Fuente
                  </th>
                  <th className="p-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content">
                    Anuncios
                  </th>
                  <th className="p-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content">
                    Fotos/anuncio
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const low = isLowPhotoCoverage(s.avg_photo_count);
                  return (
                    <tr
                      key={s.source}
                      className="border-b last:border-0"
                      style={{ borderColor: "var(--border)" }}
                      data-testid={`source-quality-${s.source}`}
                    >
                      <td className="p-3 text-tremor-content-strong dark:text-dark-tremor-content-strong">
                        {s.source}
                      </td>
                      <td className="p-3 text-right tabular-nums text-tremor-content-strong dark:text-dark-tremor-content-strong">
                        {s.listing_count}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        <span
                          className="text-tremor-content-strong dark:text-dark-tremor-content-strong"
                          style={low ? { color: "var(--danger, #b91c1c)" } : undefined}
                        >
                          {formatNum(s.avg_photo_count)}
                        </span>
                        {low && (
                          <span className="ml-2">
                            <Badge tone="warn" testId={`source-lowphoto-${s.source}`}>
                              &lt; {LOW_PHOTO_THRESHOLD}
                            </Badge>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}

function StaleProfilesSection({ rows }: { rows: StaleProfile[] }) {
  return (
    <section className="space-y-3" data-testid="stale-profiles">
      <SectionTitle>Perfiles sin re-materializar</SectionTitle>
      {rows.length === 0 ? (
        <EmptyRow testId="stale-profiles-empty">
          Todos los perfiles están al día con los últimos anuncios.
        </EmptyRow>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((p) => (
            <Card
              key={p.id}
              className="p-4"
              data-testid={`stale-profile-${p.id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
                  {p.name}
                </p>
                <Badge tone="warn">Desactualizado</Badge>
              </div>
              <p className="mt-1 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                Materializado {formatRelative(p.last_materialized_at)} · datos{" "}
                {formatRelative(p.newest_listing_at)}
              </p>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 animate-pulse" aria-busy="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} className="p-4">
          <div className="h-4 w-32 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
          <div className="mt-3 h-16 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
        </Card>
      ))}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DataHealthPage() {
  const [data, setData] = useState<DataHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/etl/data-health");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "Error al cargar la salud de datos");
        return;
      }
      setData((await res.json()) as DataHealthResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar la salud de datos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHealth();
  }, [fetchHealth]);

  return (
    <div className="space-y-6" data-testid="data-health-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            Salud de datos
          </h1>
          <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
            Observabilidad de captura e ingesta: qué está atascado, qué falla y
            dónde baja la calidad de extracción.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchHealth()}
          disabled={loading}
          data-testid="data-health-refresh"
          className="text-sm font-medium hover:underline disabled:opacity-50"
          style={{ color: "var(--accent)" }}
        >
          {loading ? "Actualizando…" : "Actualizar"}
        </button>
      </div>

      {error && <ErrorDisplay error={error} onRetry={fetchHealth} />}

      {loading && !data ? (
        <Skeleton />
      ) : data ? (
        <div className="space-y-8">
          <ConnectorHealthSection rows={data.connectors} />
          <PortalHealthSection rows={data.portals} />
          <SourceQualitySection rows={data.sources} />
          <StaleProfilesSection rows={data.stale_profiles} />
        </div>
      ) : null}
    </div>
  );
}
