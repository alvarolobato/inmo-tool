/**
 * Aliseda pre-filtered search-URL builder.
 *
 * ─── Grammar (verified against the live portal 2026-08-05, issue #336) ───────
 *
 * Aliseda organises its catalogue as a set of TOP-LEVEL category paths, each
 * nested by region:
 *
 *   /comprar-<category>/<comunidad>/<provincia>
 *
 * The residential category `comprar-viviendas` additionally carries a SUBTYPE
 * as an extra path segment + a numeric `?subtipo=<code>`:
 *
 *   /comprar-viviendas/<subtype-slug>/<comunidad>/<provincia>?subtipo=<code>
 *
 * Confirmed real example (owner-tested — Estepona-area piso, ≤ 200 000 €):
 *
 *   https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000
 *
 * ─── What was WRONG before #336 ──────────────────────────────────────────────
 * The previous builder nested EVERY property type under `comprar-viviendas`
 * (e.g. `/comprar-viviendas/locales/…`, `/comprar-viviendas/aticos/…`). That is
 * broken: `local`/`nave`/`garaje`/`terreno`/`edificio` are their OWN top-level
 * `comprar-<category>` paths, and — the driving bug — Aliseda has **no `ático`
 * category at all** (the string "atico" appears zero times in the portal's app
 * bundle; áticos are published as `pisos`). So the emitted `…/aticos/…` slug
 * matched nothing → the search 404'd / returned no results.
 *
 * ─── Provenance of the mapping (no live network in tests) ─────────────────────
 * Category slugs verified from the live category sitemap
 * (`/sitemap-category-aliseda-es-0.xml`, 2026-08-05): the distinct top-level
 * `comprar-*` segments are viviendas, locales, naves, garajes, terrenos,
 * edificios, oficinas, trasteros, obras-paradas, negocios, otros.
 * Vivienda subtype slugs verified from the app bundle's i18n slug map
 * (`main-*.js`, 2026-08-05): pisos, duplex, pisos-turisticos, lofts, casas,
 * chalets-adosados, chalets-pareados — there is NO `aticos`.
 * `subtipo` codes verified from Google-indexed real category URLs:
 * `pisos → 36`, `chalets-adosados → 31`. Other codes are NOT guessed.
 *
 * ─── Canonical-type → Aliseda mapping ────────────────────────────────────────
 *   piso     → comprar-viviendas / pisos (subtipo=36) ............... exact
 *   atico    → comprar-viviendas / pisos (subtipo=36) ....... folded, broadened
 *              (Aliseda has no ático bucket; áticos are pisos → broader search)
 *   chalet   → comprar-viviendas / chalets-adosados (subtipo=31) . approximate
 *              (Aliseda splits houses into casas / chalets-adosados /
 *               chalets-pareados; no single "chalet" filter → flagged)
 *   local    → comprar-locales ..................................... exact
 *   nave     → comprar-naves ...................................... exact
 *   garaje   → comprar-garajes .................................... exact
 *   terreno  → comprar-terrenos ................................... exact
 *   edificio → comprar-edificios .................................. exact
 *
 * Aliseda encodes ONE search per (category × subtype), so a multi-type profile
 * fans out into ONE TASK PER type. Types that collapse onto the same Aliseda
 * URL (piso + atico → pisos) are de-duplicated, keeping the exact one.
 *
 * Geography: Aliseda has NO radius search — a point+radius always broadens to
 * the whole province, so geography is ALWAYS loosened. Province slugs come from
 * ../provinces.ts (bounding boxes). A point matching no known province drops the
 * geo segments (province-less search) and flags.
 *
 * The path/query spellings are the volatile part; they live in this one file so
 * refreshing them is a local edit. NB idealista.ts is a SEPARATE grammar — do
 * not cross-reference the two.
 */

import { provinceForPoint } from "../provinces";
import { stableTaskId } from "../task-id";
import { taskLabel } from "../labels";
import {
  centerForLocationSlug,
  inCanonicalOrder,
  makeCategoryKey,
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

const ORIGIN = "https://www.alisedainmobiliaria.com";
const PORTAL = "aliseda";

/** A residential subtype: the `comprar-viviendas` path slug + its `?subtipo=` code. */
interface VivendaSubtype {
  slug: string;
  code: number;
}

/** How one canonical property type maps onto Aliseda's URL grammar. */
interface AlisedaTypeMapping {
  /** Top-level category path segment, e.g. `comprar-viviendas` / `comprar-locales`. */
  category: string;
  /** Present only for residential types: the vivienda subtype slug + subtipo code. */
  subtype?: VivendaSubtype;
  /**
   * Set when this canonical type has no exact Aliseda equivalent and is mapped
   * onto a BROADER or approximate Aliseda bucket. Surfaced as a `property_types`
   * loosened flag so the operator knows the open search isn't an exact match.
   */
  approxReason?: string;
}

export const VIVIENDAS = "comprar-viviendas";

/** Canonical property type → Aliseda category / subtype (verified 2026-08-05, #336). */
const TYPE_MAP: Record<PropertyType, AlisedaTypeMapping> = {
  // Residential — one `comprar-viviendas` category split into subtypes.
  piso: { category: VIVIENDAS, subtype: { slug: "pisos", code: 36 } },
  atico: {
    category: VIVIENDAS,
    subtype: { slug: "pisos", code: 36 },
    approxReason:
      "Aliseda no tiene una categoría «ático»: los áticos se publican como pisos. " +
      "La búsqueda se hace en «pisos» (más amplia — incluye pisos que no son áticos).",
  },
  chalet: {
    category: VIVIENDAS,
    subtype: { slug: "chalets-adosados", code: 31 },
    approxReason:
      "Aliseda divide las casas en «casas», «chalets adosados» y «chalets pareados»; " +
      "no existe un filtro único «chalet». Se usa «chalets adosados»; revisa a mano " +
      "pareados y casas independientes si procede.",
  },
  // Non-residential — each is its OWN top-level category (NOT nested under viviendas).
  local: { category: "comprar-locales" },
  nave: { category: "comprar-naves" },
  garaje: { category: "comprar-garajes" },
  terreno: { category: "comprar-terrenos" },
  edificio: { category: "comprar-edificios" },
};

/** Geography resolved once per profile (same province for every task). */
interface GeoResolution {
  /** Region path segments (`[comunidad, provincia]` or `[]`). */
  segments: string[];
  /** Location key for the deterministic task id (`comunidad/provincia` or ""). */
  idLocation: string;
  /** Slug used for the human label (province slug, or "" → "toda España"). */
  labelSlug: string;
  /** The always-present geography loosened flag. */
  flag: LoosenedConstraint;
}

function resolveGeo(scope: CanonicalSearchScope): GeoResolution {
  const province = provinceForPoint(scope.center);
  if (province) {
    return {
      segments: [province.comunidad, province.provincia],
      idLocation: `${province.comunidad}/${province.provincia}`,
      labelSlug: province.provincia,
      flag: {
        constraint: "geography",
        reason:
          `Aliseda no busca por radio; la zona se aproxima a la provincia entera ` +
          `(${province.comunidad}/${province.provincia}), más amplia que el radio de ` +
          `${scope.radiusKm} km del perfil. Acota la zona a mano.`,
      },
    };
  }
  return {
    segments: [],
    idLocation: "",
    labelSlug: "",
    flag: {
      constraint: "geography",
      reason:
        `Provincia no determinada a partir de las coordenadas ` +
        `(${scope.center[0]}, ${scope.center[1]}); se busca sin filtro geográfico ` +
        `(catálogo completo). Acota la zona a mano.`,
    },
  };
}

/** Build the single task for one property type. */
function buildTask(
  type: PropertyType,
  geo: GeoResolution,
  scope: CanonicalSearchScope,
): SearchTask {
  const loosened: LoosenedConstraint[] = [];
  const map = TYPE_MAP[type];

  // URL building is 100% code-driven (D-090, issue #371). The hard-coded
  // TYPE_MAP is authoritative — discovery no longer overrides the slug/subtipo.
  // Drift between this map and the portal's live options is DETECTED separately
  // (lib/search-url/drift.ts, surfaced on /etl/discovery) so a human updates
  // this map; the builder never self-heals from the discovered catalog.
  const slug = map.subtype?.slug;
  const code = map.subtype?.code;

  const segments = [map.category];
  if (slug) segments.push(slug);
  segments.push(...geo.segments);

  loosened.push(geo.flag);

  if (map.approxReason) {
    loosened.push({ constraint: "property_types", reason: map.approxReason });
  }

  const params = new URLSearchParams();
  if (code !== undefined) params.set("subtipo", String(code));

  // precio=<min>-<max>: hyphen range, no separators. min defaults to 0. Needs
  // an upper bound to form a range; a lower-bound-only profile can't be
  // expressed, so we drop the floor (broader) and flag.
  if (scope.priceMax !== undefined) {
    const min = scope.priceMin !== undefined ? Math.round(scope.priceMin) : 0;
    params.set("precio", `${min}-${Math.round(scope.priceMax)}`);
  } else if (scope.priceMin !== undefined) {
    loosened.push({
      constraint: "price_min",
      reason:
        `Aliseda expresa el precio como rango «min-max»; sin límite superior no se ` +
        `puede formar el rango, así que se omite el mínimo (resultados más baratos incluidos).`,
    });
  }

  // Size: no confirmed Aliseda grammar for superficie → drop + flag if present.
  if (scope.sizeMin !== undefined) {
    loosened.push({
      constraint: "size_min",
      reason:
        "Aliseda: sin gramática confirmada para superficie; no se aplica el mínimo (resultados más amplios).",
    });
  }
  if (scope.sizeMax !== undefined) {
    loosened.push({
      constraint: "size_max",
      reason:
        "Aliseda: sin gramática confirmada para superficie; no se aplica el máximo (resultados más amplios).",
    });
  }

  const path = `/${segments.join("/")}`;
  const query = params.toString(); // hyphen + digits are URL-safe, so precio survives verbatim
  const url = query ? `${ORIGIN}${path}?${query}` : `${ORIGIN}${path}`;

  // Section = the URL's discriminating segment: the code-mapped subtype slug for
  // viviendas, else the category. Two types that collapse onto
  // the same section+filters (piso + atico → pisos) get the same id and are
  // de-duplicated in build().
  const section = slug ?? map.category;

  const id = stableTaskId({
    portal: PORTAL,
    section,
    location: geo.idLocation,
    priceMin: scope.priceMin,
    priceMax: scope.priceMax,
    sizeMin: scope.sizeMin,
    sizeMax: scope.sizeMax,
  });

  return {
    id,
    portal: PORTAL,
    label: taskLabel(
      PORTAL,
      [type],
      geo.labelSlug,
      scope.priceMin,
      scope.priceMax,
    ),
    url,
    // Aliseda has no map view → captureUrl == url (identity). Set at construction
    // so buildSearchUrls() output is a valid SearchTask (#529).
    captureUrl: url,
    loosened,
  };
}

function buildAliseda(scope: CanonicalSearchScope): SearchTask[] {
  const geo = resolveGeo(scope);
  const seen = new Set<string>();
  const tasks: SearchTask[] = [];
  // Canonical order → piso precedes atico, so the exact `pisos` task wins the
  // de-dup over atico's folded (broadened) one.
  for (const type of inCanonicalOrder(scope.propertyTypes)) {
    const task = buildTask(type, geo, scope);
    if (seen.has(task.url)) continue;
    seen.add(task.url);
    tasks.push(task);
  }
  return tasks;
}

/**
 * The Aliseda CODE mapping, per axis (issue #371, D-090) — the property-type
 * slugs + subtipo codes TYPE_MAP emits, for drift detection against the portal's
 * captured catalog. Identity is the URL slug the builder emits: the residential
 * subtype slug (`pisos`, `chalets-adosados`) for viviendas, else the top-level
 * `comprar-<category>` segment (`comprar-locales`, …). Types that collapse onto
 * the same slug (piso + atico → `pisos`) are de-duplicated; the first canonical
 * type in TYPE_MAP order wins that slug's `canonicalType`.
 */
function alisedaCodeMapping(): CodeMappingAxes {
  const bySlug = new Map<string, CodeMappingOption>();
  for (const [type, map] of Object.entries(TYPE_MAP) as [PropertyType, AlisedaTypeMapping][]) {
    const slug = map.subtype?.slug ?? map.category;
    if (bySlug.has(slug)) continue; // first canonical type owns the slug
    bySlug.set(slug, {
      slug,
      label: type,
      code: map.subtype?.code,
      canonicalType: type,
    });
  }
  return { property_type: [...bySlug.values()] };
}

export const alisedaBuilder: PortalSearchUrlBuilder = {
  portal: PORTAL,
  build: buildAliseda,
  codeMapping: alisedaCodeMapping,
};

// ─── parse(): the structural inverse of buildAliseda (issue #293 / #336) ─────
//
// build() emits `/comprar-<category>[/<subtype-slug>][/<comunidad>/<provincia>]?subtipo=<code>&precio=<min>-<max>`.
// parse() reads it back — and, since the save route (search-url-example.ts) and
// resolver feed it REAL operator-navigated URLs, it also decodes captured URLs
// across every Aliseda category, not only the ones build() emits. Round-trip
// tests (parse.test.ts / aliseda.test.ts) fail loudly on any build() drift.

/** Known top-level Aliseda categories (superset of what build() emits). */
export const CATEGORY_SLUGS: ReadonlySet<string> = new Set([
  "comprar-viviendas",
  "comprar-locales",
  "comprar-naves",
  "comprar-garajes",
  "comprar-terrenos",
  "comprar-edificios",
  "comprar-oficinas",
  "comprar-trasteros",
  "comprar-obras-paradas",
  "comprar-negocios",
  "comprar-otros",
  "comprar-todos",
]);

/** Residential subtype slugs (verified from the app bundle, 2026-08-05). */
export const VIVIENDA_SUBTYPE_SLUGS: ReadonlySet<string> = new Set([
  "pisos",
  "duplex",
  "pisos-turisticos",
  "lofts",
  "casas",
  "chalets-adosados",
  "chalets-pareados",
]);

/** Subtype slug → canonical coarse property type (parse direction). */
const SUBTYPE_TO_TYPE: Record<string, PropertyType> = {
  pisos: "piso",
  duplex: "piso",
  "pisos-turisticos": "piso",
  lofts: "piso",
  casas: "chalet",
  "chalets-adosados": "chalet",
  "chalets-pareados": "chalet",
};

/** Category slug → canonical property type(s) when no subtype narrows it. */
const CATEGORY_TO_TYPES: Record<string, PropertyType[]> = {
  "comprar-viviendas": ["piso", "chalet", "atico"],
  "comprar-locales": ["local"],
  "comprar-naves": ["nave"],
  "comprar-garajes": ["garaje"],
  "comprar-terrenos": ["terreno"],
  "comprar-edificios": ["edificio"],
};

const PRECIO_PLACEHOLDER = `${PLACEHOLDER.priceMin}-${PLACEHOLDER.priceMax}`;

// origin | category | remaining path segments | query (without leading ?)
const PATH_RE =
  /^(https?:\/\/(?:www\.)?alisedainmobiliaria\.com)\/(comprar-[a-z0-9-]+)((?:\/[^/?#]+)*)(?:\?([^#]*))?$/;

interface AlisedaPathParts {
  origin: string;
  category: string;
  subtypeSlug?: string;
  /** Region path segments after the (optional) subtype, e.g. `["andalucia","malaga"]`. */
  regionSegments: string[];
  rawQuery?: string;
}

/** Split an Aliseda URL into {category, subtype?, region, query}, or null. */
function splitAlisedaPath(url: string): AlisedaPathParts | null {
  const m = PATH_RE.exec(url.trim());
  if (!m) return null;
  const [, origin, category, rest, rawQuery] = m;
  if (!CATEGORY_SLUGS.has(category)) return null;

  const segs = rest ? rest.split("/").filter(Boolean) : [];
  let subtypeSlug: string | undefined;
  if (
    category === "comprar-viviendas" &&
    segs.length > 0 &&
    VIVIENDA_SUBTYPE_SLUGS.has(segs[0])
  ) {
    subtypeSlug = segs.shift();
  }
  return { origin, category, subtypeSlug, regionSegments: segs, rawQuery };
}

function parseAliseda(url: string): ParsedSearchUrl | null {
  const p = splitAlisedaPath(url);
  if (!p) return null;
  const { origin, category, subtypeSlug, regionSegments, rawQuery } = p;

  const locationSlug = regionSegments.join("/");
  const section = subtypeSlug ?? category;
  // subtypeSlug is only set when it's a known VIVIENDA_SUBTYPE_SLUGS entry, and
  // every such slug has a SUBTYPE_TO_TYPE mapping — so the lookup is total.
  const propertyTypes = subtypeSlug
    ? [SUBTYPE_TO_TYPE[subtypeSlug]]
    : (CATEGORY_TO_TYPES[category] ?? []);

  const filters: ParsedSearchFilters = {
    section,
    propertyTypes,
    locationSlug,
    center: centerForLocationSlug(locationSlug),
  };

  let templateQuery = rawQuery ?? "";
  if (rawQuery) {
    const params = new URLSearchParams(rawQuery);
    const precio = params.get("precio");
    if (precio) {
      const mm = /^(\d+)-(\d+)$/.exec(precio);
      if (mm) {
        if (Number(mm[1]) > 0) filters.priceMin = Number(mm[1]); // 0 is the "no min" sentinel
        filters.priceMax = Number(mm[2]);
        templateQuery = templateQuery.replace(
          /precio=\d+-\d+/,
          `precio=${PRECIO_PLACEHOLDER}`,
        );
      }
    }
  }

  const path = alisedaPath(category, subtypeSlug, locationSlug);
  const template = templateQuery
    ? `${origin}${path}?${templateQuery}`
    : `${origin}${path}`;
  return { filters, categoryKey: makeCategoryKey(section), template };
}

/** Rebuild the path portion from its parts (shared by parse + substitute). */
function alisedaPath(
  category: string,
  subtypeSlug: string | undefined,
  locationSlug: string,
): string {
  const parts = [category];
  if (subtypeSlug) parts.push(subtypeSlug);
  if (locationSlug) parts.push(locationSlug);
  return `/${parts.join("/")}`;
}

function substituteAliseda(
  template: string,
  scope: CanonicalSearchScope,
): { url: string; unfilled: LoosenableConstraint[] } {
  const p = splitAlisedaPath(template);
  if (!p) return { url: template, unfilled: [] };
  const { origin, category, subtypeSlug, regionSegments, rawQuery } = p;
  const locationSlug = regionSegments.join("/");
  const unfilled: LoosenableConstraint[] = [];

  const outParams: string[] = [];
  const hasPrecioPlaceholder = (rawQuery ?? "").includes(PRECIO_PLACEHOLDER);
  if (rawQuery) {
    for (const part of rawQuery.split("&")) {
      if (part === `precio=${PRECIO_PLACEHOLDER}`) {
        if (scope.priceMax !== undefined) {
          const min =
            scope.priceMin !== undefined ? Math.round(scope.priceMin) : 0;
          outParams.push(`precio=${min}-${Math.round(scope.priceMax)}`);
        } else if (scope.priceMin !== undefined) {
          // No upper bound → can't form the range → drop the floor (broader).
          unfilled.push("price_min");
        }
        continue;
      }
      outParams.push(part); // subtipo / literal
    }
  }

  // Price the template can't express, and size (aliseda has no size grammar).
  if (scope.priceMax !== undefined && !hasPrecioPlaceholder)
    unfilled.push("price_max");
  if (scope.sizeMin !== undefined) unfilled.push("size_min");
  if (scope.sizeMax !== undefined) unfilled.push("size_max");

  const path = alisedaPath(category, subtypeSlug, locationSlug);
  const query = outParams.join("&");
  return {
    url: query ? `${origin}${path}?${query}` : `${origin}${path}`,
    unfilled,
  };
}

export const alisedaParser: PortalSearchUrlParser = {
  portal: PORTAL,
  parse: parseAliseda,
  substitute: substituteAliseda,
};
