import type { ReactNode } from "react";
import { Card } from "@tremor/react";
import { getLlmEndpointMetaEs } from "@/lib/llm-endpoint-meta";
import type { LlmHealthResponse } from "@/lib/llm-health";

/**
 * LLM / IA — cost, usage and assessment-coverage panel (issue #324).
 *
 * Moved here verbatim from "Salud de datos" (`app/etl/salud/page.tsx`) as part
 * of #653/#636's Fase 0 borrado: the section leaves salud (shrinking it ahead
 * of #642) and joins the single `/admin/llm` page, next to `llm_usage`'s raw
 * per-provider/per-endpoint tables. Data source (`getLlmHealth()` /
 * `lib/db/llm-health.ts`) and every data-testid are unchanged so the existing
 * e2e (`e2e/llm-health.spec.ts`) only needed a URL change, not a rewrite.
 *
 * A pure server-renderable component (no hooks, no client fetch): the caller
 * awaits `getLlmHealth()` once and passes the result down, same pattern as
 * the slow-queries panel next to it on this page.
 */

// ─── Formatters (local — mirror the ones salud/page.tsx used for this section) ─

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

// ─── Small presentational bits ───────────────────────────────────────────────

function Badge({
  children,
  tone,
  testId,
}: {
  children: ReactNode;
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

function EmptyRow({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p
      data-testid={testId}
      className="text-sm text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
    >
      {children}
    </p>
  );
}

function Stat({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
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

export function LlmCostHealthSection({ data }: { data: LlmHealthResponse }) {
  const {
    flows,
    providers,
    cost,
    coverage,
    scheduler,
    errors,
    tokens_logged,
    cli_zero_usage_24h,
  } = data;

  const noUsage = flows.length === 0 && providers.length === 0;

  return (
    <section className="space-y-4" data-testid="llm-health">
      <div>
        <h2 className="text-lg font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          LLM / IA — coste y uso
        </h2>
        <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
          Volumen de llamadas, tokens y coste estimado (tokens × tarifa
          configurable; el proveedor CLI cuenta 0 € por suscripción), más la
          cobertura de evaluación IA y el estado del regulador.
        </p>
      </div>

      {/* F-8 zero-usage canary — most prominent element in the section when
          nonzero: it means every CLI cost/token figure below is currently
          wrong (the B1 failure mode from llm-cost-optimization.md returning). */}
      {cli_zero_usage_24h > 0 ? (
        <p
          className="rounded-md border p-3 text-sm font-semibold"
          style={{
            color: "var(--danger, #b91c1c)",
            borderColor: "var(--danger, #b91c1c)",
          }}
          data-testid="llm-cli-zero-usage-canary"
        >
          ⚠ {formatInt(cli_zero_usage_24h)} llamada
          {cli_zero_usage_24h === 1 ? "" : "s"} del proveedor CLI en las
          últimas 24h con 0 tokens registrados. El envoltorio de uso de{" "}
          <code>claude -p</code> puede haber cambiado de forma — el coste y
          los tokens del proveedor CLI en este panel pueden ser incorrectos
          (véase D-102).
        </p>
      ) : (
        <p
          className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
          data-testid="llm-cli-zero-usage-canary"
        >
          Canario CLI: 0 llamadas con 0 tokens en las últimas 24h — el
          medidor de uso del proveedor CLI funciona correctamente.
        </p>
      )}

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
