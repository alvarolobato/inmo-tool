/**
 * Zero-results regression monitor — shared pure logic (issue #376).
 *
 * Client-safe: no `pg` import, so both the "Salud de datos" page (client
 * component) and the API route (server) can import the types and the detector.
 * DB access lives in lib/db/zero-result-regression.ts (server-only), the same
 * split as lib/data-health.ts ↔ lib/db/data-health.ts.
 *
 * The signal (owner's ático case, 2026-08-06): a (connector, resolved
 * scope/filter) that USED TO return listings and now returns 0 for N
 * consecutive runs — the real fingerprint of a filter/URL drift, portal-
 * agnostic and needing no DOM scraping. This is deliberately NOT "raw zero":
 *
 *   - A scope that has ALWAYS been 0 (a genuinely sparse / never-covered area)
 *     is NOT a regression — there was never anything to lose.
 *   - A single transient 0 (a one-off block, an empty refresh) is NOT a
 *     regression — it must persist for N consecutive runs.
 *   - A later non-zero run RECOVERS the scope and clears the flag.
 *
 * An "observation" is a run where discover() ACTUALLY RAN for the scope and
 * produced a real count (the server 'crawled'/'empty' outcomes; an extension
 * enumeration count). Runs where the scope was blocked/skipped/uncovered/
 * failed are NOT observations — a scope that couldn't be searched this run did
 * not "return 0 results", so those runs are excluded upstream (they never reach
 * this detector) rather than counted as zeros.
 */

/** The smallest sensible N-consecutive window; also the schema.yaml default. */
export const DEFAULT_ZERO_RESULT_REGRESSION_RUNS = 3;

/** One real result measurement for a (connector, scope), oldest→newest order. */
export interface ScopeObservation {
  /** Result count for this run (>= 0). 0 means "ran, found nothing here". */
  count: number;
  /** When the run happened (ISO), for surfacing when the drift started. */
  observedAt: string;
}

/** The verdict for one (connector, scope) time series. */
export interface RegressionVerdict {
  /** True when there is a prior non-zero AND the last N observations are 0. */
  flagged: boolean;
  /** Length of the current trailing run of zero observations (0 if last > 0). */
  consecutiveZeros: number;
  /** True when the series ever had a non-zero observation (a real baseline). */
  hadPriorNonZero: boolean;
  /** The last non-zero count seen before the trailing zero-run, or null. */
  lastNonZeroCount: number | null;
  /** ISO of the first zero in the current trailing zero-run, or null. */
  driftStartedAt: string | null;
  /** ISO of the most recent observation, or null when there are none. */
  lastObservedAt: string | null;
}

/**
 * Deterministic N-consecutive-zeros detector over ONE (connector, scope) series.
 *
 * `observations` MUST be ordered oldest→newest. `n` is the number of trailing
 * consecutive zero observations required to flag (clamped to >= 1). Pure and
 * total — no I/O, no clock — so it is trivially unit-testable and gives the
 * same answer for the same inputs every time.
 */
export function detectZeroResultRegression(
  observations: ScopeObservation[],
  n: number,
): RegressionVerdict {
  const threshold = Number.isInteger(n) && n >= 1 ? n : DEFAULT_ZERO_RESULT_REGRESSION_RUNS;

  if (observations.length === 0) {
    return {
      flagged: false,
      consecutiveZeros: 0,
      hadPriorNonZero: false,
      lastNonZeroCount: null,
      driftStartedAt: null,
      lastObservedAt: null,
    };
  }

  const lastObservedAt = observations[observations.length - 1].observedAt;

  // Count the trailing run of zeros and remember where it started.
  let consecutiveZeros = 0;
  let driftStartedAt: string | null = null;
  for (let i = observations.length - 1; i >= 0; i--) {
    if (observations[i].count === 0) {
      consecutiveZeros += 1;
      driftStartedAt = observations[i].observedAt;
    } else {
      break;
    }
  }

  // The most recent non-zero BEFORE the trailing zero-run is the baseline that
  // was lost. Its existence is what separates a real regression from a scope
  // that was simply never populated.
  const baselineIndex = observations.length - 1 - consecutiveZeros;
  const lastNonZeroCount = baselineIndex >= 0 ? observations[baselineIndex].count : null;
  const hadPriorNonZero = observations.some((o) => o.count > 0);

  // Flag only when a real baseline existed AND the drought has lasted the full
  // N runs. If the last observation is non-zero, consecutiveZeros === 0 → never
  // flagged (recovery). An always-zero series has hadPriorNonZero === false →
  // never flagged.
  const flagged = hadPriorNonZero && consecutiveZeros >= threshold;

  return {
    flagged,
    consecutiveZeros,
    hadPriorNonZero,
    lastNonZeroCount,
    driftStartedAt: consecutiveZeros > 0 ? driftStartedAt : null,
    lastObservedAt,
  };
}

/** A flagged (connector, scope) as surfaced on the data-health page. */
export interface ZeroResultRegression {
  connector: string;
  /** The resolved scope/filter key (e.g. "madrid-capital" / a scope repr). */
  scope_key: string;
  /** How many consecutive most-recent runs returned 0. */
  consecutive_zeros: number;
  /** The last non-zero count before the drought (the baseline that was lost). */
  last_nonzero_count: number | null;
  /** ISO of the first zero-run observation (when the drift began), or null. */
  drift_started_at: string | null;
  /** ISO of the most recent observation. */
  last_observed_at: string | null;
}
