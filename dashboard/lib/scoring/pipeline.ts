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

/**
 * Deterministic, explainable cold-start ranking signal (issue #23 Technical
 * approach #1): price-per-m² ascending, i.e. cheapest-relative-to-this-
 * profile's-band scores highest. Reuses `price_per_m2_relative` (already
 * computed by task 3.2's feature extraction as
 * candidate-price-per-m² / profile's-target-price-per-m², where 1.0 means
 * "priced exactly at what this profile considers typical") rather than a
 * second, parallel price computation.
 *
 * `1 / (1 + v)` is monotonically decreasing in `v` and maps the whole
 * (0, ∞) range into (0, 1) — at the profile's own target price (v=1) this
 * is exactly 0.5, matching a real trained model's sigmoid-output range so
 * cold-start and trained scores are at least on comparable footing even
 * though they're not the same kind of number. `v` unknown (missing price or
 * size data, or no price band configured on the profile) scores exactly 0.5
 * too — neutral, not a guess in either direction.
 */
export function computeColdStartScore(raw: ReturnType<typeof extractRaw>): number {
  const v = raw.price_per_m2_relative;
  if (v === null || v <= 0) return 0.5;
  return 1 / (1 + v);
}

interface ScoredCandidate {
  propertyId: number;
  score: number;
  explanation: string;
}

function scoreColdStart(inputs: ScoringInputRow[], scope: Scope): ScoredCandidate[] {
  return inputs.map((row) => {
    const raw = extractRaw(row, scope);
    return { propertyId: row.property_id, score: computeColdStartScore(raw), explanation: COLD_START_EXPLANATION };
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
  // `property.id` is BIGSERIAL — callers upstream (e.g. materialize.ts's
  // `matchedIds`, sourced from a `pool.query<{ id: number }>` whose runtime
  // rows are pg-returned strings despite the `number` type annotation) can
  // and do pass stringified ids even though this function's own signature
  // says number[]. `fetchScoringInputs` already normalizes its own
  // `property_id` to a real Number; without normalizing propertyIds the
  // same way, a Set-based lookup below silently matches nothing ("179" !==
  // 179) and every candidate this function was called to score gets
  // silently skipped — reproduced directly while building this task, not
  // hypothetical. Normalize defensively here rather than trust every call
  // site to remember to convert first.
  const idSet = new Set(propertyIds.map(Number));
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
    await client.query(
      `UPDATE profile_listing_state AS pls
         SET score = data.score, rank_explanation = data.explanation, last_scored_at = NOW()
        FROM (SELECT unnest($2::bigint[]) AS property_id,
                     unnest($3::numeric[]) AS score,
                     unnest($4::text[]) AS explanation) AS data
       WHERE pls.profile_id = $1 AND pls.property_id = data.property_id`,
      [profileId, ids, scores, explanations],
    );
  });

  return { profileId, scoredCount: scored.length, usedTrainedModel: model !== null };
}
