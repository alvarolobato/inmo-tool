import { fetchToolCallAggregates } from "@/lib/llm-tools/logging";
import { formatIntegerEs } from "@/lib/usage-number-format";

export const metadata = {
  title: "Herramientas LLM — Admin",
};

export const dynamic = "force-dynamic";

function formatBytesEs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const x = Math.round(n);
  if (x < 1024) return `${formatIntegerEs(x)} B`;
  if (x < 1024 * 1024) return `${formatIntegerEs(Math.round(x / 1024))} KiB`;
  return `${formatIntegerEs(Math.round(x / (1024 * 1024)))} MiB`;
}

export default async function AdminToolCallsPage() {
  const rows = await fetchToolCallAggregates();

  let totalCalls = 0;
  let okCalls = 0;
  let errCalls = 0;
  for (const r of rows) {
    totalCalls += r.calls;
    if (r.status === "ok") okCalls += r.calls;
    else errCalls += r.calls;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
        Telemetría de herramientas (llm_tool_calls)
      </h1>

      <p className="text-sm text-tremor-content dark:text-dark-tremor-content">
        Ventana deslizante de <strong>30 días</strong>. Los totales de bytes son sumas aproximadas (PostgreSQL
        puede devolver <code className="rounded bg-tremor-background-subtle px-1">float8</code> en agregados
        grandes).
      </p>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-tremor-border dark:border-dark-tremor-border p-4">
          <h2 className="text-sm font-medium text-tremor-content dark:text-dark-tremor-content">
            Llamadas totales
          </h2>
          <p className="mt-2 text-2xl font-semibold tracking-tight">{formatIntegerEs(totalCalls)}</p>
        </div>
        <div className="rounded-lg border border-tremor-border dark:border-dark-tremor-border p-4">
          <h2 className="text-sm font-medium text-tremor-content dark:text-dark-tremor-content">Estado ok</h2>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-emerald-700 dark:text-emerald-400">
            {formatIntegerEs(okCalls)}
          </p>
        </div>
        <div className="rounded-lg border border-tremor-border dark:border-dark-tremor-border p-4">
          <h2 className="text-sm font-medium text-tremor-content dark:text-dark-tremor-content">Estado error</h2>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-red-700 dark:text-red-400">
            {formatIntegerEs(errCalls)}
          </p>
        </div>
      </section>

      <section
        className="rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background-muted/40 p-4 text-sm text-tremor-content dark:border-dark-tremor-border dark:bg-dark-tremor-background-muted/40 dark:text-dark-tremor-content"
        role="note"
      >
        <p>
          La misma información está disponible en JSON vía{" "}
          <code className="rounded bg-tremor-background-subtle px-1 dark:bg-dark-tremor-background-subtle">
            GET /api/admin/tool-calls
          </code>{" "}
          (cabecera <code className="rounded bg-tremor-background-subtle px-1">x-admin-key</code> o Bearer).
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Por endpoint, herramienta y estado
        </h2>
        <div className="overflow-x-auto rounded-lg border border-tremor-border dark:border-dark-tremor-border">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-tremor-background-muted dark:bg-dark-tremor-background-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Endpoint</th>
                <th className="px-3 py-2 font-medium">Herramienta</th>
                <th className="px-3 py-2 font-medium">Estado</th>
                <th className="px-3 py-2 font-medium">Llamadas</th>
                <th className="px-3 py-2 font-medium">Latencia media (ms)</th>
                <th className="px-3 py-2 font-medium">Payload entrada</th>
                <th className="px-3 py-2 font-medium">Payload salida</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-6 text-center text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
                  >
                    Sin datos en los últimos 30 días (o la tabla aún no existe en esta base).
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => (
                  <tr
                    key={`${r.endpoint}-${r.tool_name}-${r.status}-${i}`}
                    className="border-t border-tremor-border dark:border-dark-tremor-border"
                  >
                    <td className="px-3 py-2 font-mono text-xs text-tremor-content dark:text-dark-tremor-content">
                      {r.endpoint}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-tremor-content dark:text-dark-tremor-content">
                      {r.tool_name}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          r.status === "ok"
                            ? "rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200"
                            : "rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900 dark:bg-red-950/60 dark:text-red-200"
                        }
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{formatIntegerEs(r.calls)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {r.avg_latency_ms != null ? formatIntegerEs(r.avg_latency_ms) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{formatBytesEs(r.total_payload_in)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatBytesEs(r.total_payload_out)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
