/**
 * Single canonical LLM price table (F-5, docs/roadmap/llm-batching-plan.md Phase 0).
 *
 * Before this file, `lib/llm-usage.ts` (estimates `llm_usage.estimated_cost_usd`
 * for openrouter rows) and `lib/llm-health.ts` (rolls up € for the `/etl/salud`
 * panel) each hard-coded their own model → price map. They had already
 * drifted — a per-flow OpenRouter model configured cheap
 * (`dashboard.llm_model_openrouter_<flow>`) could price as Sonnet-tier in one
 * consumer and correctly in the other, with no signal that they disagreed.
 * This is the ONE table both import; a rate correction lands here once.
 *
 * Values are € per 1M tokens, treated at USD list-price parity — same
 * currency note as before (`llm-health.ts`'s roll-up labels its output €;
 * `llm-usage.ts` stores `estimated_cost_usd` in USD; neither file converts
 * between them, they always didn't). Unifying the SOURCE table does not
 * change either consumer's currency semantics — see each file for its own
 * behaviour, which is deliberately left untouched by this unification.
 */

export interface LlmModelRate {
  /** € (≈ USD, see file header) per 1M input/prompt tokens. */
  in_eur_per_mtok: number;
  /** € (≈ USD, see file header) per 1M output/completion tokens. */
  out_eur_per_mtok: number;
}

/** model-id → rate. Keys match `llm_usage.model` (a leading `openrouter/` is stripped before lookup, see `normalizeModel`). */
export type LlmRateTable = Record<string, LlmModelRate>;

/**
 * Baked-in default rates (per 1M tokens). Rough public list prices — the
 * point is an order-of-magnitude cost signal for the owner, not an invoice.
 * `lib/llm-health.ts`'s `parseRateTable` lets an operator override / extend
 * this per deployment via `dashboard.llm_cost_rates_eur` (a JSON object of the
 * same shape, merged on top of these); `llm-usage.ts` does not currently read
 * that override — see its own file header.
 */
export const DEFAULT_LLM_RATES: LlmRateTable = {
  "anthropic/claude-sonnet-4": { in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 },
  "anthropic/claude-sonnet-4-5": { in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 },
  "anthropic/claude-3-5-sonnet": { in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 },
  "anthropic/claude-3-7-sonnet": { in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 },
  "anthropic/claude-haiku-4-5": { in_eur_per_mtok: 0.8, out_eur_per_mtok: 4.0 },
  // OpenRouter spells Haiku 4.5 with a DOT, and that is now the default model
  // (D-103) — without this key the default lands in `unpriced_models` at €0.
  "anthropic/claude-haiku-4.5": { in_eur_per_mtok: 0.8, out_eur_per_mtok: 4.0 },
  "anthropic/claude-3-5-haiku": { in_eur_per_mtok: 0.8, out_eur_per_mtok: 4.0 },
  "anthropic/claude-sonnet-4.6": { in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 },
  "anthropic/claude-sonnet-5": { in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 },
  "anthropic/claude-opus-4": { in_eur_per_mtok: 15.0, out_eur_per_mtok: 75.0 },
  "anthropic/claude-opus-4.8": { in_eur_per_mtok: 5.0, out_eur_per_mtok: 25.0 },
  "anthropic/claude-opus-5": { in_eur_per_mtok: 5.0, out_eur_per_mtok: 25.0 },
  "openai/gpt-4o": { in_eur_per_mtok: 2.5, out_eur_per_mtok: 10.0 },
  "openai/gpt-4o-mini": { in_eur_per_mtok: 0.15, out_eur_per_mtok: 0.6 },
};

/**
 * Fallback rate for a model missing from the table — Sonnet-tier: the
 * conservative choice, since it over-states rather than under-states an
 * unknown model's cost. Used by `llm-usage.ts`; `llm-health.ts`'s roll-up
 * instead surfaces an unpriced model explicitly (`unpriced_models`) rather
 * than silently substituting a rate — see `rollUpCosts`.
 */
export const DEFAULT_RATE: LlmModelRate = { in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 };

/** Drop a leading transport prefix (`openrouter/`) so `model` keys line up. */
export function normalizeModel(model: string): string {
  return (model ?? "").trim().replace(/^openrouter\//i, "");
}

/** The rate for a model, or null when the model isn't in the table (unpriced). */
export function rateForModel(rates: LlmRateTable, model: string): LlmModelRate | null {
  return rates[normalizeModel(model)] ?? null;
}

/**
 * Derive Anthropic's cache-write/cache-read rates from a base in/out rate.
 * Anthropic charges cache-write tokens at a 25% premium and cache-read tokens
 * at a 90% discount vs. the model's base input rate — `llm-usage.ts`'s own
 * pre-existing semantics, unchanged by this unification; only the source of
 * `in_eur_per_mtok`/`out_eur_per_mtok` moved into the shared table.
 */
export function cacheAdjustedRate(rate: LlmModelRate): {
  prompt: number;
  completion: number;
  cacheWrite: number;
  cacheRead: number;
} {
  return {
    prompt: rate.in_eur_per_mtok / 1_000_000,
    completion: rate.out_eur_per_mtok / 1_000_000,
    cacheWrite: (rate.in_eur_per_mtok * 1.25) / 1_000_000,
    cacheRead: (rate.in_eur_per_mtok * 0.1) / 1_000_000,
  };
}
