import { getLlmUsageAggregates } from "@/lib/llm-usage-stats";
import { getDashboardLlmDisplayConfig } from "@/lib/llm-model-config";
import { getEffectiveDashboardModel } from "@/lib/llm-provider/config";
import {
  formatIntegerEs,
  formatTokensWithCompact,
  formatUsdEs,
} from "@/lib/usage-number-format";
import { getLlmHealth } from "@/lib/db/llm-health";
import { fetchSlowQueries } from "@/lib/admin-slow-queries";
import { LlmCostHealthSection } from "@/components/admin/LlmCostHealthSection";
import { SlowQueriesPanel } from "@/components/admin/SlowQueriesPanel";

export const metadata = {
  title: "LLM — Admin",
};

export const dynamic = "force-dynamic";

/**
 * Single consolidated LLM diagnostics page (#653/#636 Fase 0 borrado).
 *
 * Used to be a landing linking out to four separate routes (Consultas lentas,
 * Herramientas LLM, Uso LLM, Interacciones — #508). Two of those (Herramientas
 * LLM / `llm_tool_calls`, Interacciones / `llm_interactions`) are gone outright
 * — both tables have zero rows ever, in production, as of 2026-08-21 (see
 * #653). The other two — `llm_usage` (17,391 rows, live) and slow-queries
 * (`pg_stat_statements`, live) — merge into this one page: usage leads (it's
 * the one real diagnostics surface), the cost/coverage/scheduler panel from
 * the old "Salud de datos" LLM section follows, and slow queries sit at the
 * bottom as a collapsed disclosure (component reused; the query itself now
 * runs inline, server-side — no more client round trip to a route that only
 * this page ever called).
 *
 * `/admin/usage` and `/admin/slow-queries` are now dead routes (404 / 301 —
 * see their own files); `ADMIN_LLM_SUBPAGES` is gone from lib/admin-nav.ts.
 */
export default async function AdminLlmPage() {
  const [usage, llmHealth, slowQueries] = await Promise.all([
    getLlmUsageAggregates(),
    getLlmHealth(),
    fetchSlowQueries(),
  ]);
  const cfg = getDashboardLlmDisplayConfig();
  const orModelApi = cfg.provider === "openrouter" ? getEffectiveDashboardModel(cfg) : "";

  return (
    <div className="space-y-8" data-testid="admin-llm-page">
      <div>
        <h1 className="text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          LLM
        </h1>
        <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
          Uso del modelo (tokens/coste por proveedor y función), coste/cobertura
          de evaluación IA y consultas SQL lentas.
        </p>
      </div>

      {/* ─── Uso del modelo (llm_usage) ─────────────────────────────────── */}
      <div className="space-y-6">
        <section className="rounded-lg border border-tremor-border dark:border-dark-tremor-border p-4 text-sm">
          <h2 className="font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong">
            Configuración efectiva
          </h2>
          <dl className="mt-2 grid gap-1 text-tremor-content dark:text-dark-tremor-content sm:grid-cols-2">
            <div>
              <dt className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                Proveedor activo
              </dt>
              <dd className="font-mono">{cfg.provider}</dd>
            </div>
            <div>
              <dt className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                Driver CLI
              </dt>
              <dd className="font-mono">{cfg.provider === "cli" ? cfg.cliDriver : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                Modelo OpenRouter
              </dt>
              <dd className="font-mono text-xs break-all">{cfg.openrouterModel}</dd>
            </div>
            <div>
              <dt className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                Modelo CLI
              </dt>
              <dd className="font-mono text-xs break-all">{cfg.cliModel}</dd>
            </div>
          </dl>
        </section>

        <section className="grid gap-4 sm:grid-cols-3">
          {(["today", "week", "month"] as const).map((period) => {
            const p = usage[period];
            const tokens = formatTokensWithCompact(p.total_tokens);
            return (
              <div
                key={period}
                className="rounded-lg border border-tremor-border dark:border-dark-tremor-border p-4"
              >
                <h3 className="text-sm font-medium capitalize text-tremor-content dark:text-dark-tremor-content">
                  {period === "today" ? "Hoy" : period === "week" ? "7 días" : "30 días"}
                </h3>
                <p className="mt-2 text-2xl font-semibold tracking-tight">{tokens.primary}</p>
                <p className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                  ≈ {tokens.compact} tokens (compacto)
                </p>
                <p className="mt-1 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                  Entrada {formatIntegerEs(p.prompt_tokens)} · Salida{" "}
                  {formatIntegerEs(p.completion_tokens)}
                </p>
                <p className="mt-2 text-sm font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong">
                  {formatUsdEs(p.estimated_cost_usd)}{" "}
                  <span className="text-xs font-normal text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                    coste estimado (API)
                  </span>
                </p>
              </div>
            );
          })}
        </section>

        <section
          className="rounded-lg border border-amber-200/80 bg-amber-50/80 p-4 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
          role="note"
        >
          <p className="font-medium">Cómo se calcula el coste</p>
          <p className="mt-1 leading-relaxed">
            Las filas con proveedor <code className="rounded bg-black/5 px-1 dark:bg-white/10">openrouter</code>{" "}
            guardan tokens y un importe USD <strong>estimado</strong> (tabla de tarifas en código, alineada con el
            modelo OpenRouter <code className="rounded bg-black/5 px-1 dark:bg-white/10">{orModelApi}</code>
            ). <strong>No</strong> se consulta la facturación real de OpenRouter.
          </p>
          <p className="mt-2 leading-relaxed">
            Las filas con proveedor <code className="rounded bg-black/5 px-1 dark:bg-white/10">cli</code>{" "}
            (p. ej. Claude Code) registran tokens a cero y coste estimado <strong>0</strong>: la facturación puede
            ser plana por suscripción y no equivale al coste por token de la API.
          </p>
        </section>

        {usage.by_provider.length > 0 ? (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
              Por proveedor (histórico acumulado en base de datos)
            </h3>
            <div className="overflow-x-auto rounded-lg border border-tremor-border dark:border-dark-tremor-border">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-tremor-background-muted dark:bg-dark-tremor-background-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Proveedor</th>
                    <th className="px-3 py-2 font-medium">Llamadas</th>
                    <th className="px-3 py-2 font-medium">Tokens</th>
                    <th className="px-3 py-2 font-medium">Coste est.</th>
                    <th className="px-3 py-2 font-medium" title="cache_read / (prompt + cache_read) × 100">
                      Caché hits
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {usage.by_provider.map((row) => {
                    const tok = formatTokensWithCompact(row.total_tokens);
                    const hitRate =
                      row.cache_hit_rate_pct != null
                        ? `${row.cache_hit_rate_pct.toFixed(1)} %`
                        : "N/A";
                    return (
                      <tr
                        key={row.llm_provider}
                        className="border-t border-tremor-border dark:border-dark-tremor-border align-top"
                      >
                        <td className="px-3 py-2 font-mono text-xs">{row.llm_provider}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {formatIntegerEs(row.calls)}
                        </td>
                        <td className="px-3 py-2">
                          <span className="whitespace-nowrap font-medium">{tok.primary}</span>
                          <span className="mt-0.5 block text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                            ≈ {tok.compact}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {formatUsdEs(row.estimated_cost_usd)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {hitRate}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section>
          <h3 className="mb-2 text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            Por función
          </h3>
          <p className="mb-3 text-xs text-tremor-content dark:text-dark-tremor-content">
            La columna «Clave» es el identificador técnico enviado a la base de datos; la descripción resume qué
            pantalla o flujo del dashboard disparó la petición al modelo.
          </p>
          <div className="overflow-x-auto rounded-lg border border-tremor-border dark:border-dark-tremor-border">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-tremor-background-muted dark:bg-dark-tremor-background-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Función</th>
                  <th className="px-3 py-2 font-medium">Descripción</th>
                  <th className="px-3 py-2 font-medium">Clave</th>
                  <th className="px-3 py-2 font-medium">Llamadas</th>
                  <th className="px-3 py-2 font-medium">Tokens</th>
                  <th className="px-3 py-2 font-medium">Coste est.</th>
                </tr>
              </thead>
              <tbody>
                {usage.by_endpoint.map((row) => {
                  const tok = formatTokensWithCompact(row.total_tokens);
                  return (
                    <tr
                      key={row.endpoint}
                      className="border-t border-tremor-border dark:border-dark-tremor-border align-top"
                    >
                      <td className="px-3 py-2 font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong">
                        {row.endpoint_label_es}
                      </td>
                      <td className="max-w-md px-3 py-2 text-xs text-tremor-content dark:text-dark-tremor-content">
                        {row.endpoint_detail_es}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                        {row.endpoint}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{formatIntegerEs(row.calls)}</td>
                      <td className="px-3 py-2">
                        <span className="whitespace-nowrap font-medium">{tok.primary}</span>
                        <span className="mt-0.5 block text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                          ≈ {tok.compact}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{formatUsdEs(row.estimated_cost_usd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* ─── Coste/cobertura IA + regulador (moved from "Salud de datos") ── */}
      <LlmCostHealthSection data={llmHealth} />

      {/* ─── Consultas lentas (pg_stat_statements) — collapsed disclosure ── */}
      <SlowQueriesPanel data={slowQueries} />
    </div>
  );
}
