/**
 * Date-range parameter token substitution for dashboard SQL.
 *
 * SQL strings can embed placeholder tokens that are replaced at render time
 * with the actual date range values selected by the user.
 */

export const CURR_FROM = ":curr_from";
export const CURR_TO   = ":curr_to";
export const COMP_FROM = ":comp_from";
export const COMP_TO   = ":comp_to";

export const CURR_MES_FROM = ":curr_mes_from";
export const CURR_MES_TO   = ":curr_mes_to";
export const COMP_MES_FROM = ":comp_mes_from";
export const COMP_MES_TO   = ":comp_mes_to";

export type ComparisonType =
  | "previous_period"
  | "previous_month"
  | "previous_quarter"
  | "previous_year"
  | "yoy"
  | "custom";

export interface DateParamRanges {
  curr: { from: Date; to: Date };
  comp?: { from: Date; to: Date };
}

function toDateStr(d: Date): string {
  const year  = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day   = String(d.getUTCDate()).padStart(2, "0");
  return "'" + year + "-" + month + "-" + day + "'";
}

function toMesInt(d: Date): string {
  return String(d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1));
}

/**
 * Substitutes date-range tokens in a SQL string.
 * Date tokens (:curr_from/:curr_to/:comp_from/:comp_to) resolve to quoted ISO strings ('YYYY-MM-DD').
 * Month tokens (:curr_mes_from/:curr_mes_to/:comp_mes_from/:comp_mes_to) resolve to bare integers (YYYYMM).
 * Comp tokens are left unchanged when ranges.comp is undefined.
 */
export function substituteDateParams(
  sql: string,
  ranges: DateParamRanges,
): string {
  // Token names are intentionally non-prefix of each other (e.g. :curr_from is not a
  // prefix of :curr_mes_from), so replaceAll order is safe. Keep it that way if adding tokens.
  let result = sql
    .replaceAll(CURR_FROM, toDateStr(ranges.curr.from))
    .replaceAll(CURR_TO,   toDateStr(ranges.curr.to))
    .replaceAll(CURR_MES_FROM, toMesInt(ranges.curr.from))
    .replaceAll(CURR_MES_TO,   toMesInt(ranges.curr.to));

  if (ranges.comp !== undefined) {
    result = result
      .replaceAll(COMP_FROM, toDateStr(ranges.comp.from))
      .replaceAll(COMP_TO,   toDateStr(ranges.comp.to))
      .replaceAll(COMP_MES_FROM, toMesInt(ranges.comp.from))
      .replaceAll(COMP_MES_TO,   toMesInt(ranges.comp.to));
  }

  return result;
}

export function comparisonTypeLabel(type: ComparisonType): string {
  switch (type) {
    case "previous_period":  return "vs período anterior";
    case "previous_month":   return "vs mes anterior";
    case "previous_quarter": return "vs trimestre anterior";
    case "previous_year":    return "vs año anterior";
    case "yoy":              return "vs mismo período año anterior";
    case "custom":           return "vs período personalizado";
  }
}
