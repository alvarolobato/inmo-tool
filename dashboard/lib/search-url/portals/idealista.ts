/**
 * Idealista pre-filtered search-URL builder + parser.
 *
 * GEOGRAPHY = DRAWN POLYGON (issue #471). The profile scope carries
 * geography as a radius around a geocoded point. Idealista's "dibuja tu zona"
 * search takes that area as a polygon in a `shape` query param, so the builder
 * renders the profile's circle as a regular polygon and emits the confirmed
 * drawn-area grammar:
 *
 *   /areas/<operation>[/con-<f1>,<f2>,…]/mapa-google?shape=((<polyline>))
 *
 * Owner-captured specimen (Dos Hermanas, 2026-08-08 — issue #471):
 *
 *   https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_700000/mapa-google?shape=%28%28…%29%29
 *
 * The `shape` value is a Google Encoded Polyline (precision 5, lat,lng),
 * URL-encoded and wrapped in `((…))`. Filters (`con-…`) ride in the PATH before
 * `/mapa-google`, exactly as captured. See lib/search-url/geo.ts for the pinned
 * round-trip encoder/decoder.
 *
 * WHY, not the old slug grammar: the previous builder resolved the point to the
 * nearest of 12 hard-coded `<municipio>-<provincia>` slugs and DISCARDED the
 * radius — a 5 km and a 30 km circle produced the same URL, sub-municipality and
 * cross-municipality circles were inexpressible, and Idealista's zone
 * mis-parenting (Montequinto filed under "Sevilla") was invisible. A polygon
 * over the real area sidesteps the whole taxonomy. Per break-by-default the slug
 * grammar is retired as the builder's output; it survives only inside the PARSER
 * so owner-navigated / historical slug URLs are still learnable (D-051).
 *
 * CONFIRMED vs. GUESSED (guessed items are flagged as loosened):
 *   - path `/areas/<operation>[/con-…]/mapa-google?shape=((<polyline>))` ... confirmed (specimen)
 *   - circle → 24-gon CIRCUMSCRIBING the circle (faithful, slightly broader) ... geo.ts
 *   - price `con-precio-hasta_<max>` / `con-precio-desde_<min>` ............... confirmed
 *   - rooms `de-cuatro-cinco-habitaciones-o-mas` (min ≥ 4) .................... owner-confirmed;
 *     a lower minimum has no confirmed token → omit + flag.
 *   - size `metros-cuadrados-mas-de_ / menos-de_` ............................. standard idealista tokens
 *
 * Geography carries NO loosened flag: a polygon is a faithful (~0.9% broader)
 * rendering of the circle, and the feed-side haversine (scope-query.ts) trims
 * the over-coverage — the shape URL only governs RECALL.
 */

import { PROPERTY_TYPES } from "@/lib/profiles-schema";
import { municipioForPoint } from "../municipios";
import { provinceForPoint } from "../provinces";
import { stableTaskId } from "../task-id";
import { shapeTaskLabel } from "../labels";
import {
  circlePolygon,
  decodeShapeValue,
  polygonCentroid,
  shapeUrl,
} from "../geo";
import {
  centerForLocationSlug,
  makeCategoryKey,
  NUMERIC_FIELDS,
  PLACEHOLDER,
} from "../parse-shared";
import type { CodeMappingAxes, CodeMappingOption } from "../drift";
import type {
  CanonicalSearchScope,
  LoosenableConstraint,
  LoosenedConstraint,
  ParsedSearchFilters,
  ParsedSearchUrl,
  PortalSearchUrlBuilder,
  PortalSearchUrlParser,
  PropertyType,
  SearchTask,
} from "../types";

const ORIGIN = "https://www.idealista.com";
const PORTAL = "idealista";

/** Idealista operation section each property type lives in. */
const OPERATION_BY_TYPE: Record<PropertyType, string> = {
  piso: "venta-viviendas",
  chalet: "venta-viviendas",
  atico: "venta-viviendas",
  local: "venta-locales",
  nave: "venta-locales",
  garaje: "venta-garajes",
  terreno: "venta-terrenos",
  edificio: "venta-edificios",
};

/** Property types in the canonical PROPERTY_TYPES order (deterministic). */
function inCanonicalOrder(types: readonly PropertyType[]): PropertyType[] {
  const wanted = new Set(types);
  return PROPERTY_TYPES.filter((t) => wanted.has(t));
}

/** Group the profile's types by their operation section, in canonical order. */
function sectionsInOrder(
  types: readonly PropertyType[],
): Array<{ operation: string; types: PropertyType[] }> {
  const bySection = new Map<string, PropertyType[]>();
  for (const t of inCanonicalOrder(types)) {
    const op = OPERATION_BY_TYPE[t];
    const bucket = bySection.get(op);
    if (bucket) bucket.push(t);
    else bySection.set(op, [t]);
  }
  return [...bySection.entries()].map(([operation, ts]) => ({ operation, types: ts }));
}

/** Title-case a URL slug like `dos-hermanas` → "Dos Hermanas" (for labels). */
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * A human name for the shape task's area — the nearest known municipio, else the
 * containing province, else "zona". Cosmetic only (the polygon is authoritative).
 */
function nearestAreaName(scope: CanonicalSearchScope): string {
  const muni = municipioForPoint(scope.center);
  if (muni) return titleCaseSlug(muni.municipio);
  const prov = provinceForPoint(scope.center);
  if (prov) return titleCaseSlug(prov.provincia);
  return "zona";
}

/**
 * A stable, canonical geometry key for the task id — rounded centre + radius so
 * the SAME profile geometry always yields the SAME task id (capture_task_run
 * staleness ledger survives), and TWO DIFFERENT radii around one centre yield
 * DIFFERENT ids (the old slug builder's counterexample).
 */
function geometryKey(scope: CanonicalSearchScope): string {
  const [lat, lng] = scope.center;
  return `shape:${lat.toFixed(4)},${lng.toFixed(4)}:${scope.radiusKm}`;
}

/** The confirmed idealista token for a minimum-rooms filter, or null (+ flag). */
function roomsToken(roomsMin: number | undefined, loosened: LoosenedConstraint[]): string | null {
  if (roomsMin === undefined) return null;
  if (roomsMin >= 4) return "de-cuatro-cinco-habitaciones-o-mas"; // owner-confirmed "4-5+"
  loosened.push({
    constraint: "rooms",
    reason:
      `Idealista: sólo está confirmado el token de "4-5+ habitaciones"; para un mínimo de ` +
      `${roomsMin} no se aplica filtro de habitaciones (resultados más amplios).`,
  });
  return null;
}

/** The comma-joined `con-` filter tokens for a scope, in the confirmed order. */
function conTokensFor(
  scope: CanonicalSearchScope,
  loosened: LoosenedConstraint[],
): string[] {
  const tokens: string[] = [];
  if (scope.priceMin !== undefined) tokens.push(`precio-desde_${Math.round(scope.priceMin)}`);
  if (scope.priceMax !== undefined) tokens.push(`precio-hasta_${Math.round(scope.priceMax)}`);
  const rooms = roomsToken(scope.roomsMin, loosened);
  if (rooms) tokens.push(rooms);
  if (scope.sizeMin !== undefined) tokens.push(`metros-cuadrados-mas-de_${Math.round(scope.sizeMin)}`);
  if (scope.sizeMax !== undefined) tokens.push(`metros-cuadrados-menos-de_${Math.round(scope.sizeMax)}`);
  return tokens;
}

function buildTask(
  operation: string,
  types: PropertyType[],
  scope: CanonicalSearchScope,
): SearchTask {
  const loosened: LoosenedConstraint[] = [];
  const tokens = conTokensFor(scope, loosened);

  // Geography = the profile circle as a drawn polygon (no loosened flag — the
  // polygon faithfully renders the circle, ~0.9% broader, trimmed by the feed).
  const ring = circlePolygon(scope.center[0], scope.center[1], scope.radiusKm);
  const url = shapeUrl(operation, tokens, ring, ORIGIN);

  const id = stableTaskId({
    portal: PORTAL,
    section: operation,
    location: geometryKey(scope),
    priceMin: scope.priceMin,
    priceMax: scope.priceMax,
    sizeMin: scope.sizeMin,
    sizeMax: scope.sizeMax,
    roomsMin: scope.roomsMin,
  });

  return {
    id,
    portal: PORTAL,
    label: shapeTaskLabel(
      PORTAL,
      types,
      nearestAreaName(scope),
      scope.radiusKm,
      scope.priceMin,
      scope.priceMax,
    ),
    url,
    loosened,
  };
}

function buildIdealista(scope: CanonicalSearchScope): SearchTask[] {
  return sectionsInOrder(scope.propertyTypes).map(({ operation, types }) =>
    buildTask(operation, types, scope),
  );
}

/**
 * The Idealista CODE mapping, per axis (issue #371, D-090) — the `venta-<section>`
 * operations the builder emits, for drift detection against the portal's captured
 * catalog. Unchanged by the shape work: geography is not a code axis.
 */
function idealistaCodeMapping(): CodeMappingAxes {
  const bySlug = new Map<string, CodeMappingOption>();
  for (const operation of Object.values(OPERATION_BY_TYPE)) {
    if (bySlug.has(operation)) continue;
    bySlug.set(operation, { slug: operation, label: operation });
  }
  return { property_type: [...bySlug.values()] };
}

export const idealistaBuilder: PortalSearchUrlBuilder = {
  portal: PORTAL,
  build: buildIdealista,
  codeMapping: idealistaCodeMapping,
};

// ─── parse(): recognise the shape, multi and legacy slug grammars (#293/#471) ─
//
// build() now emits `/areas/<operation>[/con-…]/mapa-google?shape=((…))`, so
// parse() recognises THAT (the round-trip contract), plus the `/multi/…`
// multi-zone grammar (recognised as an opaque, verbatim pinned-override shape —
// never generated), plus the legacy `/<operation>/<municipio>-<provincia>/con-…/`
// slug grammar so owner-navigated and historical URLs are still learnable.

/** The property types each operation section maps back to (build is 1 task/section). */
const TYPES_BY_OPERATION: Record<string, readonly PropertyType[]> = {
  "venta-viviendas": ["piso", "chalet", "atico"],
  "venta-locales": ["local", "nave"],
  "venta-garajes": ["garaje"],
  "venta-terrenos": ["terreno"],
  "venta-edificios": ["edificio"],
};

/** The confirmed min-rooms token (build emits it for roomsMin ≥ 4). */
const ROOMS_TOKEN = "de-cuatro-cinco-habitaciones-o-mas";

/** A recognised numeric `con-` token: its regex + which scope field it fills. */
const NUM_TOKEN_SPECS = [
  { field: "priceMin", re: /^precio-desde_(\d+)$/, placeholderToken: `precio-desde_${PLACEHOLDER.priceMin}` },
  { field: "priceMax", re: /^precio-hasta_(\d+)$/, placeholderToken: `precio-hasta_${PLACEHOLDER.priceMax}` },
  { field: "sizeMin", re: /^metros-cuadrados-mas-de_(\d+)$/, placeholderToken: `metros-cuadrados-mas-de_${PLACEHOLDER.sizeMin}` },
  { field: "sizeMax", re: /^metros-cuadrados-menos-de_(\d+)$/, placeholderToken: `metros-cuadrados-menos-de_${PLACEHOLDER.sizeMax}` },
] as const satisfies ReadonlyArray<{
  field: "priceMin" | "priceMax" | "sizeMin" | "sizeMax";
  re: RegExp;
  placeholderToken: string;
}>;

/**
 * Decode a comma-joined `con-` token string into numeric filters (mutating
 * `filters`) and return the TEMPLATE tokens — each recognised numeric token
 * swapped for its named placeholder, categorical/unknown tokens kept verbatim.
 * Shared by the shape, multi and slug parsers.
 */
function parseConTokens(tokensStr: string | undefined, filters: ParsedSearchFilters): string[] {
  const templateTokens: string[] = [];
  if (!tokensStr) return templateTokens;
  for (const token of tokensStr.split(",")) {
    if (token === ROOMS_TOKEN) {
      filters.roomsMin = 4; // build only emits this token for roomsMin ≥ 4
      templateTokens.push(token); // categorical → literal in template
      continue;
    }
    const spec = NUM_TOKEN_SPECS.find((s) => s.re.test(token));
    if (spec) {
      filters[spec.field] = Number(spec.re.exec(token)![1]);
      templateTokens.push(spec.placeholderToken);
      continue;
    }
    templateTokens.push(token); // unrecognised → keep verbatim, no filter
  }
  return templateTokens;
}

/**
 * Substitute a profile scope's numeric values into placeholdered `con-` template
 * tokens (shared by all three substitute paths). Returns the rebuilt `/con-…`
 * path part ("" when no tokens) and the constraints the template had no
 * placeholder for (broadened → flagged like build() does).
 */
function substituteConTokens(
  tokensStr: string | undefined,
  scope: CanonicalSearchScope,
): { conPart: string; unfilled: LoosenableConstraint[] } {
  const outTokens: string[] = [];
  if (tokensStr) {
    for (const token of tokensStr.split(",")) {
      const field = NUMERIC_FIELDS.find((f) => token.includes(f.placeholder));
      if (!field) {
        outTokens.push(token); // literal (rooms / opaque)
        continue;
      }
      const value = scope[field.key];
      if (value === undefined) continue; // profile omits it → drop token (broader)
      outTokens.push(token.replace(field.placeholder, String(Math.round(value))));
    }
  }
  const unfilled: LoosenableConstraint[] = [];
  for (const f of NUMERIC_FIELDS) {
    if (scope[f.key] !== undefined && !(tokensStr ?? "").includes(f.placeholder)) {
      unfilled.push(f.constraint);
    }
  }
  return { conPart: outTokens.length > 0 ? `/con-${outTokens.join(",")}` : "", unfilled };
}

// origin | operation | con tokens | shape value
const SHAPE_RE =
  /^(https?:\/\/(?:www\.)?idealista\.com)\/areas\/([^/?#]+)(?:\/con-([^/?#]+))?\/mapa-google\?shape=(.+)$/;
// origin | operation | zone codes (a segment NOT starting with con-) | con tokens
const MULTI_RE =
  /^(https?:\/\/(?:www\.)?idealista\.com)\/multi\/([^/?#]+)\/((?!con-)[^/?#]+)(?:\/con-([^/?#]+))?\/?$/;
// origin | operation | location (a segment NOT starting with con-) | con tokens
const SLUG_RE =
  /^(https?:\/\/(?:www\.)?idealista\.com)\/([^/?#]+)(?:\/((?!con-)[^/?#]+))?(?:\/con-([^/?#]+))?\/?$/;

/** Parse the drawn-polygon `?shape=` grammar (the builder's output), or null. */
function parseShape(url: string): ParsedSearchUrl | null {
  const m = SHAPE_RE.exec(url);
  if (!m) return null;
  const [, origin, operation, tokensStr, shapeRaw] = m;
  if (!(operation in TYPES_BY_OPERATION)) return null;
  const ring = decodeShapeValue(shapeRaw);
  if (!ring) return null; // `shape=` present but not the `((<polyline>))` grammar

  const filters: ParsedSearchFilters = {
    section: operation,
    propertyTypes: [...TYPES_BY_OPERATION[operation]],
    locationSlug: "", // geometry, not a named slug
    geoKind: "shape",
    shapeVertexCount: ring.length,
    center: polygonCentroid(ring),
  };
  const templateTokens = parseConTokens(tokensStr, filters);
  const conPart = templateTokens.length > 0 ? `/con-${templateTokens.join(",")}` : "";
  // Keep the shape value verbatim in the template so substitute() reproduces the
  // URL byte-for-byte (the geometry is code-pinned; only numerics substitute).
  const template = `${origin}/areas/${operation}${conPart}/mapa-google?shape=${shapeRaw}`;
  return { filters, categoryKey: makeCategoryKey(operation), template };
}

/** Parse the multi-zone `/multi/<operation>/<zones>/…` grammar, or null. */
function parseMulti(url: string): ParsedSearchUrl | null {
  const m = MULTI_RE.exec(url);
  if (!m) return null;
  const [, origin, operation, zoneCodes, tokensStr] = m;
  if (!(operation in TYPES_BY_OPERATION)) return null;

  const filters: ParsedSearchFilters = {
    section: operation,
    propertyTypes: [...TYPES_BY_OPERATION[operation]],
    locationSlug: zoneCodes, // opaque Idealista neighbourhood codes
    geoKind: "multi",
  };
  const templateTokens = parseConTokens(tokensStr, filters);
  const conPart = templateTokens.length > 0 ? `/con-${templateTokens.join(",")}` : "";
  const template = `${origin}/multi/${operation}/${zoneCodes}${conPart}/`;
  return { filters, categoryKey: makeCategoryKey(operation), template };
}

/** Parse the legacy `<operation>/<municipio>-<provincia>/con-…` slug grammar. */
function parseSlug(url: string): ParsedSearchUrl | null {
  const m = SLUG_RE.exec(url);
  if (!m) return null;
  const [, origin, operation, location, tokensStr] = m;
  if (!(operation in TYPES_BY_OPERATION)) return null;

  const filters: ParsedSearchFilters = {
    section: operation,
    propertyTypes: [...TYPES_BY_OPERATION[operation]],
    locationSlug: location ?? "",
  };
  const templateTokens = parseConTokens(tokensStr, filters);
  // Lazy import avoided: centerForLocationSlug lives in parse-shared.
  filters.center = centerForLocationSlug(filters.locationSlug);

  const locationPart = filters.locationSlug ? `/${filters.locationSlug}` : "";
  const conPart = templateTokens.length > 0 ? `/con-${templateTokens.join(",")}` : "";
  const template = `${origin}/${operation}${locationPart}${conPart}/`;
  return { filters, categoryKey: makeCategoryKey(operation), template };
}

function parseIdealista(url: string): ParsedSearchUrl | null {
  const trimmed = url.trim();
  return parseShape(trimmed) ?? parseMulti(trimmed) ?? parseSlug(trimmed);
}

function substituteIdealista(
  template: string,
  scope: CanonicalSearchScope,
): { url: string; unfilled: LoosenableConstraint[] } {
  // Shape template: geometry stays verbatim; only con- numerics substitute.
  const shape = SHAPE_RE.exec(template);
  if (shape) {
    const [, origin, operation, tokensStr, shapeRaw] = shape;
    const { conPart, unfilled } = substituteConTokens(tokensStr, scope);
    return { url: `${origin}/areas/${operation}${conPart}/mapa-google?shape=${shapeRaw}`, unfilled };
  }

  // Multi template: zone codes stay verbatim; only con- numerics substitute.
  const multi = MULTI_RE.exec(template);
  if (multi) {
    const [, origin, operation, zoneCodes, tokensStr] = multi;
    const { conPart, unfilled } = substituteConTokens(tokensStr, scope);
    return { url: `${origin}/multi/${operation}/${zoneCodes}${conPart}/`, unfilled };
  }

  // Legacy slug template.
  const slug = SLUG_RE.exec(template);
  if (!slug) return { url: template, unfilled: [] };
  const [, origin, operation, location, tokensStr] = slug;
  const { conPart, unfilled } = substituteConTokens(tokensStr, scope);
  const locationPart = location ? `/${location}` : "";
  return { url: `${origin}/${operation}${locationPart}${conPart}/`, unfilled };
}

export const idealistaParser: PortalSearchUrlParser = {
  portal: PORTAL,
  parse: parseIdealista,
  substitute: substituteIdealista,
};

/**
 * Map-view → listing-view normalisation (issue #506) — server mirror of the
 * browser extension's `InmoDetect.toListingUrl` (browser-extension/detect.js).
 *
 * The builder/parser above keep `/mapa-google` as the CANONICAL round-trip form
 * (the drawn-area grammar); verbatim storage is unchanged (D-101). This util is
 * for the CONSUMPTION side only — should `resolveSearchTasks` ever need to feed
 * a searchUrl to a harvester that expects the listing (card) view, it strips the
 * `/mapa-google` path segment while preserving the query (`shape=…`) and hash
 * character-for-character. Idempotent; a no-op for any URL that is already a
 * listing path or is not parseable. Do NOT wire this into build()/parse().
 */
export function toListingUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    return url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
  const newPath = parsed.pathname.replace(/\/mapa-google(?=\/|$)/i, "");
  if (newPath === parsed.pathname) return url; // already a listing path — no-op
  parsed.pathname = /\/$/.test(newPath) ? newPath : newPath + "/";
  return parsed.toString();
}
