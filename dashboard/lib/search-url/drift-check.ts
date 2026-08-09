/**
 * Portal filter-drift check — shared server helper (issue #377/#511, D-093).
 *
 * The aliseda static-asset drift check used to be a manual button on the
 * Descubrimiento admin tab. #511 retired that tab and moved the check to two
 * callers that both live here so they can't diverge:
 *   - the weekly in-process scheduler (lib/search-url/drift-scheduler.ts), and
 *   - the "Comprobar ahora" button + the "Deriva de portales" section on Salud
 *     de datos (via GET /api/etl/drift-reports and the existing
 *     POST /api/etl/discovery/:connector/refresh route).
 *
 * URL building stays 100% code-driven (D-090) — this only DETECTS drift between
 * the portal's live catalog and the hard-coded code mapping, for the owner to
 * fix in code by hand. Server-only (imports lib/db-write via the catalog helper).
 */

import { extractAlisedaStaticCatalog } from "@/lib/search-url/aliseda-static";
import { findLatestCatalog, saveFilterCatalog } from "@/lib/db/portal-filter-catalog";
import { codeMappingForPortal } from "@/lib/search-url";
import { computePortalDrift, type PortalDriftReport } from "@/lib/search-url/drift";
import type { CatalogAxes } from "@/lib/search-url/discovered-mapping";

/** Connectors with a server-side static-asset extractor (only aliseda today). */
export const STATIC_EXTRACTORS: Record<
  string,
  () => Promise<{ axes: CatalogAxes; bundleUrl?: string }>
> = {
  aliseda: () => extractAlisedaStaticCatalog(),
};

/** The portals the scheduled drift check + the Salud section iterate over. */
export const DRIFT_CHECK_PORTALS: readonly string[] = Object.keys(STATIC_EXTRACTORS);

/** Result of running one drift check (echoed by the refresh route). */
export interface DriftCheckResult {
  connector: string;
  source: "static-asset";
  capturedAt: string;
  bundleUrl?: string;
  optionsCount: number;
  drift: PortalDriftReport | null;
}

/**
 * Run the static-asset extractor for one connector, persist the catalog, and
 * return the freshly computed drift vs. the code mapping. Throws on an
 * unknown connector or a fetch/parse/DB failure — callers decide how to surface
 * it (the route → 400/502/500; the scheduler → swallow + log).
 */
export async function runDriftCheck(connector: string): Promise<DriftCheckResult> {
  const extractor = STATIC_EXTRACTORS[connector];
  if (!extractor) {
    throw new Error(`El conector «${connector}» no tiene un extractor de activos estáticos.`);
  }

  const { axes, bundleUrl } = await extractor();
  const capturedAt = new Date().toISOString();
  const saved = await saveFilterCatalog({ connector, source: "static-asset", axes, capturedAt });

  const codeMapping = codeMappingForPortal(connector);
  const drift = codeMapping ? computePortalDrift(connector, axes, codeMapping) : null;

  return {
    connector,
    source: "static-asset",
    capturedAt,
    bundleUrl,
    optionsCount: saved.optionsCount,
    drift,
  };
}

/** The latest drift status for one configured portal (for the Salud section). */
export interface PortalDriftStatus {
  connector: string;
  /** When the latest catalog was captured, or null if none exists yet. */
  capturedAt: string | null;
  /** Where the latest catalog came from, or null if none exists yet. */
  source: string | null;
  /** The drift vs the code mapping. `hasCatalog:false` when nothing captured. */
  drift: PortalDriftReport | null;
}

/**
 * The latest drift status for every configured portal — read-only, for the
 * "Deriva de portales" section on Salud de datos. Never throws for the empty
 * case: a portal with no captured catalog yet reports `hasCatalog:false`.
 */
export async function getLatestPortalDrifts(): Promise<PortalDriftStatus[]> {
  const out: PortalDriftStatus[] = [];
  for (const connector of DRIFT_CHECK_PORTALS) {
    const row = await findLatestCatalog(connector);
    const codeMapping = codeMappingForPortal(connector);
    const drift = codeMapping
      ? computePortalDrift(connector, row?.axes ?? null, codeMapping)
      : null;
    out.push({
      connector,
      capturedAt: row?.captured_at ?? null,
      source: row?.source ?? null,
      drift,
    });
  }
  return out;
}
