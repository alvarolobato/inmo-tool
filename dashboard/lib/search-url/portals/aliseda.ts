/**
 * Aliseda pre-filtered search-URL builder (issue #267).
 *
 * Aliseda (Cajamar's REO portal) exposes a filtered search page whose filters
 * ride in the query string:
 *
 *   https://www.alisedainmobiliaria.com/venta?tipo=<t>&precioMin=<n>&precioMax=<n>…
 *
 * Best-effort by design (issue #267):
 *   - Geography: aliseda has NO radius / coordinate search — it filters by
 *     province/municipality text, which the profile scope (a lat/lng radius)
 *     does not carry. So geography is ALWAYS loosened here: the URL returns
 *     the full-catalogue results for the price/type band and the flag tells
 *     the UI the geographic narrowing must happen by hand. Broader, never
 *     narrower — no on-target property is hidden.
 *   - Property types spanning multiple aliseda categories broaden to "all
 *     categories" (tipo dropped) and flag property_types.
 *
 * The param spellings are the volatile part and live only in this file.
 */

import { PROPERTY_TYPES } from "@/lib/profiles-schema";
import type {
  CanonicalSearchScope,
  LoosenedConstraint,
  PortalSearchUrl,
  PortalSearchUrlBuilder,
  PropertyType,
} from "../types";

const ORIGIN = "https://www.alisedainmobiliaria.com";

/** Aliseda catalogue category (the `tipo` query value) per property type. */
const CATEGORY_BY_TYPE: Record<PropertyType, string> = {
  piso: "vivienda",
  chalet: "vivienda",
  atico: "vivienda",
  local: "local",
  nave: "nave",
  garaje: "garaje",
  terreno: "suelo",
  edificio: "edificio",
};

function inCanonicalOrder(types: readonly PropertyType[]): PropertyType[] {
  const wanted = new Set(types);
  return PROPERTY_TYPES.filter((t) => wanted.has(t));
}

function buildAliseda(scope: CanonicalSearchScope): PortalSearchUrl {
  const loosened: LoosenedConstraint[] = [];
  const params = new URLSearchParams();

  // Geography can never be expressed — aliseda searches by admin area, not a
  // radius around a point. Always broaden + flag.
  loosened.push({
    constraint: "geography",
    reason:
      "Aliseda no busca por radio/coordenadas; se muestra el catálogo completo " +
      "para el rango de precio/tipo y hay que acotar la zona a mano.",
  });

  // One `tipo` per search. If the profile's types span several aliseda
  // categories, broaden to all categories (no tipo) and flag.
  const types = inCanonicalOrder(scope.propertyTypes);
  const categories = [...new Set(types.map((t) => CATEGORY_BY_TYPE[t]))];
  if (categories.length === 1) {
    params.set("tipo", categories[0]);
  } else {
    loosened.push({
      constraint: "property_types",
      reason:
        `Aliseda busca una categoría a la vez; los tipos abarcan varias ` +
        `(${categories.join(", ")}), así que se buscan todas.`,
    });
  }

  if (scope.priceMin !== undefined) params.set("precioMin", String(Math.round(scope.priceMin)));
  if (scope.priceMax !== undefined) params.set("precioMax", String(Math.round(scope.priceMax)));
  if (scope.sizeMin !== undefined) params.set("superficieMin", String(Math.round(scope.sizeMin)));
  if (scope.sizeMax !== undefined) params.set("superficieMax", String(Math.round(scope.sizeMax)));

  const query = params.toString();
  const url = query ? `${ORIGIN}/venta?${query}` : `${ORIGIN}/venta`;

  return { portal: "aliseda", url, loosened };
}

export const alisedaBuilder: PortalSearchUrlBuilder = {
  portal: "aliseda",
  build: buildAliseda,
};
