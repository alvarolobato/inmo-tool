/**
 * "Validar filtros" — pure decode + scope-mismatch helper (issue #478 P2).
 *
 * Decodes a connector search URL with the portal's parser (the same client-safe
 * PARSERS the resolver uses) into human chips, and compares the decoded filters
 * against the profile's own scope to surface where the URL is BROADER (or
 * simply different) than the profile asks for. A URL the parser can't decode
 * (e.g. an Idealista `shape=` drawn zone — #471) is reported as `unparseable`;
 * the page then notes "se usará tal cual" (tier 0 is verbatim and needs no
 * parse — see resolve.ts).
 *
 * Pure: no `pg`, no React. Shared by the server page and its unit tests.
 */

import { PARSERS } from "@/lib/search-url/parsers";
import { canonicalScopeFromProfile } from "@/lib/search-url";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES, type Scope } from "@/lib/profiles-schema";

/** Decoded view of one connector search URL for the Validar filtros page. */
export interface DecodedFilters {
  /** The parser could not decode the URL (no parser, or not this grammar). */
  unparseable: boolean;
  /** Human, Spanish-facing chips of the recognised filters. */
  chips: string[];
  /** Warnings where the URL is broader than / differs from the profile scope. */
  warnings: string[];
  /**
   * The parser's `categoryKey` (section + sorted types), '' when unparseable —
   * the `section_key` a PUT should store so tier 0 matches this task.
   */
  sectionKey: string;
}

function eur(n: number): string {
  return `${new Intl.NumberFormat("es-ES").format(Math.round(n))} €`;
}

function m2(n: number): string {
  return `${new Intl.NumberFormat("es-ES").format(Math.round(n))} m²`;
}

/** "desde X · hasta Y" style range for a chip, given optional bounds. */
function range(min: number | undefined, max: number | undefined, fmt: (n: number) => string): string {
  if (min !== undefined && max !== undefined) return `${fmt(min)}–${fmt(max)}`;
  if (min !== undefined) return `desde ${fmt(min)}`;
  return `hasta ${fmt(max as number)}`;
}

/**
 * Decode `url` for `portal` and compare it to `scope`. An empty URL (the manual
 * altamira row before anything is pinned) decodes to nothing — no chips, no
 * warnings, not flagged unparseable (there is simply no URL yet).
 */
export function decodeFilterUrl(portal: string, url: string, scope: Scope): DecodedFilters {
  if (!url) return { unparseable: false, chips: [], warnings: [], sectionKey: "" };

  const parser = PARSERS[portal];
  const parsed = parser ? parser.parse(url) : null;
  if (!parsed) return { unparseable: true, chips: [], warnings: [], sectionKey: "" };

  const f = parsed.filters;
  const chips: string[] = [];
  if (f.section) chips.push(`Sección: ${f.section}`);
  if (f.propertyTypes.length > 0) {
    const labels = f.propertyTypes.map(
      (t) => PROPERTY_TYPE_LABELS[t as (typeof PROPERTY_TYPES)[number]] ?? t,
    );
    chips.push(`Tipos: ${labels.join(", ")}`);
  }
  if (f.locationSlug) chips.push(`Zona: ${f.locationSlug}`);
  if (f.priceMin !== undefined || f.priceMax !== undefined) {
    chips.push(`Precio: ${range(f.priceMin, f.priceMax, eur)}`);
  }
  if (f.sizeMin !== undefined || f.sizeMax !== undefined) {
    chips.push(`Superficie: ${range(f.sizeMin, f.sizeMax, m2)}`);
  }

  const c = canonicalScopeFromProfile(scope);
  const warnings: string[] = [];
  const compareBound = (
    scopeVal: number | undefined,
    urlVal: number | undefined,
    unfilteredMsg: string,
    differsMsg: (u: number) => string,
  ) => {
    if (scopeVal === undefined) return;
    if (urlVal === undefined) warnings.push(unfilteredMsg);
    else if (urlVal !== scopeVal) warnings.push(differsMsg(urlVal));
  };

  compareBound(
    c.priceMax,
    f.priceMax,
    `El perfil pide ≤${eur(c.priceMax as number)} pero la URL no filtra por precio máximo; los resultados serán más amplios.`,
    (u) => `El perfil pide ≤${eur(c.priceMax as number)} pero la URL filtra ≤${eur(u)}.`,
  );
  compareBound(
    c.priceMin,
    f.priceMin,
    `El perfil pide ≥${eur(c.priceMin as number)} pero la URL no filtra por precio mínimo.`,
    (u) => `El perfil pide ≥${eur(c.priceMin as number)} pero la URL filtra ≥${eur(u)}.`,
  );
  compareBound(
    c.sizeMax,
    f.sizeMax,
    `El perfil pide ≤${m2(c.sizeMax as number)} pero la URL no filtra por superficie máxima.`,
    (u) => `El perfil pide ≤${m2(c.sizeMax as number)} pero la URL filtra ≤${m2(u)}.`,
  );
  compareBound(
    c.sizeMin,
    f.sizeMin,
    `El perfil pide ≥${m2(c.sizeMin as number)} pero la URL no filtra por superficie mínima.`,
    (u) => `El perfil pide ≥${m2(c.sizeMin as number)} pero la URL filtra ≥${m2(u)}.`,
  );

  return { unparseable: false, chips, warnings, sectionKey: parsed.categoryKey };
}
