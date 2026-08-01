/**
 * Deep links from weekly review to dashboards with prefilled date ranges.
 */

import type { ReviewDashboardKey } from "./review-schema";

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function comparisonWindowForClosedWeek(
  weekStartIso: string,
  weekEndSundayIso: string,
): { compFrom: string; compTo: string } {
  return {
    compFrom: addDaysIso(weekStartIso, -7),
    compTo: addDaysIso(weekEndSundayIso, -7),
  };
}

export function buildDashboardReviewHref(
  dashboardId: number,
  weekStartIso: string,
  weekEndSundayIso: string,
): string {
  const { compFrom, compTo } = comparisonWindowForClosedWeek(weekStartIso, weekEndSundayIso);
  const sp = new URLSearchParams({
    curr_from: weekStartIso,
    curr_to: weekEndSundayIso,
    comp_from: compFrom,
    comp_to: compTo,
  });
  return `/dashboard/${dashboardId}?${sp.toString()}`;
}

export function reviewDashboardDisplayName(key: ReviewDashboardKey): string {
  switch (key) {
    case "ventas_retail":
      return "Review semanal — Ventas retail";
    case "canal_mayorista":
      return "Review semanal — Canal mayorista";
    case "stock":
      return "Review semanal — Stock";
    case "compras":
      return "Review semanal — Compras";
    default:
      return "Review semanal";
  }
}
