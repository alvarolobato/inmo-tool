import Link from "next/link";
import { sql } from "@/lib/db-write";
import type { InteractionRow } from "@/app/api/dashboard/[id]/interactions/route";

export const metadata = {
  title: "Interacciones LLM — Admin",
};

export const dynamic = "force-dynamic";

// ─── Search-param filtering ──────────────────────────────────────────────────

type FilterParams = {
  endpoint?: string;
  status?: string;
  dashboard_id?: string;
};

function statusBadge(status: string): string {
  switch (status) {
    case "completed":
      return "rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200";
    case "error":
      return "rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900 dark:bg-red-950/60 dark:text-red-200";
    case "running":
    default:
      return "rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-200";
  }
}

function endpointBadge(endpoint: string): string {
  switch (endpoint) {
    case "generate":
      return "rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-900 dark:bg-blue-950/60 dark:text-blue-200";
    case "modify":
      return "rounded bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-900 dark:bg-violet-950/60 dark:text-violet-200";
    case "analyze":
    default:
      return "rounded bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-900 dark:bg-teal-950/60 dark:text-teal-200";
  }
}

async function fetchInteractions(filters: FilterParams): Promise<InteractionRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.endpoint) {
    conditions.push(`endpoint = $${idx++}`);
    params.push(filters.endpoint);
  }
  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters.dashboard_id) {
    const n = parseInt(filters.dashboard_id, 10);
    if (!Number.isNaN(n) && n > 0) {
      conditions.push(`dashboard_id = $${idx++}`);
      params.push(n);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return sql<InteractionRow>(
    `SELECT
       id, request_id, endpoint, dashboard_id,
       prompt, final_output, lines,
       llm_provider, llm_driver,
       started_at, finished_at, status
     FROM llm_interactions
     ${where}
     ORDER BY started_at DESC
     LIMIT 50`,
    params,
  );
}

function formatDateEs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function AdminInteractionsPage({
  searchParams,
}: {
  searchParams: Promise<FilterParams>;
}) {
  const filters = await searchParams;
  let rows: InteractionRow[] = [];
  let dbError: string | null = null;

  try {
    rows = await fetchInteractions(filters);
  } catch (err) {
    dbError =
      err instanceof Error ? err.message : "Error desconocido al cargar interacciones";
    console.error("[admin/interactions]", err);
  }

  const filterLinks: Array<{ label: string; href: string; active: boolean }> = [
    { label: "Todos", href: "/admin/interactions", active: !filters.endpoint && !filters.status },
    {
      label: "Generate",
      href: "/admin/interactions?endpoint=generate",
      active: filters.endpoint === "generate",
    },
    {
      label: "Modify",
      href: "/admin/interactions?endpoint=modify",
      active: filters.endpoint === "modify",
    },
    {
      label: "Analyze",
      href: "/admin/interactions?endpoint=analyze",
      active: filters.endpoint === "analyze",
    },
    {
      label: "Errores",
      href: "/admin/interactions?status=error",
      active: filters.status === "error",
    },
    {
      label: "En curso",
      href: "/admin/interactions?status=running",
      active: filters.status === "running",
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
        Interacciones LLM
      </h1>

      <p className="text-sm text-tremor-content dark:text-dark-tremor-content">
        Últimas 50 interacciones con el modelo ({rows.length} mostradas). Click en el{" "}
        <code className="rounded bg-tremor-background-subtle px-1">request_id</code> para ver el
        log completo.
      </p>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {filterLinks.map((f) => (
          <Link
            key={f.href}
            href={f.href}
            className={
              f.active
                ? "rounded-full px-3 py-1.5 text-xs font-medium text-white hover:brightness-110"
                : "rounded-full border px-3 py-1.5 text-xs font-medium hover:brightness-110"
            }
            style={
              f.active
                ? { background: "var(--accent)" }
                : {
                    background: "var(--bg-2)",
                    borderColor: "var(--border)",
                    color: "var(--fg)",
                  }
            }
          >
            {f.label}
          </Link>
        ))}
      </div>

      {dbError ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-100">
          {dbError}
          <p className="mt-1 text-xs opacity-70">
            (La tabla <code>llm_interactions</code> puede no existir aún — aplica las migraciones de la
            base de datos.)
          </p>
        </div>
      ) : (
        <section className="overflow-x-auto rounded-lg border border-tremor-border dark:border-dark-tremor-border">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-tremor-background-muted dark:bg-dark-tremor-background-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Request ID</th>
                <th className="px-3 py-2 font-medium">Endpoint</th>
                <th className="px-3 py-2 font-medium">Estado</th>
                <th className="px-3 py-2 font-medium">Dashboard</th>
                <th className="px-3 py-2 font-medium">Prompt</th>
                <th className="px-3 py-2 font-medium">Proveedor</th>
                <th className="px-3 py-2 font-medium">Inicio</th>
                <th className="px-3 py-2 font-medium">Fin</th>
                <th className="px-3 py-2 font-medium">Líneas</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-6 text-center text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
                  >
                    Sin interacciones registradas.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-tremor-border dark:border-dark-tremor-border"
                  >
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        href={`/admin/interactions/${r.request_id}`}
                        className="text-blue-500 hover:underline"
                      >
                        {r.request_id.slice(0, 16)}…
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <span className={endpointBadge(r.endpoint)}>{r.endpoint}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={statusBadge(r.status)}>{r.status}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                      {r.dashboard_id ?? "—"}
                    </td>
                    <td
                      className="max-w-[20rem] overflow-hidden text-ellipsis whitespace-nowrap px-3 py-2 text-xs text-tremor-content dark:text-dark-tremor-content"
                      title={r.prompt}
                    >
                      {r.prompt.slice(0, 80)}
                      {r.prompt.length > 80 ? "…" : ""}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                      {r.llm_provider ?? "—"}
                      {r.llm_driver ? ` / ${r.llm_driver}` : ""}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                      {formatDateEs(r.started_at)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                      {formatDateEs(r.finished_at)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                      {Array.isArray(r.lines) ? r.lines.length : 0}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
