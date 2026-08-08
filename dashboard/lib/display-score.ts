/**
 * Investor score — the PURE, dependency-free display layer for #452 (Fable's
 * design). This module holds NO server imports (no `pg`, no `db-write`) so it is
 * safe to import from client components (the card chip and the detail
 * "Puntuación inversora" section) as well as from the server-only
 * `lib/candidates.ts`.
 *
 * ## The model: a re-expression of `effective_score`, never a second ranking
 *
 * The number shown to the user is a MONOTONE re-expression of the feed's
 * `effective_score` (lib/candidates.ts, #309/D-057), NOT a new score. One
 * number, one order: the 0–100 the card shows can never disagree with the order
 * the feed sorts on, and the #425 keyset cursor is untouched. `effective_score`
 * is the learned/cold-start sigmoid base AUGMENTED with additive, non-negative
 * opportunity boosts (below-market, distress, beach, tourist licence) plus the
 * #452 timing boosts (days-on-market, price-drop). Every boost is ≥ 0, so a
 * never-scored candidate (base score NULL → `NO_SCORE_SENTINEL` = −1) still sits
 * strictly below any real score even at the maximum total boost — see
 * `MAX_TOTAL_BOOST` / `DISPLAY_SCORE_CEIL` below for the recomputed ceiling.
 *
 * Display = `clamp(round(effective_score / DISPLAY_SCORE_CEIL × 100), 0, 100)` +
 * a colour band (A "Oportunidad" … D "Flojo", "Sin puntuar" for the sentinel) +
 * a confidence tier (alta/media/baja from input coverage) + a per-term
 * breakdown whose points sum EXACTLY to the shown score.
 *
 * ## Risk flags are chips, never subtracted (owner decision, #452)
 *
 * A distressed listing (occupied, debt sale, red flag) is the OPPORTUNITY for a
 * REO / value buyer, so distress is an additive boost, and the individual red
 * flags are surfaced as informational CHIPS in the breakdown — they are never
 * subtracted from the score.
 */

// ── Boost weights and caps (single source of truth) ─────────────────────────
//
// These are the exact numeric weights `lib/candidates.ts` interpolates into the
// `rankedCandidatesCte` `effective_score` expression. They live HERE (a pure,
// client-safe module) so the display breakdown and the SQL sort key derive from
// ONE set of constants and can never drift (D-059 derive-once). candidates.ts
// imports them; it does not redeclare them.

/** `score` (a sigmoid) is in (0,1) when set; −1 is the "never scored" sentinel that sorts last under `effective_score DESC`. */
export const NO_SCORE_SENTINEL = -1;

/** Below-market discount is capped at 50% below the pool median (beyond that is almost always a data error). */
export const BELOW_MARKET_DISCOUNT_CAP = 0.5;
/** Weight on the (capped) below-market discount fraction → max +0.25. */
export const BELOW_MARKET_WEIGHT = 0.5;

/** Distress axes counted (occupancy warn caveat / red flag / a_reformar). */
export const DISTRESS_MAX_UNITS = 3;
/** Per-axis distress weight → all three present is +0.15. */
export const DISTRESS_UNIT_WEIGHT = 0.05;

/** Graded beach-proximity boost units (frontline > sea_view > near_beach). */
export const BEACH_PROXIMITY_BOOST_UNITS: Record<string, number> = {
  frontline: 3,
  sea_view: 2,
  near_beach: 1,
};
/** Per-grade beach weight → frontline is +0.09. */
export const BEACH_UNIT_WEIGHT = 0.03;

/** Single-boolean tourist-licence boost → +0.04. */
export const TOURIST_LICENSE_BOOST = 0.04;

// ── #452 timing boosts (Fable's default weights) ────────────────────────────

/** Days-on-market boost weight → a long-listed property earns at most +0.04. */
export const DOM_BOOST_WEIGHT = 0.04;
/**
 * Days on market at which the DOM boost saturates (reaches its full weight).
 * A ~6-month-old listing is a strongly motivated seller; anything longer earns
 * the same ceiling (the ramp is linear up to here, then flat).
 */
export const DOM_SATURATION_DAYS = 180;

/** Net price-drop boost weight → a large cumulative drop earns at most +0.07. */
export const PRICE_DROP_BOOST_WEIGHT = 0.07;
/** Net price-drop fraction at which the price-drop boost saturates (a 20% cut = full weight). */
export const PRICE_DROP_SATURATION = 0.2;
/**
 * Joint cap on the two timing boosts (Fable: 0.11). Equal to
 * `DOM_BOOST_WEIGHT + PRICE_DROP_BOOST_WEIGHT` today, so it only binds at the
 * exact combined maximum — kept explicit so the caps stay independent of the
 * two weights if either is retuned later.
 */
export const TIMING_JOINT_CAP = 0.11;

/**
 * The maximum total additive boost, recomputed from the constants above so the
 * #309/D-057 "never-scored floor" invariant is verifiable, not asserted by a
 * hand-maintained comment:
 *
 *   below-market 0.25 + distress 0.15 + beach 0.09 + tourist 0.04 + timing 0.11
 *   = 0.64
 *
 * A never-scored candidate (−1 sentinel) at the maximum boost lands at
 * −1 + 0.64 = −0.36 — still strictly below any real sigmoid score in (0,1), so
 * "augment, never replace" holds after adding the timing terms.
 */
export const MAX_TOTAL_BOOST =
  BELOW_MARKET_DISCOUNT_CAP * BELOW_MARKET_WEIGHT +
  DISTRESS_MAX_UNITS * DISTRESS_UNIT_WEIGHT +
  Math.max(...Object.values(BEACH_PROXIMITY_BOOST_UNITS)) * BEACH_UNIT_WEIGHT +
  TOURIST_LICENSE_BOOST +
  TIMING_JOINT_CAP;

/**
 * Denominator that maps `effective_score` → 0–1 before the ×100. The theoretical
 * ceiling of `effective_score` is `1.0` (the sigmoid supremum) + `MAX_TOTAL_BOOST`
 * = 1.64 (Fable's chosen divisor). A real score never reaches it (sigmoid < 1),
 * so the ×100 result is always strictly < 100 before rounding; `clamp` guards
 * the boundary regardless.
 */
export const DISPLAY_SCORE_CEIL = 1 + MAX_TOTAL_BOOST;

// ── Pure boost math (mirrors the SQL in rankedCandidatesCte) ─────────────────

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(n, lo), hi);

/** Below-market boost from the signed discount fraction (negative = above market → 0). */
export function belowMarketBoost(belowMarketPct: number | null): number {
  if (belowMarketPct === null || !Number.isFinite(belowMarketPct)) return 0;
  return clamp(belowMarketPct, 0, BELOW_MARKET_DISCOUNT_CAP) * BELOW_MARKET_WEIGHT;
}

/** Distress/opportunity boost from the 0–3 axis count. */
export function distressBoost(distressLevel: number): number {
  const n = Number.isFinite(distressLevel) ? distressLevel : 0;
  return Math.min(Math.max(n, 0), DISTRESS_MAX_UNITS) * DISTRESS_UNIT_WEIGHT;
}

/** Graded beach-proximity boost; `none`/null/unknown grade → 0. */
export function beachBoost(beachProximity: string | null): number {
  if (beachProximity === null) return 0;
  const units = BEACH_PROXIMITY_BOOST_UNITS[beachProximity] ?? 0;
  return units * BEACH_UNIT_WEIGHT;
}

/** Tourist-licence boost (single boolean). */
export function touristBoost(touristLicense: boolean): number {
  return touristLicense ? TOURIST_LICENSE_BOOST : 0;
}

/** Days-on-market boost: linear ramp to `DOM_SATURATION_DAYS`, then flat; null/≤0 → 0. */
export function domBoost(daysOnMarket: number | null): number {
  if (daysOnMarket === null || !Number.isFinite(daysOnMarket)) return 0;
  return clamp(daysOnMarket / DOM_SATURATION_DAYS, 0, 1) * DOM_BOOST_WEIGHT;
}

/** Net price-drop boost: linear ramp to `PRICE_DROP_SATURATION`, then flat; null/≤0 (a rise) → 0. */
export function priceDropBoost(priceDropPct: number | null): number {
  if (priceDropPct === null || !Number.isFinite(priceDropPct)) return 0;
  return clamp(priceDropPct / PRICE_DROP_SATURATION, 0, 1) * PRICE_DROP_BOOST_WEIGHT;
}

/** Combined timing boost with the joint cap (matches the SQL `LEAST(dom + drop, cap)`). */
export function timingBoost(
  daysOnMarket: number | null,
  priceDropPct: number | null,
): number {
  return Math.min(
    domBoost(daysOnMarket) + priceDropBoost(priceDropPct),
    TIMING_JOINT_CAP,
  );
}

// ── Display mapping: effective_score → 0–100, band, confidence ───────────────

export type ScoreGrade = "A" | "B" | "C" | "D";

export interface ScoreBand {
  grade: ScoreGrade;
  /** Spanish label shown next to the number. */
  label: string;
  /** Foreground CSS token for the band colour. */
  color: string;
  /** Background CSS token for the band chip. */
  bg: string;
}

/**
 * Band thresholds on the 0–100 display score. A "Oportunidad" is the top band;
 * D "Flojo" the bottom. Colours reuse the app-wide semantic tokens (green =
 * good, amber = middling, red = weak) so the band reads the same in both themes.
 */
export const SCORE_BANDS: readonly (ScoreBand & { min: number })[] = [
  { grade: "A", min: 70, label: "Oportunidad", color: "var(--up)", bg: "var(--up-bg)" },
  { grade: "B", min: 50, label: "Buena", color: "var(--accent)", bg: "var(--accent-soft)" },
  { grade: "C", min: 30, label: "Media", color: "var(--warn)", bg: "var(--warn-bg)" },
  { grade: "D", min: 0, label: "Flojo", color: "var(--down)", bg: "var(--down-bg)" },
] as const;

/** The sentinel band shown for a never-scored property (base score NULL). */
export const UNSCORED_BAND = {
  grade: null,
  label: "Sin puntuar",
  color: "var(--fg-subtle)",
  bg: "var(--bg-2)",
} as const;

export function bandForScore(value: number): ScoreBand {
  for (const b of SCORE_BANDS) {
    if (value >= b.min) return b;
  }
  // Unreachable (last band min = 0), but keep the function total.
  return SCORE_BANDS[SCORE_BANDS.length - 1];
}

export type ConfidenceTier = "alta" | "media" | "baja";

/**
 * Confidence tier from how many of the score's inputs actually carry data
 * (coverage). A score built from the learned model plus several present signals
 * is trustworthy (alta); one resting on the base score alone is baja. This is a
 * DISPLAY affordance only — it never changes the number or the order.
 *
 * `signalsPresent` counts the non-base inputs that had data (below-market,
 * distress assessment, beach, tourist, days-on-market, price-drop); `hasBase`
 * is whether a learned/cold-start base score exists.
 */
export function confidenceTier(
  hasBase: boolean,
  signalsPresent: number,
): ConfidenceTier {
  if (!hasBase) return "baja";
  if (signalsPresent >= 3) return "alta";
  if (signalsPresent >= 1) return "media";
  return "baja";
}

export interface DisplayScore {
  /** True when the property has never been scored (base score NULL → sentinel). */
  unscored: boolean;
  /** 0–100 display score; null when `unscored`. */
  value: number | null;
  /** Band (colour + label); `UNSCORED_BAND` shape when `unscored`. */
  band: ScoreBand | typeof UNSCORED_BAND;
}

/**
 * Maps an `effective_score` to the display score + band. A null or negative
 * `effective_score` is the never-scored sentinel (real scores are always
 * strictly positive: sigmoid > 0 plus non-negative boosts) → "Sin puntuar",
 * never mapped to a number.
 */
export function toDisplayScore(effectiveScore: number | null): DisplayScore {
  if (
    effectiveScore === null ||
    !Number.isFinite(effectiveScore) ||
    effectiveScore <= 0
  ) {
    return { unscored: true, value: null, band: UNSCORED_BAND };
  }
  const value = clamp(
    Math.round((effectiveScore / DISPLAY_SCORE_CEIL) * 100),
    0,
    100,
  );
  return { unscored: false, value, band: bandForScore(value) };
}

// ── Breakdown that sums exactly to the score ─────────────────────────────────

/** Raw inputs for a single property's investor score — the values the ranked CTE derives. */
export interface InvestorScoreInputs {
  /** Learned/cold-start sigmoid base score in (0,1), or null when never scored. */
  base_score: number | null;
  /** Authoritative blended sort key from SQL (the single source of truth for the order). */
  effective_score: number | null;
  below_market_pct: number | null;
  distress_level: number;
  beach_proximity: string | null;
  tourist_license: boolean;
  days_on_market: number | null;
  price_drop_pct: number | null;
}

export interface BreakdownTerm {
  key: string;
  label: string;
  /** Integer points this term contributes to the displayed score (reconciled to sum exactly). */
  points: number;
  /** False when the underlying signal had no data — rendered as a "sin datos" row, 0 points. */
  hasData: boolean;
}

export interface InvestorScoreBreakdown {
  display: DisplayScore;
  confidence: ConfidenceTier;
  /** Numeric contribution terms; `points` sum EXACTLY to `display.value`. */
  terms: BreakdownTerm[];
}

/**
 * Builds the detail-page breakdown. Each term's raw point value is
 * `boost / DISPLAY_SCORE_CEIL × 100` (the base term uses the sigmoid base),
 * then integer points are distributed by largest-remainder so they sum EXACTLY
 * to `display.value` — the "per-term points visibly sum to the score" contract.
 * The total is anchored to the authoritative `effective_score`, so any FP drift
 * between this reconstruction and the SQL expression is absorbed into the
 * rounding rather than shown as a mismatch.
 */
export function investorScoreBreakdown(
  inputs: InvestorScoreInputs,
): InvestorScoreBreakdown {
  const display = toDisplayScore(inputs.effective_score);

  const bmBoost = belowMarketBoost(inputs.below_market_pct);
  const dBoost = distressBoost(inputs.distress_level);
  const bBoost = beachBoost(inputs.beach_proximity);
  const tBoost = touristBoost(inputs.tourist_license);
  const domB = domBoost(inputs.days_on_market);
  const dropB = priceDropBoost(inputs.price_drop_pct);
  // Timing joint cap can shave the sum of dom+drop; scale each proportionally so
  // the two timing rows still sum to the capped timing boost.
  const timingRaw = domB + dropB;
  const timingCapped = Math.min(timingRaw, TIMING_JOINT_CAP);
  const timingScale = timingRaw > 0 ? timingCapped / timingRaw : 0;

  const raw: Array<Omit<BreakdownTerm, "points"> & { boost: number }> = [
    {
      key: "base",
      label: "Ajuste al perfil (modelo)",
      boost: inputs.base_score ?? 0,
      hasData: inputs.base_score !== null,
    },
    {
      key: "below_market",
      label: "Precio bajo mercado",
      boost: bmBoost,
      hasData:
        inputs.below_market_pct !== null &&
        Number.isFinite(inputs.below_market_pct),
    },
    {
      key: "distress",
      label: "Señales de oportunidad (ocupación / estado / cargas)",
      boost: dBoost,
      hasData: inputs.distress_level > 0,
    },
    {
      key: "beach",
      label: "Proximidad a la playa",
      boost: bBoost,
      hasData:
        inputs.beach_proximity !== null &&
        (BEACH_PROXIMITY_BOOST_UNITS[inputs.beach_proximity] ?? 0) > 0,
    },
    {
      key: "tourist",
      label: "Licencia turística",
      boost: tBoost,
      hasData: inputs.tourist_license === true,
    },
    {
      key: "days_on_market",
      label: "Días en el mercado",
      boost: domB * timingScale,
      hasData: inputs.days_on_market !== null,
    },
    {
      key: "price_drop",
      label: "Bajada de precio acumulada",
      boost: dropB * timingScale,
      hasData: inputs.price_drop_pct !== null,
    },
  ];

  // No score → all terms render as 0-point rows (their `hasData` still drives
  // the "sin datos" vs "detectado" copy).
  const total = display.value ?? 0;
  const rawPoints = raw.map((t) => (t.boost / DISPLAY_SCORE_CEIL) * 100);
  const points = distributeRounding(rawPoints, total);

  return {
    display,
    confidence: confidenceTier(
      inputs.base_score !== null,
      raw.filter((t) => t.key !== "base" && t.hasData).length,
    ),
    terms: raw.map((t, i) => ({
      key: t.key,
      label: t.label,
      points: points[i],
      hasData: t.hasData,
    })),
  };
}

/**
 * Largest-remainder rounding: rounds each raw value DOWN, then hands the
 * leftover units (target − Σ floors) to the entries with the largest fractional
 * parts, so the returned integers sum EXACTLY to `target`. Negative raw values
 * (shouldn't occur — every boost is ≥ 0) floor to 0 rather than going negative.
 */
export function distributeRounding(raw: number[], target: number): number[] {
  const floors = raw.map((r) => Math.max(0, Math.floor(r)));
  let remainder = target - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  // Distribute positive remainder to the largest fractions; if the floors
  // overshoot (rare FP case), trim from the smallest fractions.
  let k = 0;
  while (remainder > 0 && order.length > 0) {
    out[order[k % order.length].i] += 1;
    remainder -= 1;
    k += 1;
  }
  k = 0;
  const asc = [...order].reverse();
  while (remainder < 0 && asc.length > 0) {
    const idx = asc[k % asc.length].i;
    if (out[idx] > 0) {
      out[idx] -= 1;
      remainder += 1;
    }
    k += 1;
    if (k > asc.length * 3) break; // safety valve
  }
  return out;
}
