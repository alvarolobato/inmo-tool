/**
 * Admin review surface for captured Idealista search URLs (issue #475, part of
 * #471).
 *
 * Lists the raw results-page URLs the owner captured via the browser
 * extension's "Capturar URL de búsqueda" action — verbatim, including the
 * `shape=` drawn-zone param — so they can be copied and decoded for #471 P1.
 *
 * Server component: reads directly via the DB helper (like the other admin
 * pages). Admin-gated by middleware (the `ps_admin` cookie). The DB read is
 * wrapped so a missing table (un-migrated DB) or a transient error degrades to
 * the empty state rather than an error surface (D-041).
 */

import { listCapturedSearchUrls, type CapturedSearchUrlRow } from "@/lib/db/captured-search-url";
import {
  listObservedSearchUrls,
  type ObservedSearchUrlRow,
} from "@/lib/db/observed-search-url";
import { observedUrlType, shapeVertexCount } from "@/lib/observed-search-url";

export const metadata = {
  title: "URLs de búsqueda capturadas — Admin",
};

export const dynamic = "force-dynamic";

function formatDateEs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/** True when the URL carries the drawn-zone polygon param ("Dibuja tu zona"). */
function hasShapeParam(url: string): boolean {
  try {
    return new URL(url).searchParams.has("shape");
  } catch {
    return false;
  }
}

/** Tailwind classes for each observed-URL type badge. */
const TYPE_BADGE: Record<string, string> = {
  areas: "bg-indigo-100 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-200",
  multi: "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  plana: "bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-200",
};

export default async function AdminCapturedUrlsPage() {
  let rows: CapturedSearchUrlRow[] = [];
  try {
    rows = await listCapturedSearchUrls();
  } catch {
    // Un-migrated DB or transient error → empty state, never an error surface.
    rows = [];
  }

  let observed: ObservedSearchUrlRow[] = [];
  try {
    observed = await listObservedSearchUrls();
  } catch {
    // Un-migrated DB or transient error → empty state, never an error surface.
    observed = [];
  }

  const withShape = rows.filter((r) => hasShapeParam(r.url)).length;

  return (
    <div className="space-y-6" data-testid="captured-urls-page">
      <h1 className="text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
        URLs de búsqueda capturadas
      </h1>

      <p className="text-sm text-tremor-content dark:text-dark-tremor-content">
        URLs de resultados de Idealista capturadas con la extensión (acción{" "}
        <em>Capturar URL de búsqueda</em>). Se guardan tal cual, incluido el
        parámetro{" "}
        <code className="rounded bg-tremor-background-subtle px-1 dark:bg-dark-tremor-background-subtle">
          shape=
        </code>{" "}
        que codifica la zona dibujada (&quot;Dibuja tu zona&quot;) — la base para
        decodificar/re-codificar zonas geográficas (#471).
      </p>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-tremor-border dark:border-dark-tremor-border p-4">
          <h2 className="text-sm font-medium text-tremor-content dark:text-dark-tremor-content">
            URLs capturadas
          </h2>
          <p className="mt-2 text-2xl font-semibold tracking-tight" data-testid="captured-urls-total">
            {rows.length}
          </p>
        </div>
        <div className="rounded-lg border border-tremor-border dark:border-dark-tremor-border p-4">
          <h2 className="text-sm font-medium text-tremor-content dark:text-dark-tremor-content">
            Con zona dibujada (shape=)
          </h2>
          <p className="mt-2 text-2xl font-semibold tracking-tight">{withShape}</p>
        </div>
      </section>

      <section
        className="rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background-muted/40 p-4 text-sm text-tremor-content dark:border-dark-tremor-border dark:bg-dark-tremor-background-muted/40 dark:text-dark-tremor-content"
        role="note"
      >
        <p>
          La misma información está disponible en JSON vía{" "}
          <code className="rounded bg-tremor-background-subtle px-1 dark:bg-dark-tremor-background-subtle">
            GET /api/captured-search-urls
          </code>{" "}
          (cabecera <code className="rounded bg-tremor-background-subtle px-1">x-admin-key</code> o Bearer).
        </p>
      </section>

      <section>
        <div className="overflow-x-auto rounded-lg border border-tremor-border dark:border-dark-tremor-border">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-tremor-background-muted dark:bg-dark-tremor-background-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Capturada</th>
                <th className="px-3 py-2 font-medium">Portal</th>
                <th className="px-3 py-2 font-medium">Zona</th>
                <th className="px-3 py-2 font-medium">Título</th>
                <th className="px-3 py-2 font-medium">URL</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-6 text-center text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
                    data-testid="captured-urls-empty"
                  >
                    Aún no se ha capturado ninguna URL de búsqueda. Usa la acción
                    &quot;Capturar URL de búsqueda&quot; de la extensión en una
                    página de resultados de Idealista.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-tremor-border dark:border-dark-tremor-border align-top"
                    data-testid="captured-url-row"
                  >
                    <td className="whitespace-nowrap px-3 py-2 text-tremor-content dark:text-dark-tremor-content">
                      {formatDateEs(r.captured_at)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{r.portal}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {hasShapeParam(r.url) ? (
                        <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
                          shape
                        </span>
                      ) : (
                        <span className="text-tremor-content-subtle dark:text-dark-tremor-content-subtle">—</span>
                      )}
                    </td>
                    <td className="max-w-xs px-3 py-2 text-tremor-content dark:text-dark-tremor-content">
                      {r.title || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block max-w-2xl break-all font-mono text-xs text-blue-700 hover:underline dark:text-blue-400"
                        data-testid="captured-url-link"
                      >
                        {r.url}
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4 pt-4" data-testid="observed-urls-section">
        <h2 className="text-lg font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          URLs de búsqueda observadas
        </h2>
        <p className="text-sm text-tremor-content dark:text-dark-tremor-content">
          URLs de resultados de Idealista que la extensión reenvía{" "}
          <em>pasivamente</em> mientras navegas (modo observación) — para analizar
          los patrones de filtrado en bloque (#471). Se deduplican por búsqueda:
          cada fila muestra cuántas veces se ha visto, su tipo (areas / multi /
          plana) y, si lleva zona dibujada, el nº de vértices decodificado.
        </p>

        <div className="rounded-lg border border-tremor-border dark:border-dark-tremor-border p-4 sm:max-w-xs">
          <h3 className="text-sm font-medium text-tremor-content dark:text-dark-tremor-content">
            URLs observadas (distintas)
          </h3>
          <p className="mt-2 text-2xl font-semibold tracking-tight" data-testid="observed-urls-total">
            {observed.length}
          </p>
        </div>

        <div className="overflow-x-auto rounded-lg border border-tremor-border dark:border-dark-tremor-border">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-tremor-background-muted dark:bg-dark-tremor-background-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Última vez</th>
                <th className="px-3 py-2 font-medium">Veces</th>
                <th className="px-3 py-2 font-medium">Tipo</th>
                <th className="px-3 py-2 font-medium">Vértices</th>
                <th className="px-3 py-2 font-medium">Título</th>
                <th className="px-3 py-2 font-medium">URL</th>
              </tr>
            </thead>
            <tbody>
              {observed.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-6 text-center text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
                    data-testid="observed-urls-empty"
                  >
                    Aún no se ha observado ninguna URL de búsqueda. Activa el
                    &quot;modo observación&quot; en la extensión y navega por
                    páginas de resultados de Idealista.
                  </td>
                </tr>
              ) : (
                observed.map((r) => {
                  const type = observedUrlType(r.url);
                  const vertices = shapeVertexCount(r.url);
                  return (
                    <tr
                      key={r.id}
                      className="border-t border-tremor-border dark:border-dark-tremor-border align-top"
                      data-testid="observed-url-row"
                    >
                      <td className="whitespace-nowrap px-3 py-2 text-tremor-content dark:text-dark-tremor-content">
                        {formatDateEs(r.last_seen)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.seen_count}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium ${TYPE_BADGE[type] ?? TYPE_BADGE.plana}`}
                          data-testid="observed-url-type"
                        >
                          {type}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums" data-testid="observed-url-vertices">
                        {vertices == null ? (
                          <span className="text-tremor-content-subtle dark:text-dark-tremor-content-subtle">—</span>
                        ) : (
                          vertices
                        )}
                      </td>
                      <td className="max-w-xs px-3 py-2 text-tremor-content dark:text-dark-tremor-content">
                        {r.title || "—"}
                      </td>
                      <td className="px-3 py-2">
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block max-w-2xl break-all font-mono text-xs text-blue-700 hover:underline dark:text-blue-400"
                          data-testid="observed-url-link"
                        >
                          {r.url}
                        </a>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <section
          className="rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background-muted/40 p-4 text-sm text-tremor-content dark:border-dark-tremor-border dark:bg-dark-tremor-background-muted/40 dark:text-dark-tremor-content"
          role="note"
        >
          <p>
            La misma información está disponible en JSON vía{" "}
            <code className="rounded bg-tremor-background-subtle px-1 dark:bg-dark-tremor-background-subtle">
              GET /api/observed-search-urls
            </code>{" "}
            (cabecera <code className="rounded bg-tremor-background-subtle px-1">x-admin-key</code> o Bearer).
          </p>
        </section>
      </section>
    </div>
  );
}
