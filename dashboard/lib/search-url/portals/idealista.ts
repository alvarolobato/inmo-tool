/**
 * Idealista pre-filtered search-URL builder (issue #277; owner-reported grammar
 * fix 2026-08-05; task-list restructure).
 *
 * The original #277 builder emitted a map-draw grammar (`/areas/…?shape=<enc>`)
 * that was reverse-engineered and WRONG. The owner tested "Abrir búsqueda" and
 * supplied the real path grammar:
 *
 *   /<operation>/<municipio>-<provincia>/con-<f1>[,<f2>,…]/
 *
 * Confirmed real examples (Estepona piso, ≤ 200 000 €):
 *
 *   https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_200000/
 *   …with 4+ rooms:
 *   https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_200000,de-cuatro-cinco-habitaciones-o-mas/
 *
 * Idealista searches ONE operation section at a time (venta-viviendas /
 * venta-locales / venta-garajes / …), so a multi-section profile fans out into
 * ONE TASK PER SECTION — not one merged URL with a "types widened" note.
 * Property types within a section (piso/chalet/atico all → venta-viviendas) are
 * NOT further narrowed: the owner's confirmed URL carries no home-subtype token,
 * so the section IS the granularity.
 *
 * CONFIRMED vs. GUESSED (guessed items are flagged as loosened):
 *   - path `/<operation>/<municipio>-<provincia>/con-…/` ...... confirmed
 *   - `<municipio>-<provincia>` (e.g. `estepona-malaga`) resolved from the
 *     profile lat/lng via ../municipios.ts (nearest-town). A town match is the
 *     accepted representation (owner-confirmed) → NOT flagged. No town within
 *     range → province fallback (`<provincia>-provincia`, slug inferred) + flag,
 *     or a national search + flag when no province matches either.
 *   - price `con-precio-hasta_<max>` / `con-precio-desde_<min>` ... confirmed
 *   - rooms `de-cuatro-cinco-habitaciones-o-mas` (min ≥ 4) ... owner-confirmed;
 *     a lower minimum has no confirmed token → omit + flag.
 *   - size `metros-cuadrados-mas-de_ / menos-de_` ............ standard idealista
 *     tokens (kept; not owner-re-confirmed but long-established).
 *
 * These path/token spellings are the volatile part; they live in this one file.
 * The profile scope has NO rooms field today (CanonicalSearchScope.roomsMin is
 * reserved), so the rooms token only fires when a caller supplies roomsMin.
 */

import { PROPERTY_TYPES } from "@/lib/profiles-schema";
import { municipioForPoint } from "../municipios";
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

/** Geography resolved once per profile (same location for every section task). */
interface GeoResolution {
  /** The `<municipio>-<provincia>` / `<provincia>-provincia` slug, or "" (national). */
  locationSegment: string;
  /** Location key for the deterministic task id. */
  idLocation: string;
  /** Slug used for the human label. */
  labelSlug: string;
  /** A geography loosened flag when the location was broadened, else null. */
  flag: LoosenedConstraint | null;
}

function resolveGeo(scope: CanonicalSearchScope): GeoResolution {
  const muni = municipioForPoint(scope.center);
  if (muni) {
    const seg = `${muni.municipio}-${muni.provincia}`;
    // A town match is the owner-accepted representation → not a loosening.
    return { locationSegment: seg, idLocation: seg, labelSlug: muni.municipio, flag: null };
  }
  const province = provinceForPoint(scope.center);
  if (province) {
    const seg = `${province.provincia}-provincia`;
    return {
      locationSegment: seg,
      idLocation: seg,
      labelSlug: province.provincia,
      flag: {
        constraint: "geography",
        reason:
          `Idealista: sin municipio cercano conocido; se aproxima a la provincia entera ` +
          `("${seg}", slug inferido), más amplia que el radio de ${scope.radiusKm} km. ` +
          `Verifica el slug y acota la zona a mano.`,
      },
    };
  }
  return {
    locationSegment: "",
    idLocation: "",
    labelSlug: "",
    flag: {
      constraint: "geography",
      reason:
        `Idealista: zona no determinada a partir de las coordenadas ` +
        `(${scope.center[0]}, ${scope.center[1]}); búsqueda nacional aproximada — acota la zona a mano.`,
    },
  };
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

function buildTask(
  operation: string,
  types: PropertyType[],
  geo: GeoResolution,
  scope: CanonicalSearchScope,
): SearchTask {
  const loosened: LoosenedConstraint[] = [];
  if (geo.flag) loosened.push(geo.flag);

  // Comma-joined `con-` filter tokens, in the owner-confirmed order
  // (price, then rooms), followed by the standard size tokens.
  const tokens: string[] = [];
  if (scope.priceMin !== undefined) tokens.push(`precio-desde_${Math.round(scope.priceMin)}`);
  if (scope.priceMax !== undefined) tokens.push(`precio-hasta_${Math.round(scope.priceMax)}`);
  const rooms = roomsToken(scope.roomsMin, loosened);
  if (rooms) tokens.push(rooms);
  if (scope.sizeMin !== undefined) tokens.push(`metros-cuadrados-mas-de_${Math.round(scope.sizeMin)}`);
  if (scope.sizeMax !== undefined) tokens.push(`metros-cuadrados-menos-de_${Math.round(scope.sizeMax)}`);

  const locationPart = geo.locationSegment ? `/${geo.locationSegment}` : "";
  const conPart = tokens.length > 0 ? `/con-${tokens.join(",")}` : "";
  const url = `${ORIGIN}/${operation}${locationPart}${conPart}/`;

  const id = stableTaskId({
    portal: PORTAL,
    section: operation,
    location: geo.idLocation,
    priceMin: scope.priceMin,
    priceMax: scope.priceMax,
    sizeMin: scope.sizeMin,
    sizeMax: scope.sizeMax,
    roomsMin: scope.roomsMin,
  });

  return {
    id,
    portal: PORTAL,
    label: taskLabel(PORTAL, types, geo.labelSlug, scope.priceMin, scope.priceMax),
    url,
    loosened,
  };
}

function buildIdealista(scope: CanonicalSearchScope): SearchTask[] {
  const geo = resolveGeo(scope);
  return sectionsInOrder(scope.propertyTypes).map(({ operation, types }) =>
    buildTask(operation, types, geo, scope),
  );
}

export const idealistaBuilder: PortalSearchUrlBuilder = {
  portal: PORTAL,
  build: buildIdealista,
};
