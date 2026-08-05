/**
 * Discovered option→URL-fragment mapping (issue #336, D-063) — CLIENT-SAFE.
 *
 * The read-side of "URL-building discovery mode": the browser extension
 * enumerates a portal's search-form filter OPTIONS and the URL fragment each
 * produces, POSTs that catalog (POST /api/extension/filter-catalog), and it is
 * persisted to `portal_filter_catalog`. This module lets a per-portal URL
 * BUILDER (lib/search-url/portals/<name>.ts) consult the LATEST discovered
 * catalog for a per-axis segment (property-type slug, subtipo code, …) and
 * PREFER it over the hard-coded seed table — falling back to the seed when no
 * discovered value exists (offline, never-run, or a type the portal doesn't
 * expose). The hard-coded map stays the verified seed / offline default.
 *
 * Why a module-level cache + sync accessor (not a build() parameter):
 *   - Builders are pure & synchronous (index.ts is client-safe, imports no
 *     `pg`); threading an async DB read through every builder + caller would
 *     change the public build() signature. Instead the SERVER-ONLY resolver
 *     (resolve.ts) PRIMES this cache (`primeDiscoveredCatalog`) with the latest
 *     row right before it builds, then the builder reads it synchronously.
 *   - The cache is keyed by connector and only ever holds the single LATEST
 *     catalog per connector, so concurrent priming across requests converges on
 *     the same value — benign for a low-traffic admin tool. Any non-primed path
 *     (e.g. the client-safe buildSearchUrls) simply sees an empty cache and
 *     falls back to the seed, which is the correct default.
 *
 * No `pg` here — the DB reads live in lib/db/portal-filter-catalog.ts.
 */

import { PROPERTY_TYPES } from "@/lib/profiles-schema";
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

/** What the builder gets back for one canonical value, or null to fall back. */
export interface DiscoveredSegment {
  /** The URL path slug the portal uses (last segment of `urlFragment`). */
  slug: string;
  /** A numeric subtype code, if the portal encodes one (Aliseda `subtipo`). */
  code?: number;
  /** The top-level category path, if the portal roots this type elsewhere. */
  category?: string;
  /** The portal's own label for the option (for diagnostics / diffing). */
  label: string;
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

// ── Client-safe latest-catalog cache (primed server-side by resolve.ts) ──────

const CACHE = new Map<string, CatalogAxes>();

/**
 * Store (or clear) the latest discovered catalog for a connector. Called by the
 * server-only resolver right before it builds that connector's tasks; passing
 * `null` clears any cached catalog (so a builder falls back to its seed).
 * Overwrites — the latest catalog always wins.
 */
export function primeDiscoveredCatalog(connector: string, axes: CatalogAxes | null): void {
  if (axes) CACHE.set(connector, axes);
  else CACHE.delete(connector);
}

/** Drop all cached catalogs — test hook, and a manual invalidation escape hatch. */
export function resetDiscoveredCatalogCache(): void {
  CACHE.clear();
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
function lastPathSegment(urlFragment: string): string | null {
  // Strip query/hash, split on "/", take the last non-empty piece.
  const path = urlFragment.split(/[?#]/)[0];
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/**
 * The discovered segment for one canonical value on one axis, or null to fall
 * back to the builder's hard-coded seed.
 *
 * Only `property_type` is resolved today (the axis Aliseda is wired for): the
 * cached catalog's `property_type` options are matched to the canonical
 * PropertyType by label, and the first match wins. Returns null when nothing is
 * cached for the connector, the axis is absent, or no option maps to the value.
 */
export function discoveredSegmentFor(
  connector: string,
  axis: CatalogAxis,
  canonicalValue: string,
): DiscoveredSegment | null {
  const axes = CACHE.get(connector);
  if (!axes) return null;
  const options = axes[axis];
  if (!options || options.length === 0) return null;

  if (axis === "property_type") {
    // Validate the requested value is a real PropertyType before matching.
    if (!(PROPERTY_TYPES as readonly string[]).includes(canonicalValue)) return null;
    for (const opt of options) {
      if (canonicalPropertyType(opt.label) !== canonicalValue) continue;
      const slug = lastPathSegment(opt.urlFragment);
      if (!slug) continue; // an option with no usable fragment can't inform a segment
      return {
        slug,
        code: typeof opt.subtipo === "number" ? opt.subtipo : undefined,
        category: typeof opt.category === "string" ? opt.category : undefined,
        label: opt.label,
      };
    }
    return null;
  }

  // Other axes are captured & stored, but not yet consumed by any builder.
  return null;
}
