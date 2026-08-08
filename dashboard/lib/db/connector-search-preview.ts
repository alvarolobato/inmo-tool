/**
 * ETL-connector search previews for the "Validar filtros" page — issue #478 P4,
 * server-only (imports lib/db-write's `pg` client). Never import from a client
 * component.
 *
 * The ETL computes, per (active profile × registered connector), an OFFLINE
 * preview of what its discover() will actually execute — the entry URL / sitemap
 * / endpoint plus an honest note for the non-tunable connectors — and upserts it
 * into `connector_search_preview` each sweep (etl.orchestrator.publish_search_
 * previews). This module reads them back, joined against `connector_registry` so
 * the page also knows each connector's `override_host_suffix` (whether an owner
 * may pin a URL) — the same value the connector-filters PUT route validates
 * against.
 */

import { sql } from "@/lib/db-write";
import { parseGrammar, type SearchUrlGrammar } from "@/lib/connector-url/parse";

/** Where a search param came from — mirrors Python's SearchParam.source. */
export type SearchParamSource = "profile" | "connector_config" | "constant" | "derived";

/**
 * One resolved parameter a connector's discover() uses for a scope (issue
 * #491), camelCased from the JSONB the ETL serialises (SearchParam in Python).
 */
export interface SearchParamView {
  key: string;
  label: string;
  value: string | null;
  source: SearchParamSource;
  /** Whether this param travels in the search URL (so the grammar round-trips it). */
  inUrl: boolean;
  notes: string | null;
}

/** One preview row as serialised by the ETL (list[SearchPreview] in Python). */
export interface SearchPreview {
  label: string;
  url: string | null;
  kind: "search_page" | "sitemap" | "api";
  tunable: boolean;
  notes: string | null;
  /** The resolved params this URL is built from (issue #491); [] on old rows. */
  params: SearchParamView[];
}

/** A registered ETL connector's previews + override metadata for a profile. */
export interface EtlConnectorPreview {
  connector: string;
  /** Host suffix a pinned URL must fall under, or null when un-pinnable. */
  overrideHostSuffix: string | null;
  /** Whether discover() actually consumes a pinned URL yet (Phase 5). */
  supportsSearchOverride: boolean;
  /** The connector's URL grammar (issue #491), or null when it publishes none. */
  searchUrlGrammar: SearchUrlGrammar | null;
  /** Parsed previews; [] when the ETL hasn't computed any for this profile yet. */
  previews: SearchPreview[];
  /** When the previews were computed (ISO), or null when none exist yet. */
  computedAt: string | null;
}

interface RawRow {
  connector: string;
  override_host_suffix: string | null;
  supports_search_override: boolean;
  search_url_grammar: unknown;
  previews: unknown;
  computed_at: Date | string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

const VALID_KINDS = new Set(["search_page", "sitemap", "api"]);
const VALID_SOURCES = new Set<SearchParamSource>([
  "profile",
  "connector_config",
  "constant",
  "derived",
]);

/**
 * Defensively parse a stored `params` array (snake_case, as Python's asdict
 * serialises SearchParam) into typed SearchParamView[]. Old preview rows
 * predate this field and have no `params` key → []. A bad source coerces to
 * "derived" (the neutral "computed, origin unknown" bucket) rather than
 * dropping the chip.
 */
function parseParams(raw: unknown): SearchParamView[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchParamView[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.key !== "string") continue;
    const source =
      typeof r.source === "string" && VALID_SOURCES.has(r.source as SearchParamSource)
        ? (r.source as SearchParamSource)
        : "derived";
    out.push({
      key: r.key,
      label: typeof r.label === "string" ? r.label : r.key,
      value: typeof r.value === "string" ? r.value : null,
      source,
      inUrl: r.in_url === true,
      notes: typeof r.notes === "string" ? r.notes : null,
    });
  }
  return out;
}

/** Defensively parse a stored `previews` JSONB into typed SearchPreview[]. */
function parsePreviews(raw: unknown): SearchPreview[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchPreview[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const kind = typeof r.kind === "string" && VALID_KINDS.has(r.kind) ? r.kind : "search_page";
    out.push({
      label: typeof r.label === "string" ? r.label : "",
      url: typeof r.url === "string" ? r.url : null,
      kind: kind as SearchPreview["kind"],
      tunable: r.tunable === true,
      notes: typeof r.notes === "string" ? r.notes : null,
      params: parseParams(r.params),
    });
  }
  return out;
}

/**
 * Every registered ETL connector (supports_discovery = true, i.e. NOT a
 * capture-only portal — those show on the extension side) with its previews for
 * `profileId`. LEFT JOIN so a connector with no computed preview yet still
 * appears (as a "pending" row). Ordered by connector name for a stable page.
 *
 * Returns [] rather than throwing when the table doesn't exist yet (DB not
 * migrated) — the page degrades to an empty state without an error surface.
 */
export async function getEtlConnectorPreviews(
  profileId: number,
): Promise<EtlConnectorPreview[]> {
  let rows: RawRow[];
  try {
    rows = await sql<RawRow>(
      `SELECT g.connector_name AS connector,
              g.override_host_suffix,
              g.supports_search_override,
              g.search_url_grammar,
              p.previews,
              p.computed_at
         FROM connector_registry g
         LEFT JOIN connector_search_preview p
           ON p.connector = g.connector_name AND p.profile_id = $1
        WHERE g.registered = true
          AND g.supports_discovery = true
        ORDER BY g.connector_name`,
      [profileId],
    );
  } catch (err) {
    // 42P01 undefined_table (DB not migrated) → empty state, no error surface.
    if (err && typeof err === "object" && (err as { code?: unknown }).code === "42P01") {
      return [];
    }
    throw err;
  }

  return rows.map((row) => ({
    connector: row.connector,
    overrideHostSuffix: row.override_host_suffix,
    supportsSearchOverride: row.supports_search_override,
    searchUrlGrammar: parseGrammar(row.search_url_grammar),
    previews: parsePreviews(row.previews),
    computedAt: toIso(row.computed_at),
  }));
}

/**
 * The host suffix an owner-pinned URL must fall under for `connector`, from the
 * connector registry — or null when the connector is unknown, unregistered, or
 * declares no `override_host_suffix` (the non-tunable sitemap/API connectors).
 * Used by the connector-filters PUT route to validate an HTTP connector's pinned
 * URL host server-side (never client-claimed — #476).
 */
export async function getConnectorOverrideHostSuffix(
  connector: string,
): Promise<string | null> {
  const rows = await sql<{ override_host_suffix: string | null }>(
    `SELECT override_host_suffix
       FROM connector_registry
      WHERE connector_name = $1 AND registered = true`,
    [connector],
  );
  return rows[0]?.override_host_suffix ?? null;
}
