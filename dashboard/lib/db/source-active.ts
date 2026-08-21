/**
 * Shared SQL building blocks for "is this portal `source` currently active?"
 * (issue #319 / D-055).
 *
 * A listing's `source` is exactly the connector's registry name — every
 * connector emits `RawListing(source=self.name)` and publishes itself into
 * `connector_registry` under that same name (etl/connectors/base.py,
 * orchestrator.sync_connector_registry). So `listing.source =
 * connector_registry.connector_name` for every portal, which is what lets the
 * feed resolve a listing's source to its connector's on/off state.
 *
 * The owner's single-toggle model (issue #319): the user sees ONE Activo/
 * Desactivado state per connector. What that toggle writes depends on the
 * connector type, and so does what "OFF" means for hiding data:
 *   - normal crawl connector (`supports_discovery = true`): OFF when
 *     `connector_config.enabled = false`.
 *   - capture-only connector (`supports_discovery = false`, e.g. idealista,
 *     aliseda, altamira, cimenta2): OFF when
 *     `connector_config.capture_enabled = false`.
 *
 * A source with no `connector_registry` row, or no `connector_config` row,
 * defaults to ACTIVE — matching the ETL's missing-row defaults (both `enabled`
 * and `capture_enabled` default TRUE). So a brand-new connector, or one an
 * operator has never touched, keeps showing its data.
 *
 * Owner decision (issue #319 §5): listings from an OFF source are HIDDEN from
 * the candidate feed entirely — not merely no longer ingested. They must not
 * appear as cards, source badges, prices, photos, staleness, or in the
 * source-filter options / counts.
 */

/**
 * CTE body (named `disabled_sources`) yielding every `source` whose connector
 * is currently OFF. Tiny — one row per registered connector at most — so
 * Postgres materialises it once and hashes the `NOT IN` anti-join against it,
 * rather than re-resolving per candidate row.
 *
 * Use as the first CTE of a query: `WITH ${DISABLED_SOURCES_CTE} SELECT ...`,
 * or chained after another CTE with a comma.
 */
export const DISABLED_SOURCES_CTE = `disabled_sources AS (
  SELECT g.connector_name AS source
    FROM connector_registry g
    LEFT JOIN connector_config c ON c.connector_name = g.connector_name
   WHERE CASE
           WHEN g.supports_discovery THEN COALESCE(c.enabled, true) = false
           ELSE COALESCE(c.capture_enabled, true) = false
         END
)`;

/**
 * Predicate that keeps only listings whose source is active. `alias` is the
 * `listing` table alias in the surrounding query. Requires
 * `DISABLED_SOURCES_CTE` to be in scope.
 */
export function activeSourceClause(alias: string): string {
  return `${alias}.source NOT IN (SELECT source FROM disabled_sources)`;
}

/**
 * The TypeScript twin of `DISABLED_SOURCES_CTE`'s `CASE`: is this connector
 * currently ON, given the owner's single-toggle model?
 *
 * There must be exactly TWO copies of this discriminator — the SQL above (for
 * queries that filter listings) and this one (for components rendering a
 * connector's state). Issue #674's review found a THIRD had appeared
 * (`ProfileForm`'s connector picker, alongside `ConnectorCard`'s); all three
 * agreed at the time, which is precisely how this class of drift stays
 * invisible until one of them is updated and the others aren't. Import this
 * rather than re-deriving `supports_discovery ? enabled : capture_enabled`.
 *
 * Client-safe: this module imports nothing, so a `"use client"` component can
 * pull it in without dragging a DB driver into the browser bundle.
 */
export function isConnectorActive(c: {
  supports_discovery: boolean;
  enabled: boolean;
  capture_enabled: boolean;
}): boolean {
  return c.supports_discovery ? c.enabled : c.capture_enabled;
}
