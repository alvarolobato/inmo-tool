/**
 * Composes the three Phase 5 analytics modules (issues #151/#32/#33) into
 * one result for the property detail page's investment-metrics section.
 *
 * Server-only: imports lib/db-write (the `pg` client) — same reasoning as
 * lib/candidates.ts / lib/property-detail.ts, never import from a client
 * component.
 *
 * Placed at `lib/`, not `lib/analytics/`, on purpose: this module is the
 * DB-aggregation layer that feeds the analytics modules real property
 * data, mirroring how `lib/property-detail.ts` composes
 * `lib/candidates.ts`'s query conventions rather than being a pure
 * function itself. (Note: as of issue #31, `lib/analytics/` itself is no
 * longer exclusively pure functions — `rent-estimate.ts` now runs its own
 * DB-backed comparable query, same as `area-price.ts` already did; the
 * distinction that matters is "does the caller need to load property rows
 * first", which is still this module's job.)
 */

import { sql } from "@/lib/db-write";
import type { ThesisParams } from "@/lib/profiles-schema";
import { computeAreaPriceComparison, type AreaPriceComparison } from "@/lib/analytics/area-price";
import { estimateRent, type RentEstimateResult } from "@/lib/analytics/rent-estimate";
import { computeYield, type YieldResult, type CarryingCostsKnown } from "@/lib/analytics/yield";

export interface InvestmentMetrics {
  /** Null when the property itself has no lat/lon/property_type — nothing to compare geographically (see area-price.ts). */
  area_price: AreaPriceComparison | null;
  rent_estimate: RentEstimateResult;
  yield: YieldResult;
}

interface RawInvestmentRow {
  m2_built: string | null;
  province: string | null;
  min_price: string | null;
  /** From `listing.raw_extra->>'ibi_anual_eur'` (Solvia's extract_investment_extras) — text (JSONB ->> operator), or null if no active sale listing publishes it. */
  annual_ibi_eur: string | null;
  /** From `listing.raw_extra->>'gastos_comunidad_eur'`. */
  monthly_community_fee_eur: string | null;
  /** issue #31: needed to run rent-estimate.ts's comparable-rental query, which m2_built/province alone didn't require before. */
  lat: string | null;
  lon: string | null;
  property_type: string | null;
}

/**
 * Parses a raw JSONB `->>'...'` text value into a finite number, or `null`
 * if it isn't one — NEVER the bare `Number()` this module used before an
 * Opus review caught it. `raw_extra` holds whatever text a portal's page
 * sent (solvia_mapping.py's `extract_investment_extras` only rejects
 * `None`/`""`, nothing else): a Spanish-formatted number like "1.234,56"
 * (thousands dot, decimal comma) makes `Number("1.234,56")` return `NaN`,
 * which then poisons every downstream computation (`NaN` gross rent parses
 * through as `hasActualCarrying: true`, and `net_yield_pct` becomes `NaN`
 * → JSON round-trips `NaN` as `null` → the UI's `fmtPct(null / 100)`
 * quietly rendered "0,0 %" with the "estimado" badge still attached and NO
 * error surfaced, since `assumptions_used` was still populated). An empty
 * string parses to `0` under bare `Number()`, which is the same failure
 * mode with the opposite direction (net silently equals gross). A bad
 * value must read as UNKNOWN (falls back to the assumed operating-cost
 * path in yield.ts), never as a fabricated zero or a silent NaN.
 */
export function parseFiniteCarryingCost(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Plausibility bound for a MONTHLY community fee, euros. Guards against a
 * real, easy-to-hit data-quality bug an Opus review flagged: if a source
 * ever publishes an ANNUAL community-fee figure under the
 * `gastos_comunidad_eur` (monthly) key — a portal-side labeling mistake,
 * not a parsing bug this module can detect any other way — treating it as
 * monthly and multiplying by 12 in yield.ts produces carrying costs ~12x
 * too high with no error surfaced (a plausible annual community fee like
 * 900 EUR is itself a plausible-looking MONTHLY figure, so nothing about
 * the number alone looks wrong). €2,000/month is far above even luxury
 * Spanish community fees (typically well under €500/month) — a documented,
 * generous rule-of-thumb ceiling, not a precise validation; a value above
 * it is treated as unknown/unreliable rather than trusted at face value.
 */
export const MAX_PLAUSIBLE_MONTHLY_COMMUNITY_FEE_EUR = 2000;

/** Extracted as its own testable predicate rather than an inline comparison at the call site — see MAX_PLAUSIBLE_MONTHLY_COMMUNITY_FEE_EUR's docstring for the rationale. */
export function isPlausibleMonthlyCommunityFee(value: number): boolean {
  return value <= MAX_PLAUSIBLE_MONTHLY_COMMUNITY_FEE_EUR;
}

/**
 * One deterministic pick among a property's active sale listings when more
 * than one publishes the same carrying-cost field (arbitrary but stable —
 * `ORDER BY id`, lowest listing id wins — rather than averaging or summing
 * two different sources' own figures for the same real-world cost, which
 * would fabricate a number neither source actually published).
 */
async function fetchInvestmentInputs(propertyId: number): Promise<RawInvestmentRow | null> {
  const rows = await sql<RawInvestmentRow>(
    `SELECT
       property.m2_built::text AS m2_built,
       property.province,
       property.lat::text AS lat,
       property.lon::text AS lon,
       property.property_type,
       (SELECT MIN(l.current_price) FROM listing l
          WHERE l.property_id = property.id AND l.status = 'active' AND l.operation = 'sale')::text AS min_price,
       (SELECT l.raw_extra->>'ibi_anual_eur' FROM listing l
          WHERE l.property_id = property.id AND l.status = 'active' AND l.operation = 'sale'
            AND l.raw_extra->>'ibi_anual_eur' IS NOT NULL
          ORDER BY l.id LIMIT 1) AS annual_ibi_eur,
       (SELECT l.raw_extra->>'gastos_comunidad_eur' FROM listing l
          WHERE l.property_id = property.id AND l.status = 'active' AND l.operation = 'sale'
            AND l.raw_extra->>'gastos_comunidad_eur' IS NOT NULL
          ORDER BY l.id LIMIT 1) AS monthly_community_fee_eur
     FROM property
     WHERE id = $1`,
    [propertyId],
  );
  return rows[0] ?? null;
}

/**
 * Returns null only when the property doesn't exist — callers (the API
 * route) are responsible for the "is this a matched candidate for this
 * profile" check, same division of labour as getPropertyDetail /
 * isPropertyMatchedForProfile in lib/property-detail.ts.
 */
export async function getInvestmentMetrics(
  propertyId: number,
  thesisParams: ThesisParams,
): Promise<InvestmentMetrics | null> {
  const row = await fetchInvestmentInputs(propertyId);
  if (row === null) return null;

  // m2_built/min_price come from our own columns (numeric/text cast of a
  // numeric column) — always a clean number when non-null, so a plain
  // Number() is safe here. annual_ibi_eur/monthly_community_fee_eur come
  // from a third-party portal's raw_extra JSONB text and get the guarded
  // parse below (must-fix: a non-numeric raw_extra value must never
  // silently become NaN or 0 — see parseFiniteCarryingCost's docstring).
  const m2Built = row.m2_built !== null ? Number(row.m2_built) : null;
  const minPrice = row.min_price !== null ? Number(row.min_price) : null;
  const rawMonthlyCommunityFee = parseFiniteCarryingCost(row.monthly_community_fee_eur);
  const carryingCostsKnown: CarryingCostsKnown = {
    annual_ibi_eur: parseFiniteCarryingCost(row.annual_ibi_eur),
    monthly_community_fee_eur:
      rawMonthlyCommunityFee !== null && isPlausibleMonthlyCommunityFee(rawMonthlyCommunityFee)
        ? rawMonthlyCommunityFee
        : null,
  };

  const lat = row.lat !== null ? Number(row.lat) : null;
  const lon = row.lon !== null ? Number(row.lon) : null;

  const rentEstimate = await estimateRent(
    { id: propertyId, lat, lon, property_type: row.property_type, m2_built: m2Built },
    thesisParams,
  );
  const yieldResult = computeYield(
    { purchase_price: minPrice, province: row.province },
    rentEstimate,
    thesisParams,
    carryingCostsKnown,
  );
  const areaPrice = await computeAreaPriceComparison(propertyId);

  return {
    area_price: areaPrice,
    rent_estimate: rentEstimate,
    yield: yieldResult,
  };
}
