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
import { getLlmEndpointMetaEs } from "@/lib/llm-endpoint-meta";
import type { LlmHealthResponse } from "@/lib/llm-health";

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

function formatEur(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  // Sub-cent estimates would render as "0,00 €" and read as free; show more
  // precision for tiny (but non-zero) numbers so a real cost never looks like 0.
  const decimals = n > 0 && n < 0.1 ? 4 : 2;
  return `${n.toLocaleString("es-ES", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} €`;
}

function formatInt(n: number): string {
  return n.toLocaleString("es-ES");
}

function formatCoveragePct(fraction: number | null): string {
  if (fraction === null || Number.isNaN(fraction)) return "—";
  return `${Math.round(fraction * 100)}%`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return "—";
  if (seconds <= 0) return "al día";
  const m = Math.round(seconds / 60);
  if (m < 60) return `~${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `~${h} h`;
  return `~${Math.round(h / 24)} d`;
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

function StaleProfilesSection({
  rows,
  sweepInProgress,
}: {
  rows: StaleProfile[];
  sweepInProgress: boolean;
}) {
  return (
    <section className="space-y-3" data-testid="stale-profiles">
      <SectionTitle>Perfiles sin re-materializar</SectionTitle>
      {sweepInProgress ? (
        // During a sweep, last_seen_at is bumped before last_materialized_at
        // catches up, so staleness isn't trustworthy — mirror the reconciler
        // and don't flag anything (issue #285).
        <EmptyRow testId="stale-profiles-sweep">
          No evaluable durante una ejecución de conectores en curso.
        </EmptyRow>
      ) : rows.length === 0 ? (
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

// ─── LLM / IA cost + usage section (issue #324) ──────────────────────────────

function Stat({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card className="p-4" data-testid={testId}>
      <p className="text-xs text-tremor-content dark:text-dark-tremor-content">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-tremor-content-strong dark:text-dark-tremor-content-strong">
        {value}
      </p>
      {sub != null && (
        <p className="mt-1 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
          {sub}
        </p>
      )}
    </Card>
  );
}

function LlmHealthSection({ data }: { data: LlmHealthResponse }) {
  const {
    flows,
    providers,
    cost,
    coverage,
    scheduler,
    errors,
    tokens_logged,
  } = data;

  const noUsage = flows.length === 0 && providers.length === 0;

  return (
    <section className="space-y-4" data-testid="llm-health">
      <div>
        <SectionTitle>LLM / IA — coste y uso</SectionTitle>
        <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
          Volumen de llamadas, tokens y coste estimado (tokens × tarifa
          configurable; el proveedor CLI cuenta 0 € por suscripción), más la
          cobertura de evaluación IA y el estado del regulador.
        </p>
      </div>

      {/* Cost + calls summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          testId="llm-cost-today"
          label="Coste estimado (hoy)"
          value={tokens_logged ? formatEur(cost.cost_today_eur) : "—"}
        />
        <Stat
          testId="llm-cost-7d"
          label="Coste estimado (7d)"
          value={tokens_logged ? formatEur(cost.cost_7d_eur) : "—"}
        />
        <Stat
          testId="llm-calls-today"
          label="Llamadas (hoy)"
          value={formatInt(
            providers.reduce((s, p) => s + p.calls_today, 0),
          )}
        />
        <Stat
          testId="llm-calls-7d"
          label="Llamadas (7d)"
          value={formatInt(providers.reduce((s, p) => s + p.calls_7d, 0))}
        />
      </div>

      {!tokens_logged && (
        <p
          className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
          data-testid="llm-cost-note"
        >
          Aún no hay tokens registrados en <code>llm_usage</code>: el coste por
          token no es calculable todavía. Se muestran las llamadas registradas;
          el coste aparecerá en cuanto el pipeline LLM escriba uso.
        </p>
      )}

      {cost.unpriced_models.length > 0 && (
        <p
          className="text-xs"
          style={{ color: "var(--danger, #b91c1c)" }}
          data-testid="llm-unpriced"
        >
          Sin tarifa (coste no estimado): {cost.unpriced_models.join(", ")}.
          Añade su €/1M en <code>dashboard.llm_cost_rates_eur</code>.
        </p>
      )}

      {/* By flow */}
      <div className="space-y-2" data-testid="llm-by-flow">
        <h3 className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Por flujo
        </h3>
        {flows.length === 0 ? (
          <EmptyRow testId="llm-by-flow-empty">
            Sin llamadas registradas en los últimos 7 días.
          </EmptyRow>
        ) : (
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b" style={{ borderColor: "var(--border)" }}>
                    <th className="p-3 text-left font-medium text-tremor-content dark:text-dark-tremor-content">
                      Flujo
                    </th>
                    <th className="p-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content">
                      Llam. hoy
                    </th>
                    <th className="p-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content">
                      Llam. 7d
                    </th>
                    <th className="p-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content">
                      Tokens 7d
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {flows.map((f) => (
                    <tr
                      key={f.endpoint}
                      className="border-b last:border-0"
                      style={{ borderColor: "var(--border)" }}
                      data-testid={`llm-flow-${f.endpoint}`}
                    >
                      <td className="p-3 text-tremor-content-strong dark:text-dark-tremor-content-strong">
                        {getLlmEndpointMetaEs(f.endpoint).label}
                      </td>
                      <td className="p-3 text-right tabular-nums text-tremor-content-strong dark:text-dark-tremor-content-strong">
                        {formatInt(f.calls_today)}
                      </td>
                      <td className="p-3 text-right tabular-nums text-tremor-content-strong dark:text-dark-tremor-content-strong">
                        {formatInt(f.calls_7d)}
                      </td>
                      <td className="p-3 text-right tabular-nums text-tremor-content-strong dark:text-dark-tremor-content-strong">
                        {formatInt(f.tokens_7d)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {/* By provider */}
      <div className="space-y-2" data-testid="llm-by-provider">
        <h3 className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Por proveedor
        </h3>
        {providers.length === 0 ? (
          <EmptyRow testId="llm-by-provider-empty">
            Sin llamadas registradas en los últimos 7 días.
          </EmptyRow>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {providers.map((p) => (
              <Card
                key={p.provider}
                className="p-4"
                data-testid={`llm-provider-${p.provider}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
                    {p.provider}
                  </p>
                  {p.is_cli && (
                    <Badge tone="info" testId={`llm-provider-cli-${p.provider}`}>
                      Suscripción · 0 €
                    </Badge>
                  )}
                </div>
                <dl className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-tremor-content dark:text-dark-tremor-content">
                      Llamadas (hoy / 7d)
                    </dt>
                    <dd className="font-medium tabular-nums text-tremor-content-strong dark:text-dark-tremor-content-strong">
                      {formatInt(p.calls_today)} / {formatInt(p.calls_7d)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-tremor-content dark:text-dark-tremor-content">
                      Tokens (7d)
                    </dt>
                    <dd className="font-medium tabular-nums text-tremor-content-strong dark:text-dark-tremor-content-strong">
                      {formatInt(p.tokens_7d)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-tremor-content dark:text-dark-tremor-content">
                      Coste est. (7d)
                    </dt>
                    <dd
                      className="font-medium tabular-nums text-tremor-content-strong dark:text-dark-tremor-content-strong"
                      data-testid={`llm-provider-cost-${p.provider}`}
                    >
                      {p.is_cli ? "0 €" : tokens_logged ? formatEur(p.cost_7d_eur) : "—"}
                    </dd>
                  </div>
                </dl>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Assessment coverage / backlog */}
      <div className="space-y-2" data-testid="llm-coverage">
        <h3 className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Cobertura de evaluación IA
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            testId="llm-coverage-pct"
            label="Cobertura"
            value={formatCoveragePct(coverage.coverage_fraction)}
            sub={`${formatInt(coverage.covered)} de ${formatInt(coverage.eligible)} elegibles`}
          />
          <Stat
            testId="llm-coverage-pending"
            label="Pendientes"
            value={formatInt(coverage.pending)}
          />
          <Stat
            testId="llm-coverage-eta"
            label="Tiempo estimado"
            value={formatDuration(coverage.projected_seconds)}
            sub={
              coverage.projected_ticks === null
                ? "regulador detenido"
                : `${formatInt(coverage.projected_ticks)} ciclos`
            }
          />
          <Stat
            testId="llm-coverage-cost"
            label="Coste estimado backlog"
            value={
              coverage.projected_cost_eur === null
                ? "—"
                : formatEur(coverage.projected_cost_eur)
            }
            sub={
              coverage.avg_cost_eur_per_property === null
                ? "sin datos de coste"
                : `${formatEur(coverage.avg_cost_eur_per_property)} / inmueble`
            }
          />
        </div>
      </div>

      {/* Rate + kill switch */}
      <div className="space-y-2" data-testid="llm-scheduler">
        <h3 className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Regulador (evaluación IA)
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            testId="llm-scheduler-enabled"
            label="Interruptor"
            value={
              <Badge
                tone={scheduler.enabled ? "good" : "warn"}
                testId="llm-scheduler-enabled-badge"
              >
                {scheduler.enabled ? "Activo" : "Detenido"}
              </Badge>
            }
          />
          <Stat
            testId="llm-scheduler-batch"
            label="Lote por ciclo"
            value={formatInt(scheduler.batch_size)}
          />
          <Stat
            testId="llm-scheduler-interval"
            label="Cadencia"
            value={formatDuration(scheduler.interval_seconds)}
          />
          <Stat
            testId="llm-errors"
            label="Errores (hoy / 7d)"
            value={`${formatInt(errors.errors_today)} / ${formatInt(errors.errors_7d)}`}
            sub={
              errors.by_code.length > 0
                ? errors.by_code
                    .slice(0, 3)
                    .map((e) => `${e.code} (${e.count})`)
                    .join(", ")
                : "sin errores"
            }
          />
        </div>
      </div>

      {noUsage && (
        <EmptyRow testId="llm-health-empty">
          Sin datos aún: el pipeline LLM todavía no ha registrado uso.
        </EmptyRow>
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
  const [llm, setLlm] = useState<LlmHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Two independent read-only aggregates. The LLM panel is additive — a
      // failure there must not take down the capture/ETL health page, so its
      // error is swallowed (the section simply doesn't render) rather than
      // surfaced as a page-level error.
      const [res, llmRes] = await Promise.all([
        fetch("/api/etl/data-health"),
        fetch("/api/etl/llm-health").catch(() => null),
      ]);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "Error al cargar la salud de datos");
        return;
      }
      setData((await res.json()) as DataHealthResponse);
      if (llmRes && llmRes.ok) {
        setLlm((await llmRes.json()) as LlmHealthResponse);
      } else {
        setLlm(null);
      }
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
          <StaleProfilesSection
            rows={data.stale_profiles}
            sweepInProgress={data.sweep_in_progress}
          />
          {llm && <LlmHealthSection data={llm} />}
        </div>
      ) : null}
    </div>
  );
}
