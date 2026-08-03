/**
 * Cold-start fallback + scoring trigger wiring (task 3.4, #23).
 *
 * Owns two things tasks 3.2/3.3 deliberately left open:
 *
 * 1. A minimum-training-example threshold that scales with feature count.
 *    `retrain.ts` (task 3.2) already refuses to train on a single-class
 *    feedback set (0 positives or 0 negatives), but nothing stopped it from
 *    training on e.g. 2 examples (1 accept, 1 reject) against up to 8
 *    features — a fit that L2 regularization keeps non-degenerate (no
 *    coefficient blowup) but that isn't a *good* fit; 2 points can't
 *    meaningfully separate an 8-dimensional space. `MIN_TRAINING_EXAMPLES`
 *    (4x feature count, see the constant below) makes "not enough signal
 *    yet" its own explicit state, distinct from "literally one-sided."
 *
 * 2. Scoring candidates that arrive *between* feedback-triggered retrains.
 *    `retrain.ts`'s own docstring names this gap: a candidate materialized
 *    (task 2.4) after a profile's last retrain has no score at all until
 *    the *next* feedback event retrains-and-rescores everything. This
 *    module's {@link scoreNewCandidates} is the fix — called from
 *    `materialize.ts` right after new `matched=true` rows land, it scores
 *    just those rows using whatever the profile's current state is (a
 *    valid trained model if one exists and clears the threshold, cold-start
 *    ordering otherwise) without retraining the model itself — retraining
 *    only ever happens in response to new feedback (task 3.2's job).
 */

import { sql, withTransaction } from "@/lib/db-write";
import { getProfileById } from "@/lib/db/profiles";
import { COLD_START_EXPLANATION, explainScore } from "./explain";
import { extractRaw, fetchScoringInputs, FEATURE_NAMES, type ScoringInputRow } from "./features";
import { normalizeVector, scoreNormalized, type NormalizationStats } from "./model";
import type { Scope } from "@/lib/profiles-schema";

/**
 * 4x the active feature count (issue #23's "roughly 3-5x" range, picked
 * mid-range rather than tuned — nobody has real usage data yet to tune
 * against). At the current 8-feature model this is 32 labeled examples
 * before a real fit is used instead of cold-start ordering. Recomputed from
 * `FEATURE_NAMES.length` rather than hardcoded so it tracks automatically
 * if a future task changes the feature count (e.g. task 5.4 replacing the
 * two always-null placeholder features with real ones doesn't change the
 * count, but a genuinely new feature would).
 */
export const MIN_TRAINING_EXAMPLES_MULTIPLIER = 4;
export const MIN_TRAINING_EXAMPLES = MIN_TRAINING_EXAMPLES_MULTIPLIER * FEATURE_NAMES.length;

interface StoredCoefficients {
  featureNames: readonly string[];
  weights: number[];
  bias: number;
  normalization: NormalizationStats;
}

interface ScoringModelRow {
  coefficients: StoredCoefficients;
  training_example_count: number;
}

/**
 * The profile's current trained model, only if it both exists and clears
 * {@link MIN_TRAINING_EXAMPLES} — a model trained before the threshold was
 * introduced (or before this profile crossed it) must not be used to score,
 * even though `retrain.ts` may have written a row for it under the older,
 * looser "both classes present" rule.
 */
async function fetchUsableModel(profileId: number): Promise<StoredCoefficients | null> {
  const rows = await sql<ScoringModelRow>(
    `SELECT coefficients, training_example_count FROM profile_scoring_model WHERE profile_id = $1`,
    [profileId],
  );
  const row = rows[0];
  if (!row || row.training_example_count < MIN_TRAINING_EXAMPLES) return null;
  return row.coefficients;
}

/** `min_price / m2_built` for one candidate, or `null` when either is unknown/non-positive. */
export function pricePerM2(row: { min_price: number | null; m2_built: number | null }): number | null {
  if (row.min_price === null || row.m2_built === null || row.m2_built <= 0) return null;
  return row.min_price / row.m2_built;
}

/**
 * Median price-per-m² across a candidate pool — the reference point
 * {@link computeColdStartScore} falls back to when a profile has no price
 * band configured (see that function's docstring for why this matters).
 * Median, not mean, so a single outlier listing (a misfitted mansion in an
 * apartment-focused pool) doesn't skew every other candidate's cold-start
 * score.
 */
export function poolMedianPricePerM2(inputs: ScoringInputRow[]): number | null {
  const values = inputs
    .map(pricePerM2)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
}

/**
 * Deterministic, explainable cold-start ranking signal (issue #23 Technical
 * approach #1): price-per-m² ascending, i.e. cheapest scores highest.
 * Reuses `price_per_m2_relative` (already computed by task 3.2's feature
 * extraction as candidate-price-per-m² / profile's-target-price-per-m²,
 * where 1.0 means "priced exactly at what this profile considers typical")
 * as the primary signal, since it's relative to what *this profile* actually
 * wants, not just relative to other candidates.
 *
 * `1 / (1 + v)` is monotonically decreasing in `v` and maps the whole
 * (0, ∞) range into (0, 1) — at the profile's own target price (v=1) this
 * is exactly 0.5, matching a real trained model's sigmoid-output range so
 * cold-start and trained scores are at least on comparable footing even
 * though they're not the same kind of number.
 *
 * `price_per_m2_relative` is `null` in two genuinely different situations
 * that used to collapse into the same "return 0.5 for everyone" behavior
 * (found in Fable's review of PR #93: a profile with no price band scored
 * every single candidate exactly 0.5, producing a fully arbitrary/tied
 * cold-start order — the ordering this function exists to provide):
 *
 * 1. The candidate's own price/size data is missing — nothing to rank this
 *    specific candidate by. Still returns 0.5 (neutral, no fallback data
 *    exists).
 * 2. The *profile* has no price band configured at all — common, not an
 *    edge case (issue #17 didn't make a price band mandatory) — but the
 *    candidate's own price/size ARE known. Falls back to the candidate's
 *    price-per-m² relative to the whole matched pool's median
 *    ({@link poolMedianPricePerM2}), so cold-start ordering still reflects
 *    "cheaper than comparable options in this pool" instead of a tie,
 *    passed in by the caller since computing it requires the whole pool.
 */
export function computeColdStartScore(
  raw: ReturnType<typeof extractRaw>,
  poolFallback?: { pricePerM2: number | null; poolMedianPricePerM2: number | null },
): number {
  const v = raw.price_per_m2_relative;
  if (v !== null && v > 0) return 1 / (1 + v);

  if (
    poolFallback &&
    poolFallback.pricePerM2 !== null &&
    poolFallback.pricePerM2 > 0 &&
    poolFallback.poolMedianPricePerM2 !== null &&
    poolFallback.poolMedianPricePerM2 > 0
  ) {
    return 1 / (1 + poolFallback.pricePerM2 / poolFallback.poolMedianPricePerM2);
  }

  return 0.5;
}

interface ScoredCandidate {
  propertyId: number;
  score: number;
  explanation: string;
}

function scoreColdStart(inputs: ScoringInputRow[], scope: Scope): ScoredCandidate[] {
  const medianPricePerM2 = poolMedianPricePerM2(inputs);
  return inputs.map((row) => {
    const raw = extractRaw(row, scope);
    const score = computeColdStartScore(raw, {
      pricePerM2: pricePerM2(row),
      poolMedianPricePerM2: medianPricePerM2,
    });
    return { propertyId: row.property_id, score, explanation: COLD_START_EXPLANATION };
  });
}

function scoreWithModel(inputs: ScoringInputRow[], scope: Scope, model: StoredCoefficients): ScoredCandidate[] {
  return inputs.map((row) => {
    const raw = extractRaw(row, scope);
    const x = normalizeVector(raw, model.normalization);
    return {
      propertyId: row.property_id,
      score: scoreNormalized(model, x),
      explanation: explainScore(raw, model),
    };
  });
}

export interface ScoreNewCandidatesResult {
  profileId: number;
  scoredCount: number;
  usedTrainedModel: boolean;
}

/**
 * Scores exactly the given `propertyIds` for `profileId` — never retrains,
 * never touches any other property's existing score. Called from
 * `materialize.ts` right after new `matched=true` rows are inserted, so a
 * newly-arrived candidate gets *some* score immediately (cold-start if no
 * usable trained model yet, the real model's score otherwise) instead of
 * sitting at `score IS NULL` until the profile's next feedback event.
 *
 * Deliberately does not write when `propertyIds` is empty or the profile
 * doesn't exist/is archived — a no-op, not an error, since `materialize.ts`
 * calls this unconditionally after every materialization run.
 */
export async function scoreNewCandidates(
  profileId: number,
  propertyIds: number[],
): Promise<ScoreNewCandidatesResult | null> {
  if (propertyIds.length === 0) return null;

  const profile = await getProfileById(profileId);
  if (!profile || profile.archived_at !== null) return null;

  const allInputs = await fetchScoringInputs(profileId);
  // `property.id` is BIGSERIAL. Before #155's driver-level int8 type parser
  // (db-shared.ts), callers upstream (e.g. materialize.ts's `matchedIds`,
  // sourced from raw pg rows) could pass stringified ids even though this
  // function's signature says number[], and the Set-based lookup below
  // would silently match nothing ("179" !== 179) — every candidate this
  // function was called to score got silently skipped (reproduced directly
  // while building this task, not hypothetical). The parser now guarantees
  // every bigint column — including materialize.ts's matchedIds and
  // fetchScoringInputs's property_id — arrives as a real number, so no
  // per-site normalization is needed here anymore.
  const idSet = new Set(propertyIds);
  const inputs = allInputs.filter((row) => idSet.has(row.property_id));
  if (inputs.length === 0) return null;

  const model = await fetchUsableModel(profileId);
  const scored = model ? scoreWithModel(inputs, profile.scope, model) : scoreColdStart(inputs, profile.scope);

  await withTransaction(async (client) => {
    // Same per-profile advisory lock as `retrain.ts`'s write transaction —
    // a materialize run and a feedback-triggered retrain for the same
    // profile could otherwise interleave their writes.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`scoring_retrain:${profileId}`]);

    const ids = scored.map((s) => s.propertyId);
    const scores = scored.map((s) => s.score);
    const explanations = scored.map((s) => s.explanation);
    // materializeProfile passes *every* currently-matched id, not just ones
    // newly matched this run (deliberate — see its own comment), so a
    // cold-start write here can and does land on a property that already
    // has a valid score from a past successful training run (e.g. the
    // profile has since dropped back below MIN_TRAINING_EXAMPLES). retrain.ts
    // already established the rule for exactly this situation (Opus review
    // of PR #92, item 3): a cold-start write must never clobber a still-valid
    // prior score/explanation pair, to avoid showing a real number next to
    // "not personalized yet". This write path was missing that same guard
    // (Fable review of PR #93) — apply it here too, but only for cold-start
    // writes; a real trained-model score is always current and correct, and
    // must overwrite unconditionally (that's the whole point of rescoring).
    const coldStartGuard = model === null ? "AND pls.score IS NULL" : "";
    const scoreKind = model === null ? "cold_start" : "trained";
    await client.query(
      `UPDATE profile_listing_state AS pls
         SET score = data.score, rank_explanation = data.explanation, score_kind = $5, last_scored_at = NOW()
        FROM (SELECT unnest($2::bigint[]) AS property_id,
                     unnest($3::numeric[]) AS score,
                     unnest($4::text[]) AS explanation) AS data
       WHERE pls.profile_id = $1 AND pls.property_id = data.property_id
         ${coldStartGuard}`,
      [profileId, ids, scores, explanations, scoreKind],
    );
  });

  return { profileId, scoredCount: scored.length, usedTrainedModel: model !== null };
}
