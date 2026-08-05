/**
 * Aliseda pre-filtered search-URL builder (issue #277; owner-reported grammar
 * fix 2026-08-05; task-list restructure).
 *
 * The original #277 builder emitted a query-string grammar
 * (`/venta?tipo=…&precioMax=…`) that was reverse-engineered and WRONG. The
 * owner tested "Abrir búsqueda" and supplied the real grammar:
 *
 *   /comprar-viviendas/<tipo-plural>/<comunidad>/<provincia>?subtipo=<code>&precio=<min>-<max>
 *
 * Confirmed real example (Estepona-area piso, ≤ 200 000 €):
 *
 *   https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000
 *
 * Aliseda encodes the property type as a single PATH segment (one type per
 * search), so a multi-type profile fans out into ONE TASK PER TYPE — not one
 * merged URL. Each task is an independently openable pre-filtered search.
 *
 * What is CONFIRMED vs. GUESSED (everything guessed is flagged as loosened):
 *   - base path `/comprar-viviendas` .......................... confirmed
 *   - `<tipo-plural>`: `pisos` for piso ...................... confirmed
 *     other types' plural segments (aticos/chalets/…) ........ GUESSED → flag
 *   - `<comunidad>/<provincia>` slugs (e.g. andalucia/malaga)  confirmed shape;
 *     resolved from the profile's lat/lng via ../provinces.ts (bounding boxes).
 *     Aliseda has NO radius search, so a point+radius always broadens to the
 *     whole province → geography is ALWAYS loosened. If the point matches no
 *     known province we drop the geo segments (province-less search) and flag.
 *   - `subtipo=36` = piso ................................... confirmed
 *     other subtipo codes are unknown → omit subtipo + flag
 *   - `precio=<min>-<max>`: hyphen range, no separators; min defaults to 0 when
 *     the profile has no lower bound (matches the confirmed example) ... confirmed
 *   - superficie (size): NO confirmed grammar → size is dropped, and flagged
 *     when the profile sets one (broader, never narrower).
 *
 * The path/query spellings are the volatile part; they live in this one file so
 * refreshing them is a local edit. NB idealista.ts is a SEPARATE grammar (also
 * owner-confirmed for its own example) — do not cross-reference the two.
 */

import { PROPERTY_TYPES } from "@/lib/profiles-schema";
import { provinceForPoint } from "../provinces";
import { stableTaskId } from "../task-id";
import { taskLabel } from "../labels";
import type {
  CanonicalSearchScope,
  LoosenedConstraint,
  PortalSearchUrlBuilder,
  PropertyType,
  SearchTask,
} from "../types";

const ORIGIN = "https://www.alisedainmobiliaria.com";
const PORTAL = "aliseda";
const BASE_SEGMENT = "comprar-viviendas";

/**
 * The plural path segment Aliseda uses per property type. Only `piso → pisos`
 * is owner-confirmed; the rest are plausible-but-GUESSED plurals (see
 * {@link CONFIRMED_PLURALS}) and are flagged when used.
 */
const PLURAL_BY_TYPE: Record<PropertyType, string> = {
  piso: "pisos", // owner-confirmed 2026-08-05
  chalet: "chalets",
  atico: "aticos",
  local: "locales",
  nave: "naves",
  garaje: "garajes",
  terreno: "terrenos",
  edificio: "edificios",
};

/** Property types whose plural segment the owner confirmed. */
const CONFIRMED_PLURALS: ReadonlySet<PropertyType> = new Set<PropertyType>(["piso"]);

/**
 * Aliseda's numeric `subtipo` code per property type. Only `piso = 36` is
 * owner-confirmed; unknown codes are omitted (never guessed) and flagged.
 */
const SUBTIPO_BY_TYPE: Partial<Record<PropertyType, number>> = {
  piso: 36, // owner-confirmed 2026-08-05
};

/** Property types in the canonical PROPERTY_TYPES order (deterministic). */
function inCanonicalOrder(types: readonly PropertyType[]): PropertyType[] {
  const wanted = new Set(types);
  return PROPERTY_TYPES.filter((t) => wanted.has(t));
}

/** Geography resolved once per profile (same province for every task). */
interface GeoResolution {
  /** Path segments to append after the tipo (`[comunidad, provincia]` or `[]`). */
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
function buildTask(type: PropertyType, geo: GeoResolution, scope: CanonicalSearchScope): SearchTask {
  const loosened: LoosenedConstraint[] = [];
  const plural = PLURAL_BY_TYPE[type];
  const segments = [BASE_SEGMENT, plural, ...geo.segments];

  loosened.push(geo.flag);

  if (!CONFIRMED_PLURALS.has(type)) {
    loosened.push({
      constraint: "property_types",
      reason:
        `El segmento de ruta para «${type}» ("${plural}") es una conjetura; ` +
        `sólo "pisos" está confirmado. Verifica que la URL abra el tipo correcto.`,
    });
  }

  const params = new URLSearchParams();

  const subtipo = SUBTIPO_BY_TYPE[type];
  if (subtipo !== undefined) {
    params.set("subtipo", String(subtipo));
  } else {
    loosened.push({
      constraint: "property_types",
      reason:
        `Código «subtipo» desconocido para «${type}» (sólo piso=36 confirmado); ` +
        `se omite subtipo y la búsqueda no filtra el subtipo exacto.`,
    });
  }

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

  const id = stableTaskId({
    portal: PORTAL,
    section: plural,
    location: geo.idLocation,
    priceMin: scope.priceMin,
    priceMax: scope.priceMax,
    sizeMin: scope.sizeMin,
    sizeMax: scope.sizeMax,
  });

  return {
    id,
    portal: PORTAL,
    label: taskLabel(PORTAL, [type], geo.labelSlug, scope.priceMin, scope.priceMax),
    url,
    loosened,
  };
}

function buildAliseda(scope: CanonicalSearchScope): SearchTask[] {
  const geo = resolveGeo(scope);
  return inCanonicalOrder(scope.propertyTypes).map((type) => buildTask(type, geo, scope));
}

export const alisedaBuilder: PortalSearchUrlBuilder = {
  portal: PORTAL,
  build: buildAliseda,
};
