/**
 * L2-regularized logistic regression, hand-rolled (task 3.2, #21).
 *
 * Issue #21 explicitly prefers this over standing up a Python training
 * service: a handful of features and a few dozen-hundred examples per
 * profile doesn't need one. L2 regularization is not optional here — with
 * as few as 5-10 labeled examples against up to 8 features, an
 * unregularized fit commonly hits near-perfect separation (coefficients
 * blow up chasing noise), which would then feed task 3.3's explanation and
 * confidently narrate that noise as a real pattern.
 *
 * `L2_LAMBDA` is a fixed, documented constant rather than a per-profile
 * tunable — issue #21 explicitly calls a cross-validated per-profile
 * strength overkill at this data volume. 1.0 is chosen for z-scored
 * (roughly unit-variance) features: strong enough to keep coefficients in a
 * sane range on tiny separable datasets (see the "coefficient blowup" test)
 * without needing per-profile tuning nobody would actually do at v1 scale.
 */

import { FEATURE_NAMES, type RawFeatureVector } from "./features";

export const L2_LAMBDA = 1.0;
const LEARNING_RATE = 0.5;
const ITERATIONS = 1000;

export interface NormalizationStats {
  mean: number[];
  std: number[];
}

export interface TrainedModel {
  featureNames: readonly string[];
  weights: number[];
  bias: number;
  normalization: NormalizationStats;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Mean/std per feature across a candidate pool, computed over non-null
 * values only (a feature that's missing for some candidates shouldn't have
 * its mean dragged toward zero by treating "unknown" as "zero"). A
 * zero-variance feature (every known value identical, or only one known
 * value) gets std=1 rather than 0, to avoid a divide-by-zero turning a flat
 * feature into `NaN` for every candidate.
 */
export function computeNormalization(rawVectors: RawFeatureVector[]): NormalizationStats {
  const mean: number[] = [];
  const std: number[] = [];

  for (const name of FEATURE_NAMES) {
    const values = rawVectors.map((v) => v[name]).filter((v): v is number => v !== null);
    if (values.length === 0) {
      mean.push(0);
      std.push(1);
      continue;
    }
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
    mean.push(m);
    std.push(variance > 0 ? Math.sqrt(variance) : 1);
  }

  return { mean, std };
}

/**
 * A raw vector into z-scored numbers, in `FEATURE_NAMES` order. A missing
 * (`null`) raw value normalizes to exactly 0 — the z-score of the pool's own
 * mean — which is the standard "impute at the mean" treatment: the feature
 * contributes no signal for that candidate, rather than dropping the
 * candidate or fabricating a value.
 */
export function normalizeVector(raw: RawFeatureVector, stats: NormalizationStats): number[] {
  return FEATURE_NAMES.map((name, i) => {
    const value = raw[name];
    if (value === null) return 0;
    return (value - stats.mean[i]) / stats.std[i];
  });
}

/**
 * Batch gradient descent for L2-regularized logistic regression.
 * `X` rows must already be normalized (see {@link normalizeVector}) —
 * z-scoring first is what makes a single fixed learning rate/iteration
 * count and a single fixed lambda work across profiles with very
 * differently-scaled raw features.
 */
export function trainLogisticRegression(
  X: number[][],
  y: number[],
  lambda: number = L2_LAMBDA,
): { weights: number[]; bias: number } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  let weights = new Array<number>(d).fill(0);
  let bias = 0;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const gradW = new Array<number>(d).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const z = dot(weights, X[i]) + bias;
      const p = sigmoid(z);
      const error = p - y[i];
      for (let j = 0; j < d; j++) {
        gradW[j] += error * X[i][j];
      }
      gradB += error;
    }

    const newWeights = weights.map((w, j) => w - (LEARNING_RATE * (gradW[j] / n + (lambda / n) * w)));
    bias -= LEARNING_RATE * (gradB / n);
    weights = newWeights;
  }

  return { weights, bias };
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** `score = sigmoid(weights . normalized_features + bias)` — issue #21's Technical approach #4. */
export function scoreNormalized(model: Pick<TrainedModel, "weights" | "bias">, x: number[]): number {
  return sigmoid(dot(model.weights, x) + model.bias);
}
