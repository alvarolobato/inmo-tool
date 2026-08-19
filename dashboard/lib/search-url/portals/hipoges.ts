/**
 * Hipoges pre-filtered search-URL builder + parser (issue #561).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   REVISED after a fresh-context Opus review of the first version of this
 *   file (PR #562). The route SHAPE was already grounded correctly; the
 *   TOKEN VOCABULARY inside it was not — and it did not need probing to
 *   settle. Reading the site's public `main-*.js`/`chunk-*.js`/`*.json`
 *   bundle (a static asset every visitor's browser downloads — the SAME
 *   source D-111 used for the detail-URL shape, and #548 used for the first,
 *   wrong, typology guess) answers almost the whole grammar outright:
 *
 *     - `AssetsURLValidator.canActivate` (main-*.js) validates each route
 *       segment against a real catalog and redirects home on a miss:
 *       `typologies.find(_ => _.code === params.typology)`, same shape for
 *       `operations`/`countries`.
 *     - `AssetsService.buildListingUrl` (chunk-*.js) builds the URL from
 *       `.code`, never `.dbValue` — the two are DIFFERENT strings.
 *     - The i18n bundles key typology translations as
 *       `filtersForm.subtypologies.<code>`, so `es.json`'s
 *       `filtersForm.subtypologies` object keys ARE the typology codes:
 *       `pisos-y-casas`, `locales-y-naves`, `terrenos`, `garajes`,
 *       `oficinas`, `trasteros`, `edificios`, `obra_parada`. (The first
 *       version of this file used `assetType.*` i18n keys —
 *       `flat`/`house`/`garage`/… — a DIFFERENT axis entirely; none of those
 *       six emitted tokens exist in any locale's typology vocabulary. That
 *       was the review's B1.)
 *     - `operation.dbValue` is `"venta"`/`"alquiler"` (es) — `.code` is the
 *       one token the bundle does not pin outright. The first version used
 *       the ENGLISH `dbValue` ("sale") from the wrong locale, which is
 *       exactly why the wrong guess looked plausible.
 *     - `cercaliaService.getCode` + a town→code table (chunk-*.js) confirms
 *       `:town` is `<municipio>_<provincia>` — underscore-joined, accents
 *       stripped (`"Estepona, Málaga"` → `"estepona_malaga"`) — NOT the bare
 *       municipio slug idealista/aliseda use.
 *     - `:country` values are compared against Spanish slugs (`"grecia"` is
 *       one) — `"espana"` is confirmed correct, unchanged from the first
 *       version.
 *
 *   No LIVE probing was used to settle any of this — every fact above comes
 *   from a plain GET of a public static asset, the same standing D-111 and
 *   #548 already established as fine. See D-115's "Revised" section for the
 *   full record and why the first version's own text wrongly told a future
 *   agent (and, once, the owner) that this vocabulary "cannot be verified
 *   without probing" — that conflated live probing (still correctly
 *   forbidden) with reading a public file (always fine here).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Context: #548 shipped `etl/connectors/hipoges.py` (D-111) as capture-only —
 * every sanctioned enumeration channel on `realestate.hipoges.com` 403s an
 * honest client (D-075) — but never wrote a search-URL builder, so `/captura`
 * had no Hipoges task and the owner had no entry point at all (issue #561).
 *
 * ─── GROUNDED, from the public bundle ───────────────────────────────────────
 *
 *   /:lang/:operation/:typology/:country/:town[/:features]
 *
 *   - `:lang` = `"es"` (confirmed independently — D-075/D-111's sitemap
 *     index already showed `_es_sitemap.xml` locale siblings).
 *   - `:typology` — one of `pisos-y-casas` / `locales-y-naves` / `terrenos` /
 *     `garajes` / `edificios` (plus `oficinas`/`trasteros`/`obra_parada`,
 *     which this project has no canonical property type for) — CONFIRMED
 *     codes, not a guess. A profile fans out into one task PER TYPOLOGY
 *     SECTION (not per canonical type): `pisos-y-casas` genuinely covers
 *     piso+chalet+ático as the SITE'S OWN taxonomy, not an approximation on
 *     this builder's part — same "the section is the granularity, subtypes
 *     are not narrowed" shape idealista's `venta-viviendas` already has (see
 *     idealista.ts). `locales-y-naves` likewise covers local+nave.
 *   - `:country` = `"espana"` — confirmed (country values compare against
 *     Spanish slugs in the bundle).
 *   - `:town` = `<municipio>_<provincia>`, underscore-joined, accents
 *     stripped — confirmed FORMAT from one real example
 *     ("estepona_malaga"). The exact per-town SPELLING for every town this
 *     builder might guess is not independently confirmed (only Estepona
 *     was observed) — reused from idealista/aliseda's own municipio tables
 *     as the best available starting point, same as before.
 *   - `[:features]` is a comma-joined list of CONFIG CODES (price / rooms /
 *     baths / area + subtypology — confirmed shape from
 *     `_getAssetsFeats`), not an unknowable black box. The exact codes
 *     (which number means "price max 200000"?) are not confirmed, so this
 *     builder still never guesses one in — but the honest description is
 *     "known shape, unconfirmed codes", not "no confirmed grammar at all".
 *
 * ─── The ONE remaining inferred token ───────────────────────────────────────
 *
 *   `:operation` — the bundle pins `.dbValue` (`"venta"`/`"alquiler"`) but
 *   not `.code`, which is what the route actually validates against. This
 *   builder emits `"venta"` as the most likely code (Hipoges is a REO
 *   servicer portal — sales dominate — and Spanish route bundles commonly
 *   reuse the Spanish-locale dbValue as the code). Every task carries a
 *   `"grammar"` loosened flag scoped to THIS token alone — see below.
 *
 * ─── Capture-to-infer actually closes the loop now (D-051) ─────────────────
 *
 * The first version's parser rejected any URL whose operation wasn't
 * literally "sale"/"rent" and any typology outside its (wrong) token set —
 * so a real owner capture would have decoded to `null` and never been
 * learned (the review's B2). `hipogesParser` below accepts ANY operation
 * token and ANY typology token: a real capture is always learnable, even
 * before this file's own guesses are confirmed or corrected. `resolve.ts`
 * also exempts Hipoges from the #444 "code-driven town is authoritative"
 * gate (this builder's town is an admitted guess, not a confirmed slug the
 * way idealista's is), so same-area reuse (tier 2) is actually reachable.
 */

import { PROPERTY_TYPES } from "@/lib/profiles-schema";
import { municipioForPoint, KNOWN_MUNICIPIOS } from "../municipios";
import { provinceForPoint } from "../provinces";
import { stableTaskId } from "../task-id";
import { taskLabel } from "../labels";
import { makeCategoryKey } from "../parse-shared";
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

const ORIGIN = "https://realestate.hipoges.com";
const PORTAL = "hipoges";

// Confirmed (D-075/D-111's sitemap index).
const LANG = "es";

// The ONE inferred token (see module docstring) — the bundle pins .dbValue
// ("venta"/"alquiler") but not the .code the route actually validates.
// "venta" is the most likely code; flagged via GRAMMAR_FLAG below, and ONLY
// this token — nothing else in the route is a guess any more.
const OPERATION = "venta";

// Confirmed — country values compare against Spanish slugs in the bundle
// (e.g. "grecia"), so "espana" is not a guess.
const COUNTRY = "espana";

/**
 * Canonical property type -> CONFIRMED Hipoges typology code (from the
 * public i18n bundle's `filtersForm.subtypologies` keys — see module
 * docstring). Several canonical types legitimately share one typology
 * section: that is the SITE'S OWN taxonomy, not an approximation on this
 * builder's part, so — unlike the first version of this file — no
 * `property_types` loosened flag is attached for it, same as idealista's
 * `venta-viviendas` (piso+chalet+atico, no flag) already does.
 */
const TYPOLOGY_BY_TYPE: Record<PropertyType, string> = {
  piso: "pisos-y-casas",
  chalet: "pisos-y-casas",
  atico: "pisos-y-casas",
  local: "locales-y-naves",
  nave: "locales-y-naves",
  garaje: "garajes",
  terreno: "terrenos",
  edificio: "edificios",
};

/**
 * Typology code -> canonical property type(s), the parser's reverse of
 * TYPOLOGY_BY_TYPE, for decoding a REAL captured URL. Deliberately partial:
 * `oficinas`/`trasteros`/`obra_parada` are real, confirmed typology codes
 * (see module docstring) this project has no canonical type for — a captured
 * URL using one of those still parses and is still learnable (never
 * rejected), it just decodes to an empty `propertyTypes` (honest "we don't
 * know which of our types this is", never fabricated).
 */
const TYPOLOGY_TO_TYPES: Record<string, readonly PropertyType[]> = {
  "pisos-y-casas": ["piso", "chalet", "atico"],
  "locales-y-naves": ["local", "nave"],
  garajes: ["garaje"],
  terrenos: ["terreno"],
  edificios: ["edificio"],
};

/** Property types in canonical order, grouped by their (now CONFIRMED) typology section. */
function sectionsInOrder(
  types: readonly PropertyType[],
): Array<{ typology: string; types: PropertyType[] }> {
  const wanted = new Set(types);
  const bySection = new Map<string, PropertyType[]>();
  for (const t of PROPERTY_TYPES) {
    if (!wanted.has(t)) continue;
    const typology = TYPOLOGY_BY_TYPE[t];
    const bucket = bySection.get(typology);
    if (bucket) bucket.push(t);
    else bySection.set(typology, [t]);
  }
  return [...bySection.entries()].map(([typology, ts]) => ({ typology, types: ts }));
}

/**
 * The ONLY loosened flag this builder ever attaches unconditionally
 * (issue #561 review) — scoped to the `:operation` token alone, the one
 * remaining inference. Every other route segment is confirmed from the
 * public bundle (see module docstring).
 */
const OPERATION_GRAMMAR_FLAG: LoosenedConstraint = {
  constraint: "grammar",
  reason:
    'Hipoges: el token de operación ("venta") no está confirmado — el bundle público fija el valor mostrado ' +
    '("venta"/"alquiler") pero no el código interno que exige la ruta, y se usa "venta" como el más probable. ' +
    "El resto de la ruta (tipología, país, localidad) SÍ está confirmado en el bundle público del sitio. Si esta " +
    "búsqueda da error o muestra algo distinto, navega a mano y captúrala — tu navegación real corrige este " +
    "token (D-051).",
};

/** Title-case a slug like `dos-hermanas` -> "Dos Hermanas" (label only). */
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * A province's own capital as its KNOWN_MUNICIPIOS entry (both known
 * provinces' capitals are self-referential rows: `{municipio: "malaga",
 * provincia: "malaga"}`, `{municipio: "sevilla", provincia: "sevilla"}`) —
 * the coarse "search the whole province" proxy when no closer municipio
 * resolves. Reuses an existing table entry rather than inventing a new
 * string.
 */
function provinceCapital(provincia: string): { municipio: string; provincia: string } | null {
  const m = KNOWN_MUNICIPIOS.find((km) => km.municipio === provincia);
  return m ? { municipio: m.municipio, provincia: m.provincia } : null;
}

/** Absolute last resort when nothing resolves at all (outside every known
 * market) — the confirmed `<municipio>_<provincia>` FORMAT applied to a
 * single, clearly-arbitrary national default (issue #561 review, N4: the
 * previous fallback repeated the country segment as "espana/espana", which
 * reads as a bug rather than a deliberate default). Madrid is not grounded
 * as Hipoges' own vocabulary either — it is simply not nonsensical the way
 * repeating the country segment is. */
const NATIONAL_FALLBACK = { municipio: "madrid", provincia: "madrid" };

/** Resolved `{municipio, provincia}` + a human label for `:town`. */
function resolveTown(
  scope: CanonicalSearchScope,
): { municipio: string; provincia: string; label: string } {
  const muni = municipioForPoint(scope.center);
  if (muni) return { municipio: muni.municipio, provincia: muni.provincia, label: titleCaseSlug(muni.municipio) };
  const prov = provinceForPoint(scope.center);
  if (prov) {
    const capital = provinceCapital(prov.provincia);
    if (capital) return { ...capital, label: titleCaseSlug(capital.municipio) };
  }
  return { ...NATIONAL_FALLBACK, label: "España" };
}

function buildTask(typology: string, types: PropertyType[], scope: CanonicalSearchScope): SearchTask {
  const loosened: LoosenedConstraint[] = [OPERATION_GRAMMAR_FLAG];

  const { municipio, provincia, label: townLabel } = resolveTown(scope);
  const town = `${municipio}_${provincia}`;

  // Price/size: [:features] is a confirmed comma-joined list of CONFIG
  // CODES (price/rooms/baths/area + subtypology — see module docstring),
  // but the exact codes are unconfirmed, so never guessed in. A profile
  // bound is reported as dropped rather than risk a wrong code.
  if (scope.priceMin !== undefined) {
    loosened.push({
      constraint: "price_min",
      reason:
        "Hipoges: [:features] es una lista de códigos de configuración conocida (precio/habitaciones/baños/" +
        "superficie), pero los códigos exactos no están confirmados; no se aplica el precio mínimo (resultados más amplios).",
    });
  }
  if (scope.priceMax !== undefined) {
    loosened.push({
      constraint: "price_max",
      reason:
        "Hipoges: [:features] es una lista de códigos de configuración conocida (precio/habitaciones/baños/" +
        "superficie), pero los códigos exactos no están confirmados; no se aplica el precio máximo (resultados más amplios).",
    });
  }
  if (scope.sizeMin !== undefined) {
    loosened.push({
      constraint: "size_min",
      reason:
        "Hipoges: [:features] es una lista de códigos de configuración conocida, pero los códigos exactos de " +
        "superficie no están confirmados; no se aplica el mínimo (resultados más amplios).",
    });
  }
  if (scope.sizeMax !== undefined) {
    loosened.push({
      constraint: "size_max",
      reason:
        "Hipoges: [:features] es una lista de códigos de configuración conocida, pero los códigos exactos de " +
        "superficie no están confirmados; no se aplica el máximo (resultados más amplios).",
    });
  }

  const url = `${ORIGIN}/${LANG}/${OPERATION}/${typology}/${COUNTRY}/${town}`;

  // Section = operation + typology (categorical identity for D-051
  // matching; includes operation since the typology token alone does not
  // encode sale-vs-rent).
  const section = `${OPERATION}/${typology}`;

  const id = stableTaskId({
    portal: PORTAL,
    section,
    location: `${COUNTRY}/${town}`,
    priceMin: scope.priceMin,
    priceMax: scope.priceMax,
    sizeMin: scope.sizeMin,
    sizeMax: scope.sizeMax,
  });

  return {
    id,
    portal: PORTAL,
    label: taskLabel(PORTAL, types, townLabel, scope.priceMin, scope.priceMax),
    url,
    // Hipoges has no map view -> captureUrl == url (identity), same as Aliseda.
    captureUrl: url,
    loosened,
  };
}

function buildHipoges(scope: CanonicalSearchScope): SearchTask[] {
  return sectionsInOrder(scope.propertyTypes).map(({ typology, types }) =>
    buildTask(typology, types, scope),
  );
}

/**
 * The Hipoges CODE mapping (issue #371, D-090) — the CONFIRMED typology
 * codes this builder emits, for drift detection against any future captured
 * filter catalog. Unlike idealista/aliseda this connector never discovers a
 * live catalog (capture-only, D-075/D-111), so there is nothing to drift
 * against yet; exposed anyway for API-shape consistency with the other
 * builders.
 */
function hipogesCodeMapping(): CodeMappingAxes {
  const bySlug = new Map<string, CodeMappingOption>();
  for (const [type, typology] of Object.entries(TYPOLOGY_BY_TYPE) as [PropertyType, string][]) {
    if (bySlug.has(typology)) continue; // first canonical type owns the slug
    bySlug.set(typology, { slug: typology, label: type, canonicalType: type });
  }
  return { property_type: [...bySlug.values()] };
}

export const hipogesBuilder: PortalSearchUrlBuilder = {
  portal: PORTAL,
  build: buildHipoges,
  codeMapping: hipogesCodeMapping,
};

// ─── parse(): the structural inverse of buildHipoges (D-051 capture-to-infer) ─
//
// Recognises `/<lang>/<operation>/<typology>/<country>/<town>[/<features>]`
// for ANY operation/typology token — NOT just the ones build() emits (issue
// #561 review, B2: the first version whitelisted `sale|rent` and a fixed
// typology set, so a REAL captured URL — which necessarily uses tokens this
// builder didn't happen to guess right — decoded to null and was silently
// never learned; D-051's whole point is broken if the thing meant to teach
// this file a URL never accepts one). The only structural exclusion is the
// 2nd path segment (the operation slot) being literally "detail" — Hipoges'
// detail routes (`/:lang/detail/:id`, `/:lang/:investment/detail/:id[/...]`)
// put "detail" in that position, and this parser must never conflate the two
// shapes.

// origin | lang | operation | typology | country | town | optional features | optional query
const PATH_RE =
  /^(https?:\/\/(?:www\.)?realestate\.hipoges\.com)\/([a-z]{2})\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:\?([^#]*))?$/i;

interface HipogesPathParts {
  origin: string;
  lang: string;
  operation: string;
  typology: string;
  country: string;
  town: string;
  features?: string;
  query?: string;
}

function splitHipogesPath(url: string): HipogesPathParts | null {
  const m = PATH_RE.exec(url.trim());
  if (!m) return null;
  const [, origin, lang, operation, typology, country, town, features, query] = m;
  if (operation.toLowerCase() === "detail" || typology.toLowerCase() === "detail") {
    return null; // this is a detail URL shape, not a search — never conflate the two
  }
  return {
    origin,
    lang,
    operation: operation.toLowerCase(),
    typology: typology.toLowerCase(),
    country,
    town,
    features,
    query,
  };
}

/** Approximate `[lat, lng]` centroid for a `:town` token, best-effort only —
 * only the municipio half of `<municipio>_<provincia>` is looked up, and
 * only when it happens to match a KNOWN_MUNICIPIOS entry (e.g. because a
 * learned example came from this builder's own guessed town). Never
 * fabricated. */
function centerForTown(town: string): [number, number] | undefined {
  const municipio = town.split("_")[0]?.toLowerCase();
  const m = KNOWN_MUNICIPIOS.find((km) => km.municipio === municipio);
  return m ? [m.center[0], m.center[1]] : undefined;
}

function rebuildPath(p: Omit<HipogesPathParts, "origin">): string {
  const base = `/${p.lang}/${p.operation}/${p.typology}/${p.country}/${p.town}`;
  const withFeatures = p.features ? `${base}/${p.features}` : base;
  return p.query ? `${withFeatures}?${p.query}` : withFeatures;
}

function parseHipoges(url: string): ParsedSearchUrl | null {
  const p = splitHipogesPath(url);
  if (!p) return null;

  // Unrecognised typology -> propertyTypes decodes to [] (honest "we don't
  // know which of our types this is"), never rejected outright (issue #561
  // review, B2) — the URL is still stored and still learnable.
  const propertyTypes = [...(TYPOLOGY_TO_TYPES[p.typology] ?? [])];
  const locationSlug = `${p.country}/${p.town}`;
  const section = `${p.operation}/${p.typology}`;

  const filters: ParsedSearchFilters = {
    section,
    propertyTypes,
    locationSlug,
    center: centerForTown(p.town),
  };

  const template = `${p.origin}${rebuildPath(p)}`;
  return { filters, categoryKey: makeCategoryKey(section), template };
}

/**
 * No numeric placeholder exists in a Hipoges template ([:features]'s exact
 * codes are unconfirmed — module docstring) — substitute() therefore never
 * rewrites the template itself; it only reports the profile's price/size
 * bounds as "unfilled" so the resolver flags them exactly like build() does,
 * keeping a tier-1/tier-2 upgraded task just as honest about what it can't
 * express.
 */
function substituteHipoges(
  template: string,
  scope: CanonicalSearchScope,
): { url: string; unfilled: LoosenableConstraint[] } {
  const unfilled: LoosenableConstraint[] = [];
  if (scope.priceMin !== undefined) unfilled.push("price_min");
  if (scope.priceMax !== undefined) unfilled.push("price_max");
  if (scope.sizeMin !== undefined) unfilled.push("size_min");
  if (scope.sizeMax !== undefined) unfilled.push("size_max");
  return { url: template, unfilled };
}

export const hipogesParser: PortalSearchUrlParser = {
  portal: PORTAL,
  parse: parseHipoges,
  substitute: substituteHipoges,
};
