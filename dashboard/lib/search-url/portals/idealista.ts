/**
 * Idealista pre-filtered search-URL builder (issue #267).
 *
 * Idealista's URL grammar for a MAP-DRAWN area search is:
 *
 *   https://www.idealista.com/areas/<operation>/con-<f1>,<f2>,…/?shape=<enc>
 *
 * where `<operation>` is the section (venta-viviendas / venta-locales / …),
 * the `con-…` path segment carries comma-separated filter tokens, and `shape`
 * is a Google-encoded polygon of the drawn zone (see ../geo.ts). When there
 * are no filter tokens the `con-…` segment is omitted.
 *
 * Grammar is best-effort by design (issue #267): idealista can search only ONE
 * operation section at a time, so property types that span sections force us
 * to pick one and broaden the rest — recorded as a loosened `property_types`.
 * Geography is rendered faithfully by the polygon, so it is never loosened
 * here. These path/token spellings are the volatile part; they live in this
 * one file so refreshing them (or adding a portal) is a local edit.
 */

import { PROPERTY_TYPES } from "@/lib/profiles-schema";
import { idealistaShape } from "../geo";
import type {
  CanonicalSearchScope,
  LoosenedConstraint,
  PortalSearchUrl,
  PortalSearchUrlBuilder,
  PropertyType,
} from "../types";

const ORIGIN = "https://www.idealista.com";

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

/**
 * Within the `venta-viviendas` section, the `con-…` token that narrows to a
 * home subtype. Types not present here (they belong to other sections) have
 * no subtype token.
 */
const HOMES_SUBTYPE_TOKEN: Partial<Record<PropertyType, string>> = {
  piso: "pisos",
  chalet: "chalets",
  atico: "aticos",
};

/** Property types in the canonical PROPERTY_TYPES order (deterministic). */
function inCanonicalOrder(types: readonly PropertyType[]): PropertyType[] {
  const wanted = new Set(types);
  return PROPERTY_TYPES.filter((t) => wanted.has(t));
}

function buildIdealista(scope: CanonicalSearchScope): PortalSearchUrl {
  const loosened: LoosenedConstraint[] = [];
  const types = inCanonicalOrder(scope.propertyTypes);

  // Idealista searches one operation section at a time. Pick the section of
  // the first (canonical-order) type; if other types live in other sections,
  // broaden to just this section and flag it.
  const operation = OPERATION_BY_TYPE[types[0]];
  const otherSections = types.filter((t) => OPERATION_BY_TYPE[t] !== operation);
  if (otherSections.length > 0) {
    loosened.push({
      constraint: "property_types",
      reason:
        `Idealista solo busca en una sección a la vez; se usa "${operation}" y se ` +
        `amplían los tipos de otras secciones (${otherSections.join(", ")}).`,
    });
  }

  const tokens: string[] = [];

  // Home subtype tokens (only meaningful in venta-viviendas). Narrowing to the
  // selected subtypes is faithful, not a loosening.
  if (operation === "venta-viviendas") {
    const subtypeTokens = types
      .map((t) => HOMES_SUBTYPE_TOKEN[t])
      .filter((tok): tok is string => Boolean(tok));
    // Only add subtype tokens when they'd actually narrow — listing all three
    // home subtypes is identical to the unfiltered section.
    const allHomeSubtypes = Object.keys(HOMES_SUBTYPE_TOKEN).length;
    if (subtypeTokens.length > 0 && subtypeTokens.length < allHomeSubtypes) {
      tokens.push(...subtypeTokens);
    }
  }

  if (scope.priceMin !== undefined) tokens.push(`precio-desde_${Math.round(scope.priceMin)}`);
  if (scope.priceMax !== undefined) tokens.push(`precio-hasta_${Math.round(scope.priceMax)}`);
  if (scope.sizeMin !== undefined) tokens.push(`metros-cuadrados-mas-de_${Math.round(scope.sizeMin)}`);
  if (scope.sizeMax !== undefined) {
    tokens.push(`metros-cuadrados-menos-de_${Math.round(scope.sizeMax)}`);
  }

  const conSegment = tokens.length > 0 ? `/con-${tokens.join(",")}` : "";
  const shape = encodeURIComponent(idealistaShape(scope.center, scope.radiusKm));
  const url = `${ORIGIN}/areas/${operation}${conSegment}/?shape=${shape}`;

  return { portal: "idealista", url, loosened };
}

export const idealistaBuilder: PortalSearchUrlBuilder = {
  portal: "idealista",
  build: buildIdealista,
};
