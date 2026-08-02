/**
 * Per-profile scoring model retrain + rescore (task 3.2, #21).
 *
 * Trigger: "retrain on every new state-changing feedback event" (issue #21's
 * Technical approach #3 — simplest correct v1 behavior; revisit with
 * debouncing/batching only if this measurably becomes a bottleneck, which
 * won't happen at the data volumes this project runs at). Wired from the
 * feedback route (task 3.1) after a real (non-no-op) accept/reject/star
 * event — not from `note`/`correction`, which never change a training label
 * and would just retrain to the identical result.
 */

import { sql, withTransaction } from "@/lib/db-write";
import { getProfileById } from "@/lib/db/profiles";
import { extractRaw, fetchScoringInputs, FEATURE_NAMES } from "./features";
import { computeNormalization, normalizeVector, scoreNormalized, trainLogisticRegression } from "./model";

export interface RetrainResult {
  profileId: number;
  trained: boolean;
  trainingExampleCount: number;
  rescoredCount: number;
  reason?: string;
}

interface LatestStateRow {
  property_id: number;
  feedback_type: "accept" | "reject" | "star";
}

/**
 * The current (latest-wins) accept/reject/star state per property for this
 * profile, in one query — mirrors `lib/db/feedback.ts`'s per-property
 * `getCurrentState` tie-break (`created_at DESC, id DESC`), but for every
 * matched property at once (retraining scores the whole pool, not one
 * property at a time — same reasoning as `fetchScoringInputs`).
 */
async function fetchLatestStates(profileId: number): Promise<LatestStateRow[]> {
  // `property_id` is BIGINT — pg returns it as a string, same class of bug
  // this project has hit repeatedly (task 2.5's property_id incident).
  // Converting here, not just trusting the (wrong) `number` type below, is
  // load-bearing: without it, `labelByProperty` (string keys) would never
  // match `rawByProperty` (Number-keyed, from fetchScoringInputs) and every
  // profile would silently look like it has zero training examples.
  const rows = await sql<{ property_id: string; feedback_type: LatestStateRow["feedback_type"] }>(
    `SELECT DISTINCT ON (property_id) property_id, feedback_type
       FROM feedback_event
      WHERE profile_id = $1 AND feedback_type = ANY($2::text[])
      ORDER BY property_id, created_at DESC, id DESC`,
    [profileId, ["accept", "reject", "star"]],
  );
  return rows.map((r) => ({ property_id: Number(r.property_id), feedback_type: r.feedback_type }));
}

/**
 * Retrains the profile's model (if there's enough signal to) and rescores
 * every one of its matched candidates. Safe to call with zero or
 * one-sided feedback (all accepts, no rejects, or vice versa) — logistic
 * regression needs both classes to mean anything, so training is skipped
 * (not attempted-and-degenerate) until both exist. That "not enough
 * feedback yet" fallback ranking is issue #23's job, not this one — this
 * function just declines to overwrite existing scores with a meaningless
 * single-class fit; it doesn't invent a substitute ranking itself.
 */
export async function retrainAndRescoreProfile(profileId: number): Promise<RetrainResult> {
  const profile = await getProfileById(profileId);
  if (!profile) {
    return { profileId, trained: false, trainingExampleCount: 0, rescoredCount: 0, reason: "profile_not_found" };
  }

  const [inputs, states] = await Promise.all([fetchScoringInputs(profileId), fetchLatestStates(profileId)]);

  if (inputs.length === 0) {
    return { profileId, trained: false, trainingExampleCount: 0, rescoredCount: 0, reason: "no_matched_candidates" };
  }

  const rawByProperty = new Map(inputs.map((row) => [row.property_id, extractRaw(row, profile.scope)]));

  // Only accept/reject label the classifier (issue #21's Technical approach
  // #1's simplest-v1 choice) — a property whose latest state is 'star', or
  // that has no state feedback at all, is excluded from the training set
  // but still gets rescored below once a model exists.
  const labelByProperty = new Map<number, 0 | 1>();
  for (const row of states) {
    if (row.feedback_type === "accept") labelByProperty.set(row.property_id, 1);
    else if (row.feedback_type === "reject") labelByProperty.set(row.property_id, 0);
  }

  const trainingPropertyIds = [...labelByProperty.keys()].filter((id) => rawByProperty.has(id));
  const positiveCount = trainingPropertyIds.filter((id) => labelByProperty.get(id) === 1).length;
  const negativeCount = trainingPropertyIds.length - positiveCount;

  if (positiveCount === 0 || negativeCount === 0) {
    return {
      profileId,
      trained: false,
      trainingExampleCount: trainingPropertyIds.length,
      rescoredCount: 0,
      reason: "needs_both_classes",
    };
  }

  const rawVectors = trainingPropertyIds.map((id) => rawByProperty.get(id)!);
  const normalization = computeNormalization(rawVectors);
  const X = rawVectors.map((v) => normalizeVector(v, normalization));
  const y = trainingPropertyIds.map((id) => labelByProperty.get(id)!);

  const { weights, bias } = trainLogisticRegression(X, y);

  const coefficients = {
    featureNames: FEATURE_NAMES,
    weights,
    bias,
    normalization,
  };

  const scored = inputs.map((row) => {
    const raw = rawByProperty.get(row.property_id)!;
    const x = normalizeVector(raw, normalization);
    return { propertyId: row.property_id, score: scoreNormalized({ weights, bias }, x) };
  });

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO profile_scoring_model (profile_id, coefficients, trained_at, training_example_count)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (profile_id) DO UPDATE
         SET coefficients = EXCLUDED.coefficients,
             trained_at = EXCLUDED.trained_at,
             training_example_count = EXCLUDED.training_example_count`,
      [profileId, JSON.stringify(coefficients), trainingPropertyIds.length],
    );

    const propertyIds = scored.map((s) => s.propertyId);
    const scores = scored.map((s) => s.score);
    await client.query(
      `UPDATE profile_listing_state AS pls
         SET score = data.score, last_scored_at = NOW()
        FROM (SELECT unnest($2::bigint[]) AS property_id, unnest($3::numeric[]) AS score) AS data
       WHERE pls.profile_id = $1 AND pls.property_id = data.property_id`,
      [profileId, propertyIds, scores],
    );
  });

  return {
    profileId,
    trained: true,
    trainingExampleCount: trainingPropertyIds.length,
    rescoredCount: scored.length,
  };
}
