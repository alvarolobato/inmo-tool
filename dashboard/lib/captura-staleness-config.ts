/**
 * Read the Captura staleness-window config (issue #289) — server-only (reads
 * the config loader: env > config.yaml > schema default).
 *
 * Returns the client-safe {@link StalenessConfig} shape the Captura page uses:
 * a global default (`capture.staleness_days`, default 7) plus per-portal
 * overrides (`capture.staleness_days_<portal>`) for the portals in the capture
 * roster. A portal with no override — or a non-positive/unset one — inherits
 * the global default via {@link resolveStalenessDays}.
 */

import { getSystemConfig } from "@/lib/system-config/loader";
import { CAPTURE_PORTALS } from "@/lib/worklist";
import { DEFAULT_STALENESS_DAYS, type StalenessConfig } from "@/lib/captura-tasks";

function asPositiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Resolve the global default + per-portal staleness windows (in days). */
export function getStalenessConfig(): StalenessConfig {
  let defaultDays = DEFAULT_STALENESS_DAYS;
  const byPortal: Record<string, number> = {};

  try {
    const cfg = getSystemConfig();
    const globalVal = asPositiveInt(cfg["capture.staleness_days"]?.value);
    if (globalVal !== null) defaultDays = globalVal;

    for (const { portal } of CAPTURE_PORTALS) {
      const perPortal = asPositiveInt(cfg[`capture.staleness_days_${portal}`]?.value);
      if (perPortal !== null) byPortal[portal] = perPortal;
    }
  } catch {
    // Config loader unavailable (e.g. schema.yaml missing) — fall back to the
    // hardcoded default so the page still renders a sane window.
  }

  return { defaultDays, byPortal };
}
