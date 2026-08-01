/**
 * Locale-aware display helpers for admin usage / token metrics (Spanish).
 */

const intFmt = new Intl.NumberFormat("es-ES", {
  maximumFractionDigits: 0,
});

const compactFmt = new Intl.NumberFormat("es-ES", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
});

const usdFmt = new Intl.NumberFormat("es-ES", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

/** Integer with thousands separators (e.g. 1.234.567). */
export function formatIntegerEs(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return intFmt.format(Math.round(n));
}

/**
 * Compact form via `Intl` for `es-ES` (e.g. millions as "1,2 M"; thousands often as "12 mil",
 * not a literal "k" — exact string depends on the runtime's Spanish compact rules).
 */
export function formatCompactEs(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return compactFmt.format(n);
}

/**
 * Primary full integer + compact suffix for dense UI.
 * Example: primary "1.234.567", compact might be "1,2 M" (millions) or "12 mil" (thousands).
 */
export function formatTokensWithCompact(n: number): { primary: string; compact: string } {
  return {
    primary: formatIntegerEs(n),
    compact: formatCompactEs(n),
  };
}

/** USD with grouping; suitable next to a "USD" legend. */
export function formatUsdEs(amount: string | number): string {
  const num = typeof amount === "string" ? Number.parseFloat(amount) : amount;
  if (!Number.isFinite(num)) return "—";
  return usdFmt.format(num);
}
