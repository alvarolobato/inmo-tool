/**
 * Per-profile preference signal — a self-learning nudge derived from a
 * profile's OWN accept/reject/star history (task 7.2, #40).
 *
 * This is the pragmatic v2 scaffold issue #40 scopes: rather than standing up
 * a text-embedding provider on day one (only ~6 feedback events exist across
 * the whole platform today), it learns a preference direction over the SAME
 * canonical feature space the trained model already uses
 * (`features.ts#extractRaw`, z-scored via `model.ts#normalizeVector`). If a
 * real listing-text embedding is wired later, it slots in as additional
 * dimensions of the same vector — the math here is embedding-agnostic.
 *
 * How it learns (no hardcoded preferences — everything is derived from the
 * owner's own decisions):
 *   - Take every property this profile has an accept/star (positive) or reject
 *     (negative) verdict on, as its z-scored feature vector.
 *   - The profile's "liked" direction is the centroid of the positive
 *     vectors; the "disliked" direction is the centroid of the negatives.
 *   - A candidate's preference signal = cosine(candidate, positiveCentroid) −
 *     cosine(candidate, negativeCentroid): positive when it looks more like
 *     what this profile accepted than what it rejected, negative otherwise.
 *
 * Graceful activation (the whole point of the scaffold): below
 * {@link MIN_FEEDBACK_TO_LEARN} labeled examples for a profile,
 * {@link buildPreferenceModel} returns `null` and the signal is EXACTLY 0 —
 * `applyPreferenceSignal` then returns the base score unchanged. So at today's
 * 6-event platform-wide state NOTHING moves, and the signal turns on
 * automatically, per profile, the moment a profile accumulates enough of its
 * own feedback. A tiny sample can never dominate ranking: the influence is a
 * fixed-modest {@link PREFERENCE_SIGNAL_WEIGHT} on top of the existing score,
 * clamped to a valid (0,1) score, and a candidate with no feature data (all
 * features imputed to the pool mean → the zero vector after z-scoring) gets a
 * cosine of 0 against both centroids — signal 0, i.e. no fabricated influence.
 *
 * Server-only: `loadProfilePreferenceModel`/`fetchLatestFeedbackStates` read
 * Postgres via `features.ts` (which imports `@/lib/db-write`), same as the
 * rest of the scoring pipeline. The pure math functions have no DB dependency
 * and are unit-tested directly.
 */

import { sql } from "@/lib/db-write";
import { getProfileById } from "@/lib/db/profiles";
import { extractRaw, fetchScoringInputs, type RawFeatureVector } from "./features";
import {
  computeNormalization,
  normalizeVector,
  type NormalizationStats,
} from "./model";

/**
 * Minimum labeled (accept/reject/star) examples a profile needs before the
 * preference signal contributes anything at all. Deliberately well BELOW
 * `pipeline.ts#MIN_TRAINING_EXAMPLES` (32) — the preference signal's whole
 * reason to exist is to start personalizing in the window where the full
 * logistic model can't yet be fit, then keep augmenting it afterwards. 8 is a
 * "both classes, a few of each" floor: enough that a centroid isn't just one
 * or two clicks, small enough that it activates long before the full model.
 * A named constant, not a magic number, so the graceful-activation threshold
 * is a single documented knob.
 */
export const MIN_FEEDBACK_TO_LEARN = 8;

/**
 * How hard the preference signal (in [−1, 1]) is allowed to push the base
 * score. Modest by design: it AUGMENTS the price/cold-start or trained score,
 * never overrides it — at most ±0.15 on a (0,1) score. Same "augment, never
 * replace the learned score" discipline as D-057's ranking boosts.
 */
export const PREFERENCE_SIGNAL_WEIGHT = 0.15;

/**
 * Below this absolute signal magnitude the preference contribution is treated
 * as "no real lean" for EXPLANATION purposes — the honest phrasing is omitted
 * rather than narrating a near-zero cosine difference as a real preference.
 * (The score nudge itself is still applied; it's just too small to be worth a
 * sentence.)
 */
export const PREFERENCE_MEANINGFUL_THRESHOLD = 0.05;

export interface PreferenceModel {
  /** Centroid of the accepted/starred candidates' z-scored feature vectors. */
  positiveCentroid: number[];
  /** Centroid of the rejected candidates' z-scored feature vectors. */
  negativeCentroid: number[];
  positiveCount: number;
  negativeCount: number;
}

export interface LabeledVector {
  vector: number[];
  /** 1 = accept/star (positive), 0 = reject (negative). */
  label: 0 | 1;
}

/** star and accept both label the "liked" class; reject is the only negative — mirrors retrain.ts. */
export function labelForFeedback(type: "accept" | "reject" | "star"): 0 | 1 {
  return type === "reject" ? 0 : 1;
}

function centroid(vectors: number[][]): number[] {
  const d = vectors[0].length;
  const sum = new Array<number>(d).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < d; i++) sum[i] += v[i];
  }
  return sum.map((s) => s / vectors.length);
}

/**
 * Cosine similarity. Returns 0 when either vector has zero magnitude — for a
 * z-scored candidate that's "every feature at the pool mean" (no
 * distinguishing data), which must contribute no preference signal rather than
 * a NaN or a fabricated lean.
 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Builds a profile's preference model from its labeled feature vectors, or
 * `null` when it must stay a no-op: fewer than {@link MIN_FEEDBACK_TO_LEARN}
 * labeled examples, or all-one-class (a centroid of only positives or only
 * negatives can't express a *direction* between liked and disliked). `null`
 * is the graceful-degradation contract every caller relies on.
 */
export function buildPreferenceModel(
  labeled: LabeledVector[],
): PreferenceModel | null {
  if (labeled.length < MIN_FEEDBACK_TO_LEARN) return null;
  const positives = labeled.filter((l) => l.label === 1).map((l) => l.vector);
  const negatives = labeled.filter((l) => l.label === 0).map((l) => l.vector);
  if (positives.length === 0 || negatives.length === 0) return null;
  return {
    positiveCentroid: centroid(positives),
    negativeCentroid: centroid(negatives),
    positiveCount: positives.length,
    negativeCount: negatives.length,
  };
}

/**
 * The preference signal for one candidate's z-scored feature vector, in
 * [−1, 1]. Exactly 0 when `model` is `null` (below threshold / one-sided) —
 * this is what makes the whole mechanism a hard no-op until a profile has
 * enough of its own feedback.
 */
export function preferenceSignal(
  model: PreferenceModel | null,
  vector: number[],
): number {
  if (model === null) return 0;
  const simPos = cosine(vector, model.positiveCentroid);
  const simNeg = cosine(vector, model.negativeCentroid);
  return clamp(simPos - simNeg, -1, 1);
}

/**
 * Applies the (modestly-weighted) preference signal to a base score, clamped
 * back into the valid (0,1) score range. With `signal === 0` (the
 * below-threshold no-op) this returns `baseScore` unchanged — bit-for-bit, so
 * today's sub-threshold profiles score identically to before this task.
 */
export function applyPreferenceSignal(baseScore: number, signal: number): number {
  return clamp(baseScore + PREFERENCE_SIGNAL_WEIGHT * signal, 0, 1);
}

/**
 * Honest, non-specific phrasing for a meaningful preference lean, or `null`
 * when the signal is too small to be worth mentioning (issue #40 EC-4: a
 * similarity feature earns "similar a lo que ya has aceptado", never a
 * fabricated specific-number claim). Deliberately vaguer than the structured
 * feature phrases because a centroid-similarity IS a vaguer statement.
 */
export function preferenceClause(signal: number): string | null {
  if (Math.abs(signal) < PREFERENCE_MEANINGFUL_THRESHOLD) return null;
  return signal > 0
    ? "similar a propiedades que ya has valorado positivamente"
    : "parecido a propiedades que has descartado antes";
}

export interface LatestFeedbackState {
  property_id: number;
  feedback_type: "accept" | "reject" | "star";
}

/**
 * Current (latest-wins) accept/reject/star verdict per property for this
 * profile — the single feedback read the preference model learns from. Same
 * `DISTINCT ON (... ORDER BY created_at DESC, id DESC)` tie-break the rest of
 * the scoring pipeline uses, so "what the profile currently thinks of this
 * property" is defined identically everywhere. `property_id` is BIGINT and
 * arrives as a real JS number via the driver-level int8 parser (db-shared.ts,
 * #155) — load-bearing, or the Map lookups below silently match nothing.
 */
export async function fetchLatestFeedbackStates(
  profileId: number,
): Promise<LatestFeedbackState[]> {
  return sql<LatestFeedbackState>(
    `SELECT DISTINCT ON (property_id) property_id, feedback_type
       FROM feedback_event
      WHERE profile_id = $1 AND feedback_type = ANY($2::text[])
      ORDER BY property_id, created_at DESC, id DESC`,
    [profileId, ["accept", "reject", "star"]],
  );
}

/**
 * Turns latest feedback states + the pool's raw feature vectors + the pool
 * normalization into a preference model. Pure (no DB): both the retrain path
 * (which already has all three in hand) and `loadProfilePreferenceModel`
 * (which fetches them) funnel through here, so the two never diverge on the
 * math. A state whose property isn't in `rawByProperty` (e.g. no longer
 * matched) is skipped, not counted toward the threshold.
 */
export function buildPreferenceModelFromStates(
  states: LatestFeedbackState[],
  rawByProperty: Map<number, RawFeatureVector>,
  normalization: NormalizationStats,
): PreferenceModel | null {
  const labeled: LabeledVector[] = [];
  for (const s of states) {
    const raw = rawByProperty.get(s.property_id);
    if (!raw) continue;
    labeled.push({
      vector: normalizeVector(raw, normalization),
      label: labelForFeedback(s.feedback_type),
    });
  }
  return buildPreferenceModel(labeled);
}

/**
 * Recomputes a profile's preference model from Postgres at call time — the
 * "recompute at ranking time" entry point used by `pipeline.ts` when scoring
 * freshly-materialized candidates (retrain.ts builds it inline from data it
 * already fetched, to avoid a second round-trip). Returns `null` (no-op) for a
 * missing profile, an empty matched pool, or below-threshold/one-sided
 * feedback — every graceful-degradation case collapses to the same `null`.
 */
export async function loadProfilePreferenceModel(
  profileId: number,
): Promise<PreferenceModel | null> {
  const [inputs, states] = await Promise.all([
    fetchScoringInputs(profileId),
    fetchLatestFeedbackStates(profileId),
  ]);
  if (inputs.length === 0) return null;

  const profile = await getProfileById(profileId);
  if (!profile) return null;

  const rawByProperty = new Map(
    inputs.map((row) => [row.property_id, extractRaw(row, profile.scope)]),
  );
  const normalization = computeNormalization([...rawByProperty.values()]);
  return buildPreferenceModelFromStates(states, rawByProperty, normalization);
}
