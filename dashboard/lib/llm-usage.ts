import { sql } from "@/lib/db-write";
import { query } from "@/lib/db";
import type { LlmUsageProviderMeta } from "@/lib/llm-provider/types";
import { getSystemConfig } from "@/lib/system-config/loader";
import { DEFAULT_LLM_RATES, DEFAULT_RATE, rateForModel, cacheAdjustedRate } from "@/lib/llm-rates";

/**
 * Rate table: **estimated** USD per token used for `llm_usage.estimated_cost_usd`
 * on `llm_provider = 'openrouter'` rows.
 *
 * - Rates come from `lib/llm-rates.ts` — the single table shared with
 *   `lib/llm-health.ts`'s salud-panel roll-up (F-5). Before that unification
 *   this file carried its own copy that had already drifted from the panel's
 *   (a per-flow OpenRouter model configured cheap could price correctly here
 *   and as Sonnet-tier there, or vice versa, invisibly). Same numbers now,
 *   one source to correct.
 * - OpenRouter may apply discounts, caching, or rounding; this app does **not** read
 *   OpenRouter’s billing API, so displayed costs are **indicative**, not invoice-accurate.
 * - Unknown models fall back to `DEFAULT_RATE` (Sonnet-tier — the conservative
 *   choice: it over-states rather than under-states a cheaper unknown model).
 * - Cache rates: Anthropic charges cache-write tokens at a 25% premium and
 *   cache-read tokens at a 90% discount vs that model's base input rate — see
 *   `cacheAdjustedRate`.
 *
 * `cli` rows do **not** use this table: the Claude CLI reports its own
 * `total_cost_usd` per call, which `logUsage` stores verbatim via
 * `LogUsageOptions.reportedCostUsd`. Before that plumbing existed every `cli`
 * row stored a hard-coded zero, which is why the usage panel showed no spend
 * for the default provider.
 */

export class BudgetExceededError extends Error {
  constructor() {
    super("Límite diario de generación alcanzado. Reintente mañana.");
    this.name = "BudgetExceededError";
  }
}

/** Optional row fields for correlating `llm_usage` with `llm_tool_calls` (same endpoint + request id). */
export type LogUsageOptions = {
  requestId?: string | null;
  /**
   * Cost reported by the provider itself for this call, in USD.
   *
   * Set by the CLI provider from `total_cost_usd` in the `claude -p` JSON
   * envelope — a real list-price figure for the call, not an estimate derived
   * from a rate table. When present it wins over the `DEFAULT_LLM_RATES`
   * estimate (`lib/llm-rates.ts`); when absent the row falls back to that
   * estimator (openrouter) or to 0 (cli, nothing reported).
   */
  reportedCostUsd?: number | null;
};

export function logUsage(
  endpoint: string,
  model: string,
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** Tokens written to Anthropic prompt cache (charged at 25% premium). NULL = not supported. */
    cache_creation_input_tokens?: number | null;
    /** Tokens read from Anthropic prompt cache (90% discount). NULL = not supported. */
    cache_read_input_tokens?: number | null;
  },
  meta?: LlmUsageProviderMeta,
  options?: LogUsageOptions,
): void {
  const provider = meta?.provider ?? "openrouter";
  const driver = meta?.driver ?? null;
  const requestId = options?.requestId ?? null;
  const cacheCreation = usage.cache_creation_input_tokens ?? null;
  const cacheRead = usage.cache_read_input_tokens ?? null;

  const reportedCost = options?.reportedCostUsd;
  let estimatedCost = 0;
  if (reportedCost !== null && reportedCost !== undefined && Number.isFinite(reportedCost) && reportedCost >= 0) {
    // Provider-reported (CLI `total_cost_usd`) — authoritative, no estimation.
    estimatedCost = reportedCost;
  } else if (provider === "openrouter") {
    let baseRate = rateForModel(DEFAULT_LLM_RATES, model);
    if (!baseRate) {
      console.warn(`[llm-usage] Unknown model "${model}", using default rate`);
      baseRate = DEFAULT_RATE;
    }
    const rate = cacheAdjustedRate(baseRate);
    // NOTE: OpenRouter normalises `prompt_tokens` to exclude cache tokens (they are
    // reported separately in `cache_creation_input_tokens` / `cache_read_input_tokens`).
    // This differs from the raw Anthropic API where `input_tokens` is an inclusive sum.
    // The formula below is correct under the OpenRouter normalisation: cache tokens are
    // billed at their specific rates and NOT again at the base prompt rate.
    estimatedCost =
      usage.prompt_tokens * rate.prompt +
      usage.completion_tokens * rate.completion +
      (cacheCreation ?? 0) * rate.cacheWrite +
      (cacheRead ?? 0) * rate.cacheRead;
  }

  void sql(
    `INSERT INTO llm_usage (
       endpoint, model, prompt_tokens, completion_tokens, total_tokens,
       estimated_cost_usd, llm_provider, llm_driver, request_id,
       cache_creation_input_tokens, cache_read_input_tokens
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      endpoint,
      model,
      usage.prompt_tokens,
      usage.completion_tokens,
      usage.total_tokens,
      estimatedCost.toFixed(6),
      provider,
      driver,
      requestId,
      cacheCreation,
      cacheRead,
    ],
  ).catch((err) => {
    console.error("[llm-usage] Failed to log usage:", err);
  });
}

export async function checkDailyBudget(): Promise<void> {
  // Read the budget from the central config loader (env > config.yaml > default).
  // Uses the cached getSystemConfig() for production performance; tests that stub env
  // vars should call resetDashboardLlmConfigCache() (which also clears the system-config
  // cache) in their afterEach to ensure fresh reads.
  let budgetStr: string | null = null;
  try {
    const cfg = getSystemConfig();
    const raw = cfg["dashboard.llm_daily_budget_usd"]?.value;
    budgetStr = raw !== null && raw !== undefined ? String(raw).trim() : null;
  } catch {
    // Loader unavailable (e.g., schema file missing) — fall back to process.env
    budgetStr = process.env.LLM_DAILY_BUDGET_USD ?? null;
  }

  if (!budgetStr || budgetStr === "0" || budgetStr === "") {
    return;
  }

  const limit = parseFloat(budgetStr);
  if (isNaN(limit) || limit <= 0) {
    return;
  }

  // The CLI provider used to be exempted here ("CLI rows always cost 0, so a
  // sum over them can never trip the cap"). That exemption is gone: `cli` rows
  // now carry the CLI's own `total_cost_usd`, so the daily cap finally applies
  // to the DEFAULT provider — which is the whole point of having a cap. Rows
  // written before this change store 0 and simply contribute nothing.
  //
  // TOCTOU: concurrent requests can all pass the check before any log their cost,
  // allowing overshoot by up to N×(max call cost). Acceptable for a daily soft cap.
  // CURRENT_DATE uses the PostgreSQL session timezone (default UTC); the budget
  // window resets at midnight UTC regardless of the server's local timezone.
  try {
    const result = await query(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0)::text AS total
       FROM llm_usage
       WHERE created_at >= CURRENT_DATE`,
    );
    const total = parseFloat((result.rows[0]?.[0] as string | undefined) ?? "0");
    if (total >= limit) {
      throw new BudgetExceededError();
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      throw err;
    }
    // Fail-open: if the query fails, allow the call rather than blocking
    console.error("[llm-usage] Budget check failed, allowing request:", err);
  }
}
