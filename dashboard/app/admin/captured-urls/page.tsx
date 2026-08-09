/**
 * Admin review surface for captured + observed search URLs from any capture
 * portal (issue #475/#488, part of #471; generalized to all capture portals in
 * #510).
 *
 * Lists the raw results-page URLs the owner captured via the browser extension's
 * "Capturar URL de búsqueda" action and the ones the passive observer forwarded
 * — verbatim, including any `shape=` drawn-zone param — so they can be copied and
 * decoded for the per-portal URL grammar work (#471 idealista, #514 altamira).
 *
 * Server component: reads directly via the DB helpers (like the other admin
 * pages), then hands the rows to the client {@link CapturedUrlsView} for the
 * portal filter chips + tables. Admin-gated by middleware (the `ps_admin`
 * cookie). Each DB read is wrapped so a missing table (un-migrated DB) or a
 * transient error degrades to the empty state rather than an error surface
 * (D-041).
 */

import { listCapturedSearchUrls, type CapturedSearchUrlRow } from "@/lib/db/captured-search-url";
import {
  listObservedSearchUrls,
  type ObservedSearchUrlRow,
} from "@/lib/db/observed-search-url";
import { ExtensionCta } from "@/components/extension/ExtensionCta";
import { CapturedUrlsView } from "./CapturedUrlsView";

export const metadata = {
  title: "URLs de búsqueda capturadas — Admin",
};

export const dynamic = "force-dynamic";

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

  return (
    <div className="space-y-6" data-testid="captured-urls-page">
      <h1 className="text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
        URLs de búsqueda capturadas
      </h1>

      <p className="text-sm text-tremor-content dark:text-dark-tremor-content">
        URLs de resultados capturadas con la extensión (acción{" "}
        <em>Capturar URL de búsqueda</em>) en los portales soportados (idealista,
        aliseda y altamira). Se guardan tal cual, incluido el parámetro{" "}
        <code className="rounded bg-tremor-background-subtle px-1 dark:bg-dark-tremor-background-subtle">
          shape=
        </code>{" "}
        de Idealista que codifica la zona dibujada (&quot;Dibuja tu zona&quot;) —
        la base para decodificar/re-codificar las gramáticas de URL de cada portal
        (#471, #514).
      </p>

      {/* Inline install/link CTA (#509): capturing search URLs needs the
          extension linked — shown only while it isn't. */}
      <ExtensionCta context="captured-urls" />

      <CapturedUrlsView captured={rows} observed={observed} />
    </div>
  );
}
