"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@tremor/react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import { withDiscoverSignal } from "@/lib/extension-discover";
import { canonicalPropertyType } from "@/lib/search-url/discovered-mapping";
import type { CatalogOption } from "@/lib/search-url/discovered-mapping";
import type { PortalDriftReport } from "@/lib/search-url/drift";

/**
 * URL-building discovery admin page (issue #336, D-063).
 *
 * The operator picks a connector and clicks "Iniciar descubrimiento": we open
 * the portal's search page in a new tab tagged with `#inmo-discover`, so the
 * browser extension (running on the owner's authenticated session) enumerates
 * the search form's filter OPTIONS + the URL each produces and POSTs the catalog
 * back (POST /api/extension/filter-catalog). This page then shows the LAST
 * discovered catalog for the connector, with each property-type option mapped to
 * our canonical type, PLUS a deterministic DRIFT report (issue #371, D-090):
 * options the portal ADDED that the code doesn't map, options the code maps that
 * the portal REMOVED, and options whose subtipo/label CHANGED. URL building is
 * code-driven — this page flags drift so the OWNER updates the code by hand; it
 * does not self-heal.
 *
 * Admin-gated by middleware (`/etl/:path*` UI + `/api/etl/:path*` API), same as
 * the rest of the ETL tooling — no middleware change.
 */

/** Connectors wired for URL-building discovery, with their search-page entry point. */
const DISCOVERY_CONNECTORS: ReadonlyArray<{
  connector: string;
  label: string;
  searchUrl: string;
}> = [
  {
    connector: "aliseda",
    label: "Aliseda",
    searchUrl: "https://www.alisedainmobiliaria.com/comprar-viviendas",
  },
];

interface CatalogResponse {
  connector: string;
  source: string;
  captured_at: string;
  axes: Partial<Record<string, CatalogOption[]>>;
  axis_summary: Record<string, number>;
  options_count: number;
  drift: PortalDriftReport | null;
}

export default function DiscoveryPage() {
  const [connector, setConnector] = useState(DISCOVERY_CONNECTORS[0].connector);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [empty, setEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  const selected = DISCOVERY_CONNECTORS.find((c) => c.connector === connector);

  const fetchCatalog = useCallback(async (name: string) => {
    setLoading(true);
    setError(null);
    setCatalog(null);
    setEmpty(false);
    try {
      const res = await fetch(`/api/etl/discovery/${encodeURIComponent(name)}`);
      if (res.status === 404) {
        setEmpty(true);
        return;
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        setError(isApiErrorResponse(errBody) ? errBody : "Error al cargar el catálogo");
        return;
      }
      setCatalog(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar el catálogo");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCatalog(connector);
  }, [connector, fetchCatalog]);

  const startDiscovery = useCallback(() => {
    if (!selected) return;
    // Open the portal search page tagged with the discovery signal; the
    // extension picks it up and runs the enumeration pass.
    window.open(withDiscoverSignal(selected.searchUrl), "_blank", "noopener");
  }, [selected]);

  const propertyTypeOptions = catalog?.axes?.property_type ?? [];
  const drift = catalog?.drift ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6" data-testid="discovery-page">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Descubrimiento de URLs
        </h1>
        <p className="text-tremor-content dark:text-dark-tremor-content">
          Aprende del propio portal cómo construir las URLs de búsqueda (tipo de
          inmueble, subtipo, zona…) en lugar de mantener el mapeo a mano.
        </p>
      </header>

      {error && <ErrorDisplay error={error} />}

      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong">
              Conector
            </span>
            <select
              data-testid="discovery-connector-select"
              value={connector}
              onChange={(e) => setConnector(e.target.value)}
              className="rounded-md border border-tremor-border bg-tremor-background px-3 py-2 text-sm text-tremor-content-strong dark:border-dark-tremor-border dark:bg-dark-tremor-background dark:text-dark-tremor-content-strong"
            >
              {DISCOVERY_CONNECTORS.map((c) => (
                <option key={c.connector} value={c.connector}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            data-testid="start-discovery"
            onClick={startDiscovery}
            className="rounded-md bg-tremor-brand px-4 py-2 text-sm font-medium text-tremor-brand-inverted transition hover:bg-tremor-brand-emphasis"
          >
            Iniciar descubrimiento
          </button>
        </div>
        <p className="mt-3 text-xs text-tremor-content dark:text-dark-tremor-content">
          Abre la página de búsqueda del portal en una pestaña nueva con la señal{" "}
          <code>#inmo-discover</code>. La extensión enumera las opciones del
          formulario y envía el catálogo automáticamente.
        </p>
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Último catálogo descubierto
        </h2>

        {loading && (
          <p data-testid="discovery-loading" className="text-tremor-content dark:text-dark-tremor-content">
            Cargando…
          </p>
        )}

        {!loading && empty && (
          <p data-testid="discovery-empty" className="text-tremor-content dark:text-dark-tremor-content">
            Todavía no se ha descubierto ningún catálogo para «{connector}». Pulsa
            «Iniciar descubrimiento» y ejecuta la extensión en la página del portal.
          </p>
        )}

        {!loading && catalog && (
          <div data-testid="discovery-catalog" className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-tremor-content dark:text-dark-tremor-content">Origen</dt>
                <dd data-testid="catalog-source" className="font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong">
                  {catalog.source}
                </dd>
              </div>
              <div>
                <dt className="text-tremor-content dark:text-dark-tremor-content">Opciones</dt>
                <dd data-testid="catalog-options-count" className="font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong">
                  {catalog.options_count}
                </dd>
              </div>
              <div>
                <dt className="text-tremor-content dark:text-dark-tremor-content">Capturado</dt>
                <dd className="font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong">
                  {new Date(catalog.captured_at).toLocaleString("es-ES")}
                </dd>
              </div>
            </dl>

            {drift && <DriftReport drift={drift} />}

            {propertyTypeOptions.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm" data-testid="property-type-table">
                  <thead>
                    <tr className="border-b border-tremor-border text-tremor-content dark:border-dark-tremor-border dark:text-dark-tremor-content">
                      <th className="py-2 pr-4 font-medium">Etiqueta del portal</th>
                      <th className="py-2 pr-4 font-medium">Tipo canónico</th>
                      <th className="py-2 pr-4 font-medium">Fragmento URL</th>
                      <th className="py-2 pr-4 font-medium">subtipo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {propertyTypeOptions.map((opt, i) => {
                      const canonical = canonicalPropertyType(opt.label);
                      return (
                        <tr
                          key={`${opt.label}-${i}`}
                          className="border-b border-tremor-border/50 dark:border-dark-tremor-border/50"
                        >
                          <td className="py-1.5 pr-4 text-tremor-content-strong dark:text-dark-tremor-content-strong">
                            {opt.label}
                          </td>
                          <td className="py-1.5 pr-4">
                            {canonical ? (
                              <span className="font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong">
                                {canonical}
                              </span>
                            ) : (
                              <span className="text-tremor-content dark:text-dark-tremor-content">
                                (sin mapeo)
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-4 font-mono text-xs text-tremor-content dark:text-dark-tremor-content">
                            {opt.urlFragment}
                          </td>
                          <td className="py-1.5 pr-4 text-tremor-content dark:text-dark-tremor-content">
                            {typeof opt.subtipo === "number" ? opt.subtipo : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * The deterministic drift report (issue #371, D-090): a clear per-portal
 * "the code needs updating" flag. Green "sin deriva" when the captured catalog
 * matches the code mapping; a red banner listing ADDED / REMOVED / CHANGED
 * options otherwise — actionable enough for the owner to edit the code map.
 */
function DriftReport({ drift }: { drift: PortalDriftReport }) {
  const totals = drift.axes.reduce(
    (acc, a) => ({
      added: acc.added + a.added.length,
      removed: acc.removed + a.removed.length,
      changed: acc.changed + a.changed.length,
    }),
    { added: 0, removed: 0, changed: 0 },
  );

  if (!drift.hasDrift) {
    return (
      <div
        data-testid="discovery-drift"
        data-drift="false"
        className="rounded-md border border-emerald-500/40 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-950/40 dark:text-emerald-200"
      >
        <span data-testid="discovery-drift-none" className="font-medium">
          Sin deriva: el catálogo del portal coincide con el mapeo del código.
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="discovery-drift"
      data-drift="true"
      className="space-y-3 rounded-md border border-rose-500/40 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-400/30 dark:bg-rose-950/40 dark:text-rose-100"
    >
      <p data-testid="discovery-drift-flag" className="font-semibold">
        Deriva detectada — actualiza el mapeo del código de «{drift.connector}» (
        {totals.added} nuevo(s), {totals.removed} retirado(s), {totals.changed} cambiado(s)).
      </p>
      {drift.axes.map((axis) => {
        if (
          axis.added.length === 0 &&
          axis.removed.length === 0 &&
          axis.changed.length === 0
        ) {
          return null;
        }
        return (
          <div key={axis.axis} className="space-y-1" data-testid={`drift-axis-${axis.axis}`}>
            <p className="font-mono text-xs uppercase tracking-wide opacity-70">{axis.axis}</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {axis.added.map((it) => (
                <li key={`a-${it.slug}`} data-testid="drift-added">
                  <strong>Nuevo tipo</strong> «{it.portalLabel ?? it.slug}» (
                  <code className="font-mono text-xs">{it.slug}</code>
                  {typeof it.portalCode === "number" ? `, subtipo ${it.portalCode}` : ""}) que el
                  código no mapea.
                </li>
              ))}
              {axis.removed.map((it) => (
                <li key={`r-${it.slug}`} data-testid="drift-removed">
                  <strong>Ya no existe</strong> «{it.codeLabel ?? it.slug}» (
                  <code className="font-mono text-xs">{it.slug}</code>): el código lo mapea pero el
                  portal ya no lo ofrece.
                </li>
              ))}
              {axis.changed.map((it) => (
                <li key={`c-${it.slug}`} data-testid="drift-changed">
                  <strong>Cambiado</strong> «{it.portalLabel ?? it.slug}» (
                  <code className="font-mono text-xs">{it.slug}</code>): {it.reason}.
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
