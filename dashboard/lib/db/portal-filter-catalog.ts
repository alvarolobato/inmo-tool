/**
 * Discovered portal filter catalogs (URL-building discovery, issue #336, D-063)
 * — server-only (imports lib/db-write, the `pg` client). Never import from a
 * client component; the client-safe types + read helpers live in
 * lib/search-url/discovered-mapping.ts.
 *
 * A row is one discovery session for one connector: the browser extension
 * enumerated the portal's search-form filter options and the URL fragment each
 * produces, and POSTed them (POST /api/extension/filter-catalog). Latest-wins —
 * we never upsert; each session is retained (drift archaeology), and the read
 * path takes the newest row per connector.
 */

import { sql } from "@/lib/db-write";
import type { CatalogAxes, CatalogSource } from "@/lib/search-url/discovered-mapping";

/** A `portal_filter_catalog` row as read back. */
export interface PortalFilterCatalogRow {
  id: number;
  connector: string;
  source: CatalogSource;
  axes: CatalogAxes;
  captured_at: string;
  created_at: string;
}

/** What to persist for one discovery session (already validated by the route). */
export interface FilterCatalogInput {
  connector: string;
  source: CatalogSource;
  axes: CatalogAxes;
  capturedAt: string;
}

/** How many discrete options a catalog carries across all its axes. */
export function countCatalogOptions(axes: CatalogAxes): number {
  return Object.values(axes).reduce((n, opts) => n + (opts?.length ?? 0), 0);
}

/**
 * Insert one discovery session. No upsert: sessions accumulate so drift is
 * auditable and the newest simply wins on read. Returns the new row id plus the
 * axis / option counts the route echoes back to the extension.
 */
export async function saveFilterCatalog(
  input: FilterCatalogInput,
): Promise<{ id: number; axesCount: number; optionsCount: number }> {
  const rows = await sql<{ id: number }>(
    `INSERT INTO portal_filter_catalog (connector, source, axes, captured_at)
       VALUES ($1, $2, $3::jsonb, $4)
     RETURNING id`,
    [input.connector, input.source, JSON.stringify(input.axes), input.capturedAt],
  );
  return {
    id: rows[0].id,
    axesCount: Object.keys(input.axes).length,
    optionsCount: countCatalogOptions(input.axes),
  };
}

/**
 * The latest discovery catalog for a connector, or null if none exists. This is
 * what the resolver primes into the client-safe cache before building — a
 * single cheap indexed lookup (idx_portal_filter_catalog_latest).
 */
export async function findLatestCatalog(
  connector: string,
): Promise<PortalFilterCatalogRow | null> {
  const rows = await sql<PortalFilterCatalogRow>(
    `SELECT id, connector, source, axes, captured_at, created_at
       FROM portal_filter_catalog
      WHERE connector = $1
      ORDER BY captured_at DESC, id DESC
      LIMIT 1`,
    [connector],
  );
  return rows[0] ?? null;
}
