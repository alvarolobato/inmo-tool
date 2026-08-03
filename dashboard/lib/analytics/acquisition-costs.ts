/**
 * Acquisition (transaction) cost model — issue #151.
 *
 * Owner's own framing: "a wrong ITP rate silently skews every yield in a
 * region." This module is the reviewable, cited table that decision rests
 * on — never inline literals scattered across yield.ts.
 *
 * ## Scope, stated explicitly (per #151's "get the model right or scope it
 * explicitly")
 *
 * - **Resale (segunda mano) only.** New-build (obra nueva) purchases pay
 *   IVA (10%) + AJD (stamp duty, region-specific, roughly 0.5-1.5%) instead
 *   of ITP — a genuinely different calculation, not a rate substitution.
 *   `property` has no reliable "is this a new build" signal today (no
 *   connector populates one — `features` is a free-text array, not a closed
 *   enum with a new-build flag), so this module always applies the ITP
 *   (resale) path. A future connector/field that identifies new-build
 *   listings should route them through a separate IVA+AJD calculation
 *   instead of extending this table with a wrong-shaped column.
 * - **General/base rate only**, not the full progressive-bracket or
 *   buyer-profile-reduced schedule. Several regions (Cataluña, Baleares,
 *   Asturias, Castilla y León, C. Valenciana, Extremadura, Aragón) apply a
 *   HIGHER marginal rate above a price threshold (often ~€600k-1M), and
 *   most regions offer REDUCED rates for specific buyer circumstances
 *   (age <35, large family, disability, VPO, primary residence under a
 *   value cap). Modeling every bracket/reduction is real tax-software
 *   scope, not a decision-support estimate (#1 §11/§16) — this table uses
 *   each region's lowest/general band, which is the right default for an
 *   investor buying a normal-priced rental property under standard terms,
 *   and is documented as an approximation, not a personalized quote.
 * - **Source**: rates cross-checked against two independent sources on
 *   2026-08-03 (this module's last-verified date, bump it when re-checked):
 *     - https://www.rankia.com/blog/mejores-hipotecas/3233016-impuesto-transmisiones-patrimoniales-itp-cada-comunidad-autonoma
 *     - https://fincasgirbes.es/itp-baja-comunidad-valenciana-2026-cuanto-pagaras-realmente-al-comprar-la-vivenda/
 *       (Comunidad Valenciana's general rate dropped 10% -> 9% in June 2026 —
 *       an example of exactly why this table needs a verification date and
 *       a citation, not silent literals: a rate this module got right in
 *       January could be wrong in July.)
 *   These are commercial/notarial guidance pages, not the primary legal
 *   text (each region's own Ley de Tributos Cedidos) — good enough for a
 *   decision-support estimate, NOT a substitute for professional advice
 *   before an actual purchase. Re-verify before trusting this table for a
 *   real transaction.
 *
 * Notary/registry/gestoría defaults are a documented rule-of-thumb, not a
 * region-specific schedule (Spanish notary/registry fees are nominally a
 * regulated fixed scale keyed to the deed value, but approximate to a
 * roughly flat percentage in the price ranges this tool targets):
 *   - Notary ≈ 0.3% of price (typically €600-1.000 on a normal resale flat)
 *   - Registry ≈ 0.2% of price (typically €400-650)
 *   - Gestoría ≈ a flat €300 (optional service, commonly used when there's
 *     a mortgage to help process the tax filing/registration)
 * Source (same verification date, general consumer-finance guidance, not
 * the regulated arancel schedule itself):
 *   - https://www.idealista.com/news/finanzas/hipotecas/2017/09/20/748073-los-gastos-e-impuestos-que-debes-afrontar-al-comprar-una-vivienda-tras-los-cambios-mas
 *   - https://blog.melendos.es/gastos-de-notaria-escritura-y-registro/
 */

export const RATES_LAST_VERIFIED = "2026-08-03";

/**
 * General/base ITP rate (%) for resale housing by comunidad autónoma —
 * see this module's docstring for scope, sourcing, and the progressive-
 * bracket/reduced-rate simplification. Keys are canonical CCAA names;
 * resolve a `property.province` value to one of these via
 * `resolveComunidadAutonoma` below, never by matching province strings
 * directly against this table.
 */
export const ITP_RATE_BY_CCAA: Record<string, number> = {
  "Andalucía": 7,
  "Aragón": 8,
  "Asturias": 8,
  "Baleares": 8,
  "Canarias": 6.5,
  "Cantabria": 9,
  "Castilla y León": 8,
  "Castilla-La Mancha": 9,
  "Cataluña": 10,
  "Extremadura": 8,
  "Galicia": 8,
  "Madrid": 6,
  "Murcia": 8,
  "Navarra": 6,
  "País Vasco": 4,
  "La Rioja": 7,
  "Comunidad Valenciana": 9,
  "Ceuta": 6,
  "Melilla": 6,
};

/**
 * National fallback when `property.province` is missing or doesn't match
 * any known province (e.g. a connector that never populated it — see
 * idealista.py's `province=None` and vivantial's slug-derived value, which
 * can be malformed). Chosen as a round number sitting in the middle of the
 * 6%-10% general-rate range above — an honest "we don't know this
 * property's region" default, not a claim about any specific region.
 * Callers MUST surface `comunidad_autonoma: null` /
 * `province_recognized: false` whenever this fallback is used (see
 * `AcquisitionCostBreakdown`) so the UI can visibly flag it rather than
 * silently presenting a made-up region's rate as this property's own.
 */
export const NATIONAL_FALLBACK_ITP_PCT = 8;

export const DEFAULT_NOTARY_PCT = 0.3;
export const DEFAULT_REGISTRY_PCT = 0.2;
export const DEFAULT_GESTORIA_EUR = 300;

/**
 * `province` string (as free-text-published by connectors, e.g.
 * "Málaga"/"MALAGA"/"malaga") -> canonical CCAA name -> `ITP_RATE_BY_CCAA`
 * lookup key. Diacritic/case-insensitive: connectors don't agree on
 * capitalization (see fotocasa.py vs. servihabitat_mapping.py) and none
 * guarantee accents survive scraping intact.
 */
const PROVINCE_TO_CCAA: Record<string, string> = {
  // Andalucía
  "almeria": "Andalucía",
  "cadiz": "Andalucía",
  "cordoba": "Andalucía",
  "granada": "Andalucía",
  "huelva": "Andalucía",
  "jaen": "Andalucía",
  "malaga": "Andalucía",
  "sevilla": "Andalucía",
  // Aragón
  "huesca": "Aragón",
  "teruel": "Aragón",
  "zaragoza": "Aragón",
  // Asturias (single-province CCAA; both the province and region name used)
  "asturias": "Asturias",
  "principado de asturias": "Asturias",
  // Baleares
  "baleares": "Baleares",
  "illes balears": "Baleares",
  "islas baleares": "Baleares",
  // Canarias
  "las palmas": "Canarias",
  "santa cruz de tenerife": "Canarias",
  // Cantabria
  "cantabria": "Cantabria",
  // Castilla y León
  "avila": "Castilla y León",
  "burgos": "Castilla y León",
  "leon": "Castilla y León",
  "palencia": "Castilla y León",
  "salamanca": "Castilla y León",
  "segovia": "Castilla y León",
  "soria": "Castilla y León",
  "valladolid": "Castilla y León",
  "zamora": "Castilla y León",
  // Castilla-La Mancha
  "albacete": "Castilla-La Mancha",
  "ciudad real": "Castilla-La Mancha",
  "cuenca": "Castilla-La Mancha",
  "guadalajara": "Castilla-La Mancha",
  "toledo": "Castilla-La Mancha",
  // Cataluña
  "barcelona": "Cataluña",
  "girona": "Cataluña",
  "gerona": "Cataluña",
  "lleida": "Cataluña",
  "lerida": "Cataluña",
  "tarragona": "Cataluña",
  // Extremadura
  "badajoz": "Extremadura",
  "caceres": "Extremadura",
  // Galicia
  "a coruna": "Galicia",
  "coruna": "Galicia",
  "la coruna": "Galicia",
  "lugo": "Galicia",
  "ourense": "Galicia",
  "orense": "Galicia",
  "pontevedra": "Galicia",
  // Madrid
  "madrid": "Madrid",
  // Murcia
  "murcia": "Murcia",
  // Navarra
  "navarra": "Navarra",
  // País Vasco
  "alava": "País Vasco",
  "araba": "País Vasco",
  "gipuzkoa": "País Vasco",
  "guipuzcoa": "País Vasco",
  "bizkaia": "País Vasco",
  "vizcaya": "País Vasco",
  // La Rioja
  "la rioja": "La Rioja",
  "rioja": "La Rioja",
  // Comunidad Valenciana
  "alicante": "Comunidad Valenciana",
  "castellon": "Comunidad Valenciana",
  "valencia": "Comunidad Valenciana",
  // Autonomous cities
  "ceuta": "Ceuta",
  "melilla": "Melilla",
};

/** Lowercase + strip diacritics + trim, so "Málaga"/"MALAGA "/"málaga" all match one key. */
function normalizeProvince(raw: string): string {
  // NFD splits "á" into "a" + a combining acute accent (U+0300-U+036F block);
  // stripping that Unicode block by explicit code point range (not a
  // hand-typed accented character class, which is easy to get subtly wrong)
  // leaves the plain ASCII base letters.
  const COMBINING_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");
  return raw.normalize("NFD").replace(COMBINING_DIACRITICS, "").toLowerCase().trim();
}

/** Resolves a free-text `property.province` value to a canonical CCAA name, or null if unrecognized/absent. */
export function resolveComunidadAutonoma(province: string | null): string | null {
  if (province === null || province.trim() === "") return null;
  return PROVINCE_TO_CCAA[normalizeProvince(province)] ?? null;
}

export interface AcquisitionCostOverrides {
  /** Overrides the region's ITP_RATE_BY_CCAA lookup (or the national fallback) entirely. */
  itp_pct_override?: number;
  notary_pct?: number;
  registry_pct?: number;
  gestoria_eur?: number;
}

export interface AcquisitionCostBreakdown {
  purchase_price: number;
  /** Canonical CCAA name used for the ITP rate, or null when unresolved (national fallback applied). */
  comunidad_autonoma: string | null;
  /** False when `comunidad_autonoma` is null — the UI must flag this case, not silently show a regional-looking number. */
  province_recognized: boolean;
  /** True when `overrides.itp_pct_override` was used instead of the table/fallback. */
  itp_is_override: boolean;
  itp_pct: number;
  itp_eur: number;
  notary_pct: number;
  notary_eur: number;
  registry_pct: number;
  registry_eur: number;
  gestoria_eur: number;
  total_eur: number;
  /** total_eur / purchase_price, as a fraction (e.g. 0.083 = 8.3%) — mirrors explain.ts's fraction convention, not a pre-multiplied percentage. */
  total_pct_of_price: number;
  rates_last_verified: string;
}

/**
 * Computes the acquisition-cost breakdown for a purchase. Pure function —
 * no DB access, no defaults silently invented beyond what's documented
 * above; every rate used is echoed back in the result (issue #151's "show
 * the inputs, not just the output").
 */
export function computeAcquisitionCosts(
  purchasePrice: number,
  province: string | null,
  overrides: AcquisitionCostOverrides = {},
): AcquisitionCostBreakdown {
  if (!(purchasePrice > 0)) {
    throw new Error("computeAcquisitionCosts: purchasePrice must be a positive number");
  }

  const comunidadAutonoma = resolveComunidadAutonoma(province);
  const itpIsOverride = overrides.itp_pct_override !== undefined;
  const itpPct = itpIsOverride
    ? overrides.itp_pct_override!
    : (comunidadAutonoma !== null ? ITP_RATE_BY_CCAA[comunidadAutonoma] : NATIONAL_FALLBACK_ITP_PCT);

  const notaryPct = overrides.notary_pct ?? DEFAULT_NOTARY_PCT;
  const registryPct = overrides.registry_pct ?? DEFAULT_REGISTRY_PCT;
  const gestoriaEur = overrides.gestoria_eur ?? DEFAULT_GESTORIA_EUR;

  const itpEur = purchasePrice * (itpPct / 100);
  const notaryEur = purchasePrice * (notaryPct / 100);
  const registryEur = purchasePrice * (registryPct / 100);
  const totalEur = itpEur + notaryEur + registryEur + gestoriaEur;

  return {
    purchase_price: purchasePrice,
    comunidad_autonoma: comunidadAutonoma,
    province_recognized: comunidadAutonoma !== null,
    itp_is_override: itpIsOverride,
    itp_pct: itpPct,
    itp_eur: itpEur,
    notary_pct: notaryPct,
    notary_eur: notaryEur,
    registry_pct: registryPct,
    registry_eur: registryEur,
    gestoria_eur: gestoriaEur,
    total_eur: totalEur,
    total_pct_of_price: totalEur / purchasePrice,
    rates_last_verified: RATES_LAST_VERIFIED,
  };
}
