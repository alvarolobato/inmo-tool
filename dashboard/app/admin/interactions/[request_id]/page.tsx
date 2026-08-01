import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db-write";
import type { InteractionRow } from "@/app/api/dashboard/[id]/interactions/route";
import type { InteractionLine } from "@/lib/db-write";
import { interactionLineClass } from "@/lib/interaction-line-class";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ request_id: string }> };

export async function generateMetadata({ params }: PageProps) {
  const { request_id } = await params;
  return { title: `Interacción ${request_id.slice(0, 16)}… — Admin` };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusBadge(status: string): string {
  switch (status) {
    case "completed":
      return "rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200";
    case "error":
      return "rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900 dark:bg-red-950/60 dark:text-red-200";
    default:
      return "rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-200";
  }
}


function formatDateEs(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function InteractionDetailPage({ params }: PageProps) {
  const { request_id } = await params;

  // Validate request_id is a non-empty string without path separators
  if (!request_id || request_id.includes("/") || request_id.length > 256) {
    notFound();
  }

  let row: InteractionRow | null = null;
  try {
    const rows = await sql<InteractionRow>(
      `SELECT
         id, request_id, endpoint, dashboard_id,
         prompt, final_output, lines,
         llm_provider, llm_driver,
         started_at, finished_at, status
       FROM llm_interactions
       WHERE request_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [request_id],
    );
    row = rows[0] ?? null;
  } catch (err) {
    console.error("[admin/interactions/[request_id]]", err);
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-100">
        Error al cargar la interacción.
      </div>
    );
  }

  if (!row) {
    notFound();
  }

  const lines: InteractionLine[] = Array.isArray(row.lines) ? row.lines : [];

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="text-sm text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
        <Link href="/admin/interactions" className="hover:underline">
          Interacciones
        </Link>
        {" / "}
        <span className="font-mono">{row.request_id.slice(0, 20)}…</span>
      </nav>

      <h1 className="text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
        Detalle de interacción
      </h1>

      {/* Metadata grid */}
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {(
          [
            ["Endpoint", row.endpoint],
            ["Estado", <span key="status" className={statusBadge(row.status)}>{row.status}</span>],
            ["Dashboard ID", row.dashboard_id ?? "—"],
            ["Proveedor", [row.llm_provider, row.llm_driver].filter(Boolean).join(" / ") || "—"],
            ["Inicio", formatDateEs(row.started_at)],
            ["Fin", formatDateEs(row.finished_at)],
            ["Request ID", <span key="rid" className="font-mono text-xs">{row.request_id}</span>],
            ["UUID", <span key="uuid" className="font-mono text-xs">{row.id}</span>],
          ] as Array<[string, React.ReactNode]>
        ).map(([label, value]) => (
          <div key={label} className="rounded-lg border border-tremor-border dark:border-dark-tremor-border p-3">
            <dt className="text-xs font-medium text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              {label}
            </dt>
            <dd className="mt-1 text-sm text-tremor-content-strong dark:text-dark-tremor-content-strong">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Prompt */}
      <section className="space-y-1">
        <h2 className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Prompt
        </h2>
        <pre className="whitespace-pre-wrap break-words rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background-muted/80 dark:bg-dark-tremor-background-muted/50 p-3 text-xs text-tremor-content dark:text-dark-tremor-content">
          {row.prompt}
        </pre>
      </section>

      {/* Lines */}
      <section className="space-y-1">
        <h2 className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Log ({lines.length} líneas)
        </h2>
        <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background-muted/80 dark:bg-dark-tremor-background-muted/50 p-3 text-xs leading-relaxed space-y-0.5">
          {lines.length === 0 ? (
            <span className="italic text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              Sin líneas registradas.
            </span>
          ) : (
            lines.map((l, i) => (
              <div key={i} className={`whitespace-pre-wrap break-words ${interactionLineClass(l.kind)}`}>
                {l.ts ? (
                  <span className="mr-2 text-tremor-content-subtle dark:text-dark-tremor-content-subtle select-none">
                    {new Date(l.ts).toLocaleTimeString("es-ES")}
                  </span>
                ) : null}
                {l.text}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Final output */}
      {row.final_output ? (
        <section className="space-y-1">
          <h2 className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            Salida final
          </h2>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background-muted/80 dark:bg-dark-tremor-background-muted/50 p-3 text-xs text-tremor-content dark:text-dark-tremor-content">
            {row.final_output.length > 4000
              ? row.final_output.slice(0, 4000) + "\n… (truncado)"
              : row.final_output}
          </pre>
        </section>
      ) : null}
    </div>
  );
}
