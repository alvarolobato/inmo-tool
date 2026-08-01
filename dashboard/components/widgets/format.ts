/**
 * European number formatting utilities for Spanish business context.
 * Uses dot for thousands separator, comma for decimal separator.
 */
import type { KpiFormat } from "@/lib/schema";

const euroFormatter = new Intl.NumberFormat("es-ES", {
  useGrouping: true,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const integerFormatter = new Intl.NumberFormat("es-ES", {
  useGrouping: true,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const percentFormatter = new Intl.NumberFormat("es-ES", {
  useGrouping: true,
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

// Decimal formatter for ratios / non-integer indicators such as
// "Unidades por Ticket" (1,69). Distinct from `number` (integer) so the
// caller can opt in to preserve fractional precision.
const decimalFormatter = new Intl.NumberFormat("es-ES", {
  useGrouping: true,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format a numeric value according to the given KPI format.
 * Returns a string like "€1.234,56", "1.234", or "12,3%".
 * Returns "—" for null, undefined, empty strings, and non-numeric values.
 */
export function formatValue(
  value: unknown,
  format: KpiFormat,
  prefix?: string,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(num)) return "—";

  switch (format) {
    case "currency": {
      const formatted = euroFormatter.format(num);
      return prefix ? `${prefix}${formatted}` : formatted;
    }
    case "percent":
      return `${percentFormatter.format(num)}%`;
    case "number":
      return integerFormatter.format(num);
    case "decimal": {
      const formatted = decimalFormatter.format(num);
      return prefix ? `${prefix}${formatted}` : formatted;
    }
    default:
      return String(num);
  }
}

// ---------------------------------------------------------------------------
// Phase C1 formatters
// ---------------------------------------------------------------------------

/** Format a number as EUR currency (es-ES locale, adaptive decimals). */
export function fmtEUR(value: number): string {
  const digits = Math.abs(value) < 100 ? 2 : 0;
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: digits,
  }).format(value);
}

/** Format as EUR with 0 decimals (es-ES). E.g. 38420 → "38.420 €" */
export function fmtEUR0(value: number): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

/** Format as EUR with 2 decimals (es-ES). E.g. 26.55 → "26,55 €" */
export function fmtEUR2(value: number): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Format signed percentage delta from a fraction (e.g. 0.082 → "+8,2%"). */
export function fmtPctSigned(value: number): string {
  const sign = value > 0 ? "+" : "";
  const pct = (value * 100).toLocaleString("es-ES", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${sign}${pct}%`;
}

/** Format a multiplier (e.g. 4.2 → "4,2"). */
export function fmtX(value: number): string {
  return value.toLocaleString("es-ES", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** Format integer (es-ES locale, no decimals). */
export function fmtInt(value: number): string {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(value);
}

/** Format percentage (1 decimal, es-ES). */
export function fmtPct(value: number): string {
  return new Intl.NumberFormat("es-ES", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Format delta ratio (e.g. 0.083 = +8.3%, -0.189 = -18.9%).
 * Returns an object with text, arrow symbol, and polarity flag.
 */
export function fmtDelta(delta: number): { text: string; arrow: "▲" | "▼"; positive: boolean } {
  const positive = delta >= 0;
  const pct = Math.abs(delta * 100);
  const text = `${positive ? "+" : "−"}${pct.toLocaleString("es-ES", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
  return { text, arrow: positive ? "▲" : "▼", positive };
}

// ---------------------------------------------------------------------------
// Phase D6 — toTitleCase
// ---------------------------------------------------------------------------

const LOWER_CONNECTORS = new Set([
  "de", "la", "el", "y", "en", "con", "del", "los", "las",
]);

/**
 * Apply Spanish title-case: lower common connectors/articles (except as the
 * first word), capitalise the rest.
 */
export function toTitleCase(s: string): string {
  if (!s) return s;
  return s
    .toLowerCase()
    .split(/(\s+|\/)/)
    .map((token, i) => {
      if (!token.trim() || token === "/") return token;
      if (i > 0 && LOWER_CONNECTORS.has(token)) return token;
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join("");
}
