/**
 * Composes the three Phase 5 analytics modules (issues #151/#32/#33) into
 * one result for the property detail page's investment-metrics section.
 *
 * Server-only: imports lib/db-write (the `pg` client) — same reasoning as
 * lib/candidates.ts / lib/property-detail.ts, never import from a client
 * component.
 *
 * Placed at `lib/`, not `lib/analytics/`, on purpose: everything in
 * `lib/analytics/` is a pure function (DB-free, cheaply unit-testable —
 * see that directory's own test files). This module is the DB-aggregation
 * layer that feeds them real property data, mirroring how
 * `lib/property-detail.ts` composes `lib/candidates.ts`'s query
 * conventions rather than being a pure function itself.
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

  const m2Built = row.m2_built !== null ? Number(row.m2_built) : null;
  const minPrice = row.min_price !== null ? Number(row.min_price) : null;
  const carryingCostsKnown: CarryingCostsKnown = {
    annual_ibi_eur: row.annual_ibi_eur !== null ? Number(row.annual_ibi_eur) : null,
    monthly_community_fee_eur:
      row.monthly_community_fee_eur !== null ? Number(row.monthly_community_fee_eur) : null,
  };

  const rentEstimate = estimateRent({ m2_built: m2Built }, thesisParams);
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
