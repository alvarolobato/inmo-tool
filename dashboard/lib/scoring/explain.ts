/**
 * Human-readable score explanation generation (task 3.3, #22).
 *
 * Deterministic and grounded in the actual trained model's learned
 * coefficients — this is NOT the LLM-based qualitative analysis Phase 4
 * adds on top later; an untrained/absent model must not produce a
 * confident-sounding sentence about coefficients that don't mean anything
 * yet (issue #22's Technical approach #3).
 *
 * Per-feature phrasing is a lookup table (`FEATURE_LABELS`), not string
 * concatenation of raw feature names — issue #1 §7's example register
 * ("ranked high: 6.2% gross yield vs 4.1% area average...") is natural
 * language, not a debug dump of z-scores.
 *
 * Cold-start states this module produces a message for: no trained model
 * yet, and a model that's trained but currently one-sided
 * ("needs_both_classes", see retrain.ts). A third null-score state —  a
 * candidate materialized after a profile's last retrain — is a known,
 * documented gap (retrain.ts's module docstring, issue #21 §4) with no write
 * at all yet; `candidates.ts` degrades this to rendering nothing rather than
 * a broken UI, which is an acceptable interim state, not a fix.
 */

import {
  FEATURE_NAMES,
  type FeatureName,
  type RawFeatureVector,
} from "./features";
import { normalizeVector, type TrainedModel } from "./model";

const TOP_N = 3;
// A z-scored feature times a near-zero learned weight is "no real signal",
// not a genuine (if tiny) contribution — excluded the same way a null raw
// value (imputed to the pool mean, contribution exactly 0) is.
const NEGLIGIBLE_CONTRIBUTION = 1e-6;

// Re-exported so every existing server-side importer keeps working; the
// string itself lives in a dependency-free module because client components
// need it too and this one transitively imports `pg` (see cold-start.ts).
export { COLD_START_EXPLANATION } from "./cold-start";
import { COLD_START_EXPLANATION } from "./cold-start";

const NO_SIGNAL_EXPLANATION =
  "Sin motivos concretos que destacar todavía para este candidato.";

export interface FeatureContribution {
  name: FeatureName;
  /** Signed: `weight_i * normalized_value_i`. Positive pushes the score up, negative pushes it down. */
  contribution: number;
  /** The feature's real-world (non-normalized) value — always non-null here, see {@link computeContributions}. */
  rawValue: number;
}

/**
 * Signed per-feature contributions, sorted by absolute magnitude descending.
 * Excludes features with a `null` raw value: `normalizeVector` imputes a
 * missing value to exactly the pool mean (z-score 0), so its contribution is
 * exactly 0 — there is nothing true to say about a feature this candidate
 * has no data for, and "the model considered floor and found it neutral"
 * would misrepresent "the model has no floor data for this listing" as if
 * it were a real, informative outcome.
 */
export function computeContributions(
  raw: RawFeatureVector,
  model: Pick<TrainedModel, "weights" | "normalization">,
): FeatureContribution[] {
  const x = normalizeVector(raw, model.normalization);
  const contributions: FeatureContribution[] = [];

  FEATURE_NAMES.forEach((name, i) => {
    const rawValue = raw[name];
    if (rawValue === null) return;
    const contribution = model.weights[i] * x[i];
    if (Math.abs(contribution) < NEGLIGIBLE_CONTRIBUTION) return;
    contributions.push({ name, contribution, rawValue });
  });

  return contributions.sort(
    (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution),
  );
}

function pct(fraction: number): string {
  return `${Math.round(Math.abs(fraction) * 100)}%`;
}

/** "3ª" / "baja" / "ático" / etc. — mirrors `parseFloorNumeric`'s own sentinel choices in `features.ts`. */
function floorLabel(v: number): string {
  if (v >= 50) return "ático";
  if (v === -1) return "sótano";
  if (v === -0.5) return "semisótano";
  if (v === 0.5) return "entreplanta";
  if (v === 0) return "baja";
  const rounded = Math.round(v);
  return rounded < 0 ? `sótano ${Math.abs(rounded)}` : `${rounded}ª`;
}

/** One phrase per feature, aware of the feature's real value and whether it's helping (`positive`) or hurting the score. */
type PhraseFn = (rawValue: number, positive: boolean) => string;

const FEATURE_LABELS: Record<FeatureName, PhraseFn> = {
  // Direction ("por debajo"/"por encima") is derived from the raw value `v`
  // itself (v<1 means below the profile's price band, v>=1 means at/above
  // it) — NOT from `positive` (the contribution's sign). Those are different
  // claims: `positive` says whether this feature is helping or hurting the
  // score under this profile's *learned* weight, which can be positive (a
  // user whose accept/reject pattern favors pricier properties). Keying the
  // price direction off `positive` would then describe an above-band price
  // as "below" — confirmed reachable, not hypothetical (Opus review of PR
  // #92, item 1). `positive` still drives the separate "coincide/no coincide
  // con tus preferencias" framing, which correctly is about the model, not
  // the raw price.
  price_per_m2_relative: (v, positive) => {
    const direction =
      v < 1 ? `un ${pct(1 - v)} por debajo` : `un ${pct(v - 1)} por encima`;
    const fit = positive
      ? "coincide con tus preferencias"
      : "no coincide con tus preferencias";
    return `precio ${direction} de tu banda de precio (${fit})`;
  },
  m2_built: (v, positive) =>
    positive
      ? `tamaño (${Math.round(v)} m²) dentro de lo que este perfil suele aceptar`
      : `tamaño (${Math.round(v)} m²) fuera de lo que este perfil suele aceptar`,
  rooms: (v, positive) =>
    positive
      ? `${Math.round(v)} habitaciones, coincide con tus aceptaciones habituales`
      : `${Math.round(v)} habitaciones, no es lo habitual en lo que aceptas`,
  floor_numeric: (v, positive) => {
    const label = floorLabel(v);
    return positive
      ? `planta ${label}, como en tus aceptaciones`
      : `planta ${label}, normalmente la rechazas`;
  },
  has_elevator: (v, positive) => {
    const hasElevator = v === 1;
    if (hasElevator)
      return positive
        ? "tiene ascensor, como sueles preferir"
        : "tiene ascensor, pero no coincide con tus preferencias habituales";
    return positive
      ? "sin ascensor, como en aceptaciones anteriores"
      : "sin ascensor (normalmente lo rechazas)";
  },
  year_built: (v, positive) =>
    positive
      ? `año de construcción (${Math.round(v)}) similar a tus aceptaciones`
      : `año de construcción (${Math.round(v)}) distinto de tus aceptaciones habituales`,
  // Populated by task 5.4 (#34) — real values now flow through here whenever
  // the trained model ranks them among a candidate's top contributions
  // (issue #34 EC-3's "references days-on-market or price-drop when notable").
  // Direction words are keyed off the RAW value's own sign, NOT `positive`
  // (the learned-contribution sign) — the same distinction price_per_m2's
  // phrase draws: "how long / which way did the price move" is a fact about
  // the listing, independent of whether the model happens to weight it up or
  // down for this profile.
  days_on_market: (v) => `${Math.round(v)} días en el mercado`,
  price_drop_pct: (v) =>
    v >= 0
      ? `bajada de precio del ${pct(v)}`
      : `subida de precio del ${pct(v)}`,
};

/**
 * `(featureVector, coefficients, listing) -> string` per issue #22's
 * touchpoint signature. `listing` isn't used by any current feature's
 * phrasing (every phrase is derivable from `raw`/`model` alone) — kept as a
 * documented, optional parameter so a future feature (e.g. Phase 5's yield,
 * which would want to reference the listing's own price/rent directly) can
 * use it without another signature change; passing it is a no-op today.
 */
export function explainScore(
  raw: RawFeatureVector,
  model: Pick<TrainedModel, "weights" | "bias" | "normalization"> | null,
  _listing?: unknown,
): string {
  if (model === null) return COLD_START_EXPLANATION;

  const contributions = computeContributions(raw, model);
  if (contributions.length === 0) return NO_SIGNAL_EXPLANATION;

  const top = contributions.slice(0, TOP_N);
  // Overall direction from the real total (sum of ALL contributions + bias,
  // not just the top-N or just the strongest single feature) — a listing
  // could have its top individual factor be a small positive while smaller,
  // less-prominent negatives outweigh it in total; the "ranked high/low"
  // framing should match the actual score, not just the loudest input.
  // "Encaja bien/mal", not "Ranking alto/bajo": originally chosen (Opus
  // review of PR #92, item 2) because candidates.ts ordered this profile's
  // list by property id, not by score, so there was no actual rank to
  // report and an absolute sigmoid-0.5 cutoff would mislabel the
  // best-scoring candidate in a mostly-rejected, early-life profile as
  // "Ranking bajo". Task 3.4 (#23) made candidates.ts sort globally by
  // score, so a real rank now exists — kept "Encaja bien/mal" anyway
  // (Fable phase-3 review) rather than switching to rank language, since
  // this sentence is generated from one candidate's own feature
  // contributions with no visibility into the rest of the pool; a
  // "ranked high" claim implied more certainty about relative standing
  // than a single-candidate computation actually has, especially in a
  // small/early-life pool where one new listing can reorder everything.
  const total =
    contributions.reduce((sum, c) => sum + c.contribution, 0) + model.bias;
  const prefix =
    total >= 0 ? "Encaja bien con tu perfil: " : "Encaja mal con tu perfil: ";

  const phrases = top.map((c) =>
    FEATURE_LABELS[c.name](c.rawValue, c.contribution > 0),
  );
  return prefix + phrases.join("; ") + ".";
}
