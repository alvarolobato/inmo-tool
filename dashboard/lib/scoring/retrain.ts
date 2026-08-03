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
 *
 * "Won't happen at these volumes" and the two known gaps below are stated
 * assumptions, not measurements (Opus review of PR #91, item 4) — revisit if
 * profile pool sizes or feedback rates grow past what a synchronous
 * ~1000-iteration gradient descent over the whole matched pool can absorb
 * inside a single request.
 *
 * Known gap (issue #21 §4) — partially addressed, not fully closed: a
 * candidate materialized *after* a profile's most recent feedback event used
 * to have no score at all until the *next* feedback event triggered a fresh
 * retrain-and-rescore-everything pass here. Task 3.4 (#23)'s
 * `pipeline.ts#scoreNewCandidates` now scores such a candidate immediately at
 * materialization time (task 2.4's code path), using whatever this module's
 * last retrain left behind (a trained model if one exists and clears
 * {@link MIN_TRAINING_EXAMPLES}, cold-start ordering otherwise) — so the gap
 * is closed for candidates that arrive after `scoreNewCandidates` was wired
 * in. It does NOT retrain; only a new feedback event retrains here.
 */

import { sql, withTransaction } from "@/lib/db-write";
import { getProfileById } from "@/lib/db/profiles";
import { COLD_START_EXPLANATION, explainScore } from "./explain";
import { extractRaw, fetchScoringInputs, FEATURE_NAMES } from "./features";
import { computeNormalization, normalizeVector, scoreNormalized, trainLogisticRegression } from "./model";
import { computeColdStartScore, MIN_TRAINING_EXAMPLES, poolMedianPricePerM2, pricePerM2 } from "./pipeline";

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
  // `property_id` is BIGINT — arrives as a real JS number via the
  // driver-level int8 type parser (db-shared.ts, #155), which is
  // load-bearing here: without it, `labelByProperty` (string keys) would
  // never match `rawByProperty` (Number-keyed, from fetchScoringInputs) and
  // every profile would silently look like it has zero training examples —
  // this project has hit that exact class of bug repeatedly (task 2.5's
  // property_id incident among others).
  const rows = await sql<LatestStateRow>(
    `SELECT DISTINCT ON (property_id) property_id, feedback_type
       FROM feedback_event
      WHERE profile_id = $1 AND feedback_type = ANY($2::text[])
      ORDER BY property_id, created_at DESC, id DESC`,
    [profileId, ["accept", "reject", "star"]],
  );
  return rows;
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
  // "star" is a stronger positive than "accept" per issue #21 (task 3.1's
  // feedback toggle makes star *replace* accept as the current state) — it
  // must still label the classifier as positive, or accepting a property
  // and later starring it (a natural upgrade, not a retraction) erases the
  // only positive example and permanently wedges training at
  // "needs_both_classes" (Opus review of PR #91, item 2).
  const labelByProperty = new Map<number, 0 | 1>();
  for (const row of states) {
    if (row.feedback_type === "accept" || row.feedback_type === "star") labelByProperty.set(row.property_id, 1);
    else if (row.feedback_type === "reject") labelByProperty.set(row.property_id, 0);
  }

  const trainingPropertyIds = [...labelByProperty.keys()].filter((id) => rawByProperty.has(id));
  const positiveCount = trainingPropertyIds.filter((id) => labelByProperty.get(id) === 1).length;
  const negativeCount = trainingPropertyIds.length - positiveCount;

  // Task 3.4 (#23): below-threshold is its own cold-start reason, distinct
  // from one-sided (0 of one class). Both classes can be present — e.g. one
  // accept, one reject — and still be far too little signal to fit 8
  // features against; L2 regularization keeps that fit non-degenerate (no
  // coefficient blowup) but doesn't make 2 points a *good* fit. See
  // pipeline.ts's MIN_TRAINING_EXAMPLES for the threshold derivation.
  const belowThreshold = trainingPropertyIds.length < MIN_TRAINING_EXAMPLES;

  if (positiveCount === 0 || negativeCount === 0 || belowThreshold) {
    // No usable trained model yet. Rather than leave every unscored
    // candidate at score=NULL (issue #23's EC-1: a fresh profile must show
    // a non-empty, sensibly-ordered list, not a blank one), compute a
    // deterministic cold-start score (price-per-m² ascending, see
    // pipeline.ts's computeColdStartScore) for the whole matched pool and
    // write it alongside the honest "not personalized yet" explanation.
    // `score` is only ever set here for rows that are still NULL — a
    // profile that trained once and later goes one-sided (or drops below
    // threshold some other way, e.g. a rejected acceptance being reverted)
    // must not have this write clobber a still-valid score/explanation pair
    // from that prior successful run (Opus review of PR #92, item 3).
    // Same pool-relative fallback as pipeline.ts's scoreColdStart — a
    // profile with no price band configured must not have every candidate
    // tie at 0.5 (Fable review of PR #93). Computed once for the whole
    // pool, not per-row.
    const medianPricePerM2 = poolMedianPricePerM2(inputs);
    const coldStartScored = inputs.map((row) => ({
      propertyId: row.property_id,
      score: computeColdStartScore(rawByProperty.get(row.property_id)!, {
        pricePerM2: pricePerM2(row),
        poolMedianPricePerM2: medianPricePerM2,
      }),
    }));

    await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`scoring_retrain:${profileId}`]);
      const ids = coldStartScored.map((s) => s.propertyId);
      const scores = coldStartScored.map((s) => s.score);
      await client.query(
        `UPDATE profile_listing_state AS pls
           SET score = data.score, rank_explanation = $2, score_kind = 'cold_start', last_scored_at = NOW()
          FROM (SELECT unnest($3::bigint[]) AS property_id,
                       unnest($4::numeric[]) AS score) AS data
         WHERE pls.profile_id = $1 AND pls.property_id = data.property_id
           AND pls.matched = true AND pls.score IS NULL`,
        [profileId, COLD_START_EXPLANATION, ids, scores],
      );
    });

    return {
      profileId,
      trained: false,
      trainingExampleCount: trainingPropertyIds.length,
      rescoredCount: 0,
      reason: belowThreshold && positiveCount > 0 && negativeCount > 0 ? "below_training_threshold" : "needs_both_classes",
    };
  }

  // Normalization stats come from the *whole matched pool* (every candidate
  // this model will ever score), not just the handful of labeled training
  // rows — a labeled subset of ~5-10 properties has a mean/std that doesn't
  // represent the pool's real distribution, and scoring an unlabeled
  // candidate against those skewed stats pushes it into a saturated region
  // of the sigmoid, producing a degenerate ranking for exactly the
  // candidates this model exists to rank (Opus review of PR #91, item 1).
  // Missing values are imputed to these same pool-wide stats consistently
  // at both training and scoring time via `normalizeVector`.
  const allRawVectors = inputs.map((row) => rawByProperty.get(row.property_id)!);
  const normalization = computeNormalization(allRawVectors);

  const rawVectors = trainingPropertyIds.map((id) => rawByProperty.get(id)!);
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
    return {
      propertyId: row.property_id,
      score: scoreNormalized({ weights, bias }, x),
      // Task 3.3 (#22): grounded in this same candidate's real feature
      // vector and this same freshly-trained model — never stale relative
      // to the score it's explaining, since both are computed together here.
      explanation: explainScore(raw, { weights, bias, normalization }),
    };
  });

  // Advisory lock, same pattern/reasoning as `feedback.ts`'s per-property
  // lock (PR #89 review): two near-simultaneous feedback events for this
  // profile (rapid clicks, a retry) could otherwise both reach this
  // transaction and interleave, and the unordered bulk `UPDATE ... FROM
  // unnest(...)` below can deadlock under real concurrent access (Opus
  // review of PR #91, item 4). Locking only the write transaction (not the
  // read+train phase above) doesn't prevent two concurrent calls from
  // redundantly re-reading/re-training in parallel — that's wasted work,
  // not a correctness bug, since whichever commits last simply wins with an
  // equally-valid model; the lock's job here is specifically to stop the
  // transactional writes from interleaving or deadlocking.
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`scoring_retrain:${profileId}`]);

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
    const explanations = scored.map((s) => s.explanation);
    await client.query(
      `UPDATE profile_listing_state AS pls
         SET score = data.score, rank_explanation = data.explanation, score_kind = 'trained', last_scored_at = NOW()
        FROM (SELECT unnest($2::bigint[]) AS property_id,
                     unnest($3::numeric[]) AS score,
                     unnest($4::text[]) AS explanation) AS data
       WHERE pls.profile_id = $1 AND pls.property_id = data.property_id`,
      [profileId, propertyIds, scores, explanations],
    );
  });

  return {
    profileId,
    trained: true,
    trainingExampleCount: trainingPropertyIds.length,
    rescoredCount: scored.length,
  };
}
