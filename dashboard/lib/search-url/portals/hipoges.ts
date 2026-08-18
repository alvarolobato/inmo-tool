/**
 * Hipoges pre-filtered search-URL builder + parser (issue #561).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   GROUNDED SHAPE, INFERRED VOCABULARY — see the "Confirmed vs inferred"
 *   section below before touching this file. The owner's first real Hipoges
 *   search corrects the guessed tokens via capture-to-infer (D-051) — that is
 *   this file's actual safety net, not the tokens themselves.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Context: #548 shipped `etl/connectors/hipoges.py` (D-111) as capture-only —
 * every sanctioned enumeration channel on `realestate.hipoges.com` 403s an
 * honest client (D-075) — but never wrote a search-URL builder, so `/captura`
 * had no Hipoges task and the owner had no entry point at all (issue #561).
 *
 * ─── GROUNDED (read from the site's public Angular route table — the same
 *     static `main-*.js` / `chunk-*.js` bundle that grounded the detail-URL
 *     shape in D-111, no probing) ───────────────────────────────────────────
 *
 *   :lang/:operation/:typology/:country/:town[/:features]   (listing/search)
 *
 * See etl/connectors/hipoges.py's module docstring for the verbatim route
 * table this is read from.
 *
 * ─── NOT GROUNDED — INFERRED, never observed on a real URL ─────────────────
 *
 *   - `:operation` — inferred "sale" / "rent" (English route tokens). #548
 *     inferred these from the site's own public i18n key names
 *     (`assets/i18n/es.json`), which is also what `hipoges_mapping.map_operation`
 *     already expects to reverse-decode. This builder only ever emits "sale"
 *     (idealista/aliseda's own precedent: the profile scope has no operation
 *     field at all, so every builder here is sale-only).
 *   - `:typology` — inferred per canonical property type from the SAME i18n
 *     bundle's key names (`flat`/`house`/`garage`/`storage`/`land`/`office`/
 *     `building`/`apartment` — see hipoges_mapping.py's comment). A canonical
 *     type with no confident 1:1 match folds onto the nearest inferred token
 *     and is flagged (same discipline as Aliseda's ático/chalet folding).
 *   - `:country` and `:town` — genuinely NOT inferred from anything (no i18n
 *     evidence, no captured example, nothing). This builder guesses "espana"
 *     for `:country` and reuses the Idealista/Aliseda municipio/province
 *     tables (`municipios.ts`/`provinces.ts` — themselves grounded for THOSE
 *     portals' own slug spelling, not Hipoges') for `:town`, purely as a
 *     starting point. This is the least grounded segment of the URL.
 *
 * A wrong token either 404s (safe — visibly broken) or silently returns a
 * DIFFERENT search (dangerous — looks fine, isn't). Every task this builder
 * emits therefore carries a `"grammar"` loosened flag, unconditionally, that
 * says so in the UI — never presented as confirmed. See
 * docs/decisions/D-115-hipoges-search-url-inferred-grammar.md.
 *
 * ─── Capture-to-infer closes the loop (D-051) ───────────────────────────────
 *
 * `hipogesParser` below is registered in `../parsers.ts`, so the FIRST time
 * the owner navigates a real Hipoges search and clicks "Capturar todas", the
 * extension's existing `POST /api/extension/search-url-example` piggyback
 * (D-051, unchanged by this file) decodes and stores it as a CONFIRMED,
 * auto-trusted example — the resolver (`resolve.ts`) then prefers it over
 * this builder's guess for every future task in the same section, with the
 * guessed-grammar flag dropped (same upgrade idealista/aliseda already get).
 * No code change is needed for that upgrade to take effect; it is the module
 * this file plugs into by registering a parser at all.
 *
 * ─── Price / size ────────────────────────────────────────────────────────
 * `[:features]` is grounded as a route SEGMENT but its internal grammar (does
 * it carry a price range? a feature-code list? something else entirely?) is
 * completely unconfirmed. This builder never encodes price/size into it —
 * doing so would be a second, compounding guess. A profile price/size bound
 * is always reported as a loosened (dropped) constraint instead, same
 * contract as Aliseda's unconfirmed-superficie handling.
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

// Grounded: the site's sitemap index (D-075/D-111) advertises `_es_sitemap.xml`
// siblings for pt/gr/it — "es" is the Spanish locale code beyond reasonable
// doubt. This project operates in Spain only (issue #1), so the builder never
// varies it.
const LANG = "es";

// Inferred (never observed) — the overwhelming default for a REO servicer
// portal, matching hipoges_mapping.map_operation's own documented assumption.
// Never "rent": the profile scope carries no operation field, same reason
// idealista/aliseda are sale-only.
const OPERATION = "sale";

// Inferred (never observed) — the ONLY segment with zero grounding of any
// kind, not even an i18n-bundle echo. A single guessed constant, flagged on
// every task via GRAMMAR_FLAG below.
const COUNTRY = "espana";

/**
 * Canonical property type -> inferred Hipoges typology token, from the site's
 * own public i18n key names (`flat`/`house`/`garage`/`storage`/`land`/
 * `office`/`building`/`apartment` — see hipoges_mapping.py). A type with no
 * confident 1:1 match folds onto the nearest inferred token; `approxReason`
 * surfaces that fold as a `property_types` loosened flag (same discipline as
 * Aliseda's ático/chalet folding).
 */
interface TypologyMapping {
  token: string;
  approxReason?: string;
}

const TYPOLOGY_MAP: Record<PropertyType, TypologyMapping> = {
  piso: { token: "flat" },
  atico: {
    token: "flat",
    approxReason:
      "Hipoges: no hay un token de tipología «ático» confirmado; se usa «flat» (igual que piso) — búsqueda más amplia.",
  },
  chalet: { token: "house" },
  local: {
    token: "office",
    approxReason:
      "Hipoges: «local» no tiene un token de tipología confirmado; se usa «office» (la categoría inferida más cercana) — aproximado.",
  },
  nave: {
    token: "building",
    approxReason:
      "Hipoges: «nave» no tiene un token de tipología confirmado; se usa «building» (igual que edificio) — aproximado, búsqueda más amplia.",
  },
  garaje: { token: "garage" },
  terreno: { token: "land" },
  edificio: { token: "building" },
};

// Superset of typology tokens the PARSER recognises (never generated by
// build()) — the same "recognise more than we emit" discipline Aliseda's
// parser follows, since a real owner-navigated URL might use a category this
// builder never picks (e.g. "apartment"/"storage", both present in the same
// i18n bundle but not chosen as this builder's default token for any
// canonical type). Never fabricated: each entry traces to the same i18n
// bundle evidence hipoges_mapping.py already documents.
const TYPOLOGY_TO_TYPES: Record<string, readonly PropertyType[]> = {
  flat: ["piso", "atico"],
  apartment: ["piso"],
  house: ["chalet"],
  office: ["local"],
  building: ["nave", "edificio"],
  garage: ["garaje"],
  storage: ["garaje"],
  land: ["terreno"],
};

/**
 * The always-present, unconditional honesty flag (issue #561): the ROUTE is
 * grounded, the VOCABULARY inside it is not. Every task this builder emits
 * carries this — never presented as a confirmed URL.
 */
const GRAMMAR_FLAG: LoosenedConstraint = {
  constraint: "grammar",
  reason:
    "Hipoges: la ruta /:lang/:operation/:typology/:country/:town está confirmada en el bundle público del sitio, " +
    "pero el vocabulario (operación, tipo, país, localidad) es una INFERENCIA — nunca se ha observado en una " +
    "búsqueda real. Puede dar error 404 o mostrar resultados distintos a los esperados. Compruébalo al abrir; si " +
    "no coincide, navega a mano y captura esa búsqueda — tu navegación real corrige la gramática aprendida (D-051).",
};

/** Title-case a slug like `dos-hermanas` -> "Dos Hermanas" (label only). */
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Resolved `:town` token + a human label, purely a starting guess (see module docstring). */
function resolveTown(scope: CanonicalSearchScope): { town: string; label: string } {
  const muni = municipioForPoint(scope.center);
  if (muni) return { town: muni.municipio, label: titleCaseSlug(muni.municipio) };
  const prov = provinceForPoint(scope.center);
  if (prov) return { town: prov.provincia, label: titleCaseSlug(prov.provincia) };
  return { town: COUNTRY, label: "España" };
}

function buildTask(type: PropertyType, scope: CanonicalSearchScope): SearchTask {
  const loosened: LoosenedConstraint[] = [GRAMMAR_FLAG];
  const mapping = TYPOLOGY_MAP[type];
  if (mapping.approxReason) {
    loosened.push({ constraint: "property_types", reason: mapping.approxReason });
  }

  const { town, label: townLabel } = resolveTown(scope);

  // Price/size: [:features]'s internal grammar is entirely unconfirmed (module
  // docstring) — never guessed. A profile bound is reported as dropped, same
  // "genuinely can't express this" contract as Aliseda's superficie handling.
  if (scope.priceMin !== undefined) {
    loosened.push({
      constraint: "price_min",
      reason: "Hipoges: sin gramática confirmada para precio; no se aplica el mínimo (resultados más amplios).",
    });
  }
  if (scope.priceMax !== undefined) {
    loosened.push({
      constraint: "price_max",
      reason: "Hipoges: sin gramática confirmada para precio; no se aplica el máximo (resultados más amplios).",
    });
  }
  if (scope.sizeMin !== undefined) {
    loosened.push({
      constraint: "size_min",
      reason: "Hipoges: sin gramática confirmada para superficie; no se aplica el mínimo (resultados más amplios).",
    });
  }
  if (scope.sizeMax !== undefined) {
    loosened.push({
      constraint: "size_max",
      reason: "Hipoges: sin gramática confirmada para superficie; no se aplica el máximo (resultados más amplios).",
    });
  }

  const url = `${ORIGIN}/${LANG}/${OPERATION}/${mapping.token}/${COUNTRY}/${town}`;

  // Section = operation + typology (categorical identity for D-051 matching;
  // includes operation since — unlike idealista/aliseda — the typology token
  // alone does not encode sale-vs-rent).
  const section = `${OPERATION}/${mapping.token}`;

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
    label: taskLabel(PORTAL, [type], townLabel, scope.priceMin, scope.priceMax),
    url,
    // Hipoges has no map view -> captureUrl == url (identity), same as Aliseda.
    captureUrl: url,
    loosened,
  };
}

function buildHipoges(scope: CanonicalSearchScope): SearchTask[] {
  const seen = new Set<string>();
  const tasks: SearchTask[] = [];
  const wanted = new Set(scope.propertyTypes);
  // Canonical PROPERTY_TYPES order decides which type "wins" when two fold
  // onto the same URL (same rule Aliseda's builder uses) — piso precedes
  // atico, so the exact piso/flat task wins that fold. nave precedes edificio,
  // so nave's approximate "building" fold wins THAT one, not edificio's exact
  // match — the winner is whichever type is EARLIEST in PROPERTY_TYPES, exact
  // or not, never "prefer the exact one" specifically.
  for (const type of PROPERTY_TYPES) {
    if (!wanted.has(type)) continue;
    const task = buildTask(type, scope);
    if (seen.has(task.url)) continue;
    seen.add(task.url);
    tasks.push(task);
  }
  return tasks;
}

/**
 * The Hipoges CODE mapping (issue #371, D-090) — the inferred typology tokens
 * this builder emits, for drift detection against any future captured filter
 * catalog. Unlike idealista/aliseda this connector never discovers a live
 * catalog (capture-only, D-075/D-111), so there is nothing to drift against
 * yet; exposed anyway for API-shape consistency with the other builders.
 */
function hipogesCodeMapping(): CodeMappingAxes {
  const bySlug = new Map<string, CodeMappingOption>();
  for (const [type, mapping] of Object.entries(TYPOLOGY_MAP) as [PropertyType, TypologyMapping][]) {
    if (bySlug.has(mapping.token)) continue; // first canonical type owns the token
    bySlug.set(mapping.token, {
      slug: mapping.token,
      label: type,
      canonicalType: type,
    });
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
// Recognises `/<lang>/(sale|rent)/<typology>/<country>/<town>[/<features>]` —
// the grounded route shape — across the FULL recognised typology vocabulary
// (every TYPOLOGY_TO_TYPES key, a strict superset of the tokens TYPOLOGY_MAP
// emits), not only the tokens build() emits, since this also has to decode
// REAL owner-navigated URLs
// (same "recognise more than we emit" discipline as Aliseda's parser).
// Nothing about [:features] or a query string is parsed for numeric values —
// there is no confirmed grammar for either — so both stay 100% literal in the
// template; substitute() below never rewrites them.

// origin | lang | operation | typology | country | town | optional features | optional query
const PATH_RE =
  /^(https?:\/\/(?:www\.)?realestate\.hipoges\.com)\/([a-z]{2})\/(sale|rent)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:\?([^#]*))?$/i;

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
  if (!(typology.toLowerCase() in TYPOLOGY_TO_TYPES)) {
    return null; // an unrecognised typology token — not confidently this grammar
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
 * Hipoges' own town slug spelling is unconfirmed, so this only resolves when
 * the token happens to match a KNOWN_MUNICIPIOS entry (e.g. because a learned
 * example came from this builder's own guessed town). Never fabricated. */
function centerForTown(town: string): [number, number] | undefined {
  const m = KNOWN_MUNICIPIOS.find((km) => km.municipio === town.toLowerCase());
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
 * No numeric placeholder exists in a Hipoges template (no confirmed price/size
 * grammar — module docstring) — substitute() therefore never rewrites the
 * template itself; it only reports the profile's price/size bounds as
 * "unfilled" so the resolver flags them exactly like build() does, keeping a
 * tier-1/tier-2 upgraded task just as honest about what it can't express.
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
