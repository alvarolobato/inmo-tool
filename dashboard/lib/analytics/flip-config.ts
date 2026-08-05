/**
 * Resolve the configurable flip-thesis cost parameters (issue #45) from the
 * central config loader — env > config.yaml > `config/schema.yaml` default,
 * same precedence every other dashboard config reader uses
 * (`lib/notifications/config-read.ts`, `lib/ai-assessment/scheduler.ts`).
 *
 * Kept out of the pure calc modules (`renovation-estimate.ts`,
 * `flip-margin.ts`) so those stay DB/IO-free and unit-testable with explicit
 * bands. Loader-unavailable (schema file missing in some build contexts)
 * degrades to the code defaults rather than throwing.
 */

import { getSystemConfig } from "@/lib/system-config/loader";
import { DEFAULT_REFURB_COST_BANDS } from "./renovation-estimate";
import { DEFAULT_SALE_HOLDING_COST_PCT, type FlipMetricsConfig } from "./flip-margin";

/**
 * Read a non-negative number config key, falling back to `fallback`. All the
 * `flip.*` keys are `type: int` in `config/schema.yaml`, so the loader already
 * coerces their env/file/default value to a `number | null` — no string
 * parsing needed here. A missing/invalid value (or a loader that throws
 * because the schema file isn't present in some build context) degrades to the
 * code default.
 */
function readNonNegativeNumber(key: string, fallback: number): number {
  try {
    const raw = getSystemConfig()[key]?.value;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  } catch {
    // Loader unavailable — fall through to the default.
  }
  return fallback;
}

export function loadFlipConfig(): FlipMetricsConfig {
  return {
    refurbBands: {
      leve_eur_per_m2: readNonNegativeNumber(
        "flip.refurb_cost_leve_eur_m2",
        DEFAULT_REFURB_COST_BANDS.leve_eur_per_m2,
      ),
      integral_eur_per_m2: readNonNegativeNumber(
        "flip.refurb_cost_integral_eur_m2",
        DEFAULT_REFURB_COST_BANDS.integral_eur_per_m2,
      ),
      unknown_eur_per_m2: readNonNegativeNumber(
        "flip.refurb_cost_unknown_eur_m2",
        DEFAULT_REFURB_COST_BANDS.unknown_eur_per_m2,
      ),
    },
    saleHoldingCostPct: readNonNegativeNumber("flip.sale_holding_cost_pct", DEFAULT_SALE_HOLDING_COST_PCT),
  };
}
