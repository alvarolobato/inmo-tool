/**
 * Canonical list of dashboard user roles.
 *
 * Used both in the UI (role pill buttons) and in the suggest API route
 * for input validation.  Keeping this in a single place prevents the
 * two lists from drifting and avoids hard-coded strings in multiple files.
 */
export const DASHBOARD_ROLES = [
  "Responsable de tienda",
  "Director de ventas",
  "Comprador",
  "Director general",
  "Responsable de stock",
  "Controller financiero",
] as const;

export type DashboardRole = (typeof DASHBOARD_ROLES)[number];
