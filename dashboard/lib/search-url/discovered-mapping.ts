/**
 * Discovered filter catalog — shape, validation, and canonical resolution
 * (issue #336, D-063; reframed detection-only by issue #371, D-090) —
 * CLIENT-SAFE.
 *
 * The browser extension enumerates a portal's search-form filter OPTIONS and
 * the URL fragment each produces, POSTs that catalog (POST
 * /api/extension/filter-catalog), and it is persisted to
 * `portal_filter_catalog`. This module owns the catalog's TYPES, the ingest
 * PAYLOAD VALIDATOR, and the portal-label → canonical `PropertyType` resolver.
 *
 * IMPORTANT (D-090): the catalog is used ONLY for deterministic DRIFT DETECTION
 * (lib/search-url/drift.ts) — it does NOT feed URL construction. URL building
 * is 100% code-driven from each connector's hard-coded per-portal map. The
 * self-healing "prefer the discovered slug/subtipo over the seed" path that
 * #339/D-063 shipped was REMOVED per the owner: discovery flags drift, humans
 * update the code. There is no module-level catalog cache and no
 * `discoveredSegmentFor()` any more.
 *
 * No `pg` here — the DB reads live in lib/db/portal-filter-catalog.ts.
 */

import type { PropertyType } from "./types";

/** The axes a discovery catalog can carry (connector-agnostic; a portal may expose any subset). */
export type CatalogAxis = "property_type" | "rooms" | "condition" | "price_bucket" | "zone";

export const CATALOG_AXES: readonly CatalogAxis[] = [
  "property_type",
  "rooms",
  "condition",
  "price_bucket",
  "zone",
];

/** Where a catalog was captured from (audit + brittleness ordering). */
export type CatalogSource = "embedded-config" | "form-options" | "navigated";

export const CATALOG_SOURCES: readonly CatalogSource[] = [
  "embedded-config",
  "form-options",
  "navigated",
];

/**
 * One discovered filter option: the portal's own label, the raw form value it
 * carries (if any), and the URL fragment selecting it produces. `category` and
 * `subtipo` are Aliseda-shaped extras (top-level path category + numeric
 * subtype code) but the shape is open — a portal may attach any extra scalars.
 */
export interface CatalogOption {
  label: string;
  portalValue?: string | null;
  urlFragment: string;
  category?: string;
  subtipo?: number;
  [extra: string]: unknown;
}

/** The discovered catalog for one connector: axis name → its options. */
export type CatalogAxes = Partial<Record<CatalogAxis, CatalogOption[]>>;

/** A validated discovery catalog as POSTed by the extension / stored in the table. */
export interface DiscoveredCatalog {
  connector: string;
  source: CatalogSource;
  capturedAt: string;
  axes: CatalogAxes;
}

// ── Payload validation (pure; shared by the ingest route and its tests) ──────

/** Outcome of validating a raw POSTed discovery catalog. */
export type ValidateCatalogResult =
  | { ok: true; source: CatalogSource; axes: CatalogAxes; capturedAt: string }
  | { ok: false; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate + normalize a raw discovery-catalog body (the JSON the extension
 * POSTs). Pure — no DB, no host derivation (the route derives/whitelists the
 * connector separately, never trusting the client-claimed one). Enforces:
 *   - `source` is one of CATALOG_SOURCES,
 *   - `capturedAt` is a valid ISO timestamp (defaults to now if absent),
 *   - `axes` is an object whose keys are known CATALOG_AXES, each an array of
 *     options with a non-empty string `urlFragment` and `label`.
 * Unknown axis keys and malformed options are DROPPED (not fatal) so a portal
 * exposing an extra axis never blocks a valid catalog; at least one usable
 * option overall is required.
 */
export function validateCatalogPayload(body: unknown): ValidateCatalogResult {
  if (!isPlainObject(body)) return { ok: false, reason: "body_not_object" };

  const source = body.source;
  if (typeof source !== "string" || !(CATALOG_SOURCES as readonly string[]).includes(source)) {
    return { ok: false, reason: "invalid_source" };
  }

  let capturedAt: string;
  if (body.capturedAt === undefined || body.capturedAt === null) {
    capturedAt = new Date().toISOString();
  } else if (typeof body.capturedAt === "string" && !Number.isNaN(Date.parse(body.capturedAt))) {
    capturedAt = new Date(body.capturedAt).toISOString();
  } else {
    return { ok: false, reason: "invalid_capturedAt" };
  }

  if (!isPlainObject(body.axes)) return { ok: false, reason: "invalid_axes" };

  const axes: CatalogAxes = {};
  let optionCount = 0;
  for (const axis of CATALOG_AXES) {
    const raw = (body.axes as Record<string, unknown>)[axis];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) return { ok: false, reason: `invalid_axis:${axis}` };
    const opts: CatalogOption[] = [];
    for (const item of raw) {
      if (!isPlainObject(item)) continue;
      const { label, urlFragment } = item;
      if (typeof label !== "string" || !label.trim()) continue;
      if (typeof urlFragment !== "string" || !urlFragment.trim()) continue;
      const opt: CatalogOption = { label: label.trim(), urlFragment: urlFragment.trim() };
      if (typeof item.portalValue === "string") opt.portalValue = item.portalValue;
      if (typeof item.category === "string") opt.category = item.category;
      if (typeof item.subtipo === "number" && Number.isFinite(item.subtipo)) {
        opt.subtipo = item.subtipo;
      }
      opts.push(opt);
      optionCount += 1;
    }
    if (opts.length > 0) axes[axis] = opts;
  }

  if (optionCount === 0) return { ok: false, reason: "no_options" };
  return { ok: true, source: source as CatalogSource, axes, capturedAt };
}

// ── Canonical property-type resolution (this layer owns our taxonomy) ────────
//
// The extension scrapes portal LABELS ("Piso", "Ático", "Chalet adosado"), not
// our canonical PropertyType values, on purpose — it stays connector-generic
// and taxonomy-free. Mapping a portal label to our canonical type is done HERE,
// in TS, which legitimately owns PROPERTY_TYPES.

/** Lowercase + strip diacritics, for accent-insensitive label matching. */
function normalizeLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Synonyms mapping a normalized portal label (or a substring of it) to a
 * canonical PropertyType. Ordered longest-first per type so "chalet adosado"
 * resolves to `chalet` via the `chalet` stem. Types outside our taxonomy
 * (dúplex, estudio, …) intentionally have no entry → null (seed fallback).
 */
const TYPE_SYNONYMS: ReadonlyArray<readonly [string, PropertyType]> = [
  ["atico", "atico"],
  ["piso", "piso"],
  ["chalet", "chalet"],
  ["local", "local"],
  ["nave", "nave"],
  ["garaje", "garaje"],
  ["plaza de garaje", "garaje"],
  ["terreno", "terreno"],
  ["suelo", "terreno"],
  ["edificio", "edificio"],
];

/**
 * Map a portal's option label to a canonical PropertyType, or null when it
 * isn't one of ours. Matches on stem containment (accent-insensitive) so
 * "Ático dúplex" → atico, "Chalet adosado" → chalet.
 */
export function canonicalPropertyType(label: string): PropertyType | null {
  const norm = normalizeLabel(label);
  if (!norm) return null;
  // Prefer the most specific (longest) synonym that the label contains.
  let best: PropertyType | null = null;
  let bestLen = 0;
  for (const [stem, type] of TYPE_SYNONYMS) {
    if (norm.includes(stem) && stem.length > bestLen) {
      best = type;
      bestLen = stem.length;
    }
  }
  return best;
}

/** Last non-empty path segment of a URL fragment ("/comprar-viviendas/pisos" → "pisos"). */
export function lastPathSegment(urlFragment: string): string | null {
  // Strip query/hash, split on "/", take the last non-empty piece.
  const path = urlFragment.split(/[?#]/)[0];
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}
