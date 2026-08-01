import { sql } from "@/lib/db-write";
import { query } from "@/lib/db";
import type { LlmUsageProviderMeta } from "@/lib/llm-provider/types";
import { loadDashboardLlmConfig } from "@/lib/llm-provider/config";
import { getSystemConfig } from "@/lib/system-config/loader";

/**
 * Rate table: **estimated** USD per token used only for `llm_usage.estimated_cost_usd`.
 *
 * - Values follow public list pricing for the configured model (today: Claude Sonnet 4).
 * - OpenRouter may apply discounts, caching, or rounding; this app does **not** read
 *   OpenRouter’s billing API, so displayed costs are **indicative**, not invoice-accurate.
 * - Unknown models fall back to `DEFAULT_RATE` (same as Sonnet 4) with a console warning.
 * - Rows with `llm_provider = 'cli'` store **zero** estimated cost (flat-rate / unknown).
 * - Cache rates: Anthropic charges cache-write tokens at a 25% premium ($3.75/1M) and
 *   cache-read tokens at a 90% discount ($0.30/1M) vs the normal $3.00/1M input rate.
 */
const RATES: Record<string, { prompt: number; completion: number; cacheWrite: number; cacheRead: number }> = {
  "anthropic/claude-sonnet-4": {
    prompt: 3.0 / 1_000_000,
    completion: 15.0 / 1_000_000,
    cacheWrite: 3.75 / 1_000_000,
    cacheRead: 0.30 / 1_000_000,
  },
};
const DEFAULT_RATE = {
  prompt: 3.0 / 1_000_000,
  completion: 15.0 / 1_000_000,
  cacheWrite: 3.75 / 1_000_000,
  cacheRead: 0.30 / 1_000_000,
};

export class BudgetExceededError extends Error {
  constructor() {
    super("Límite diario de generación alcanzado. Reintente mañana.");
    this.name = "BudgetExceededError";
  }
}

/** Optional row fields for correlating `llm_usage` with `llm_tool_calls` (same endpoint + request id). */
export type LogUsageOptions = {
  requestId?: string | null;
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

  let estimatedCost = 0;
  if (provider === "openrouter") {
    let rate = RATES[model];
    if (!rate) {
      console.warn(`[llm-usage] Unknown model "${model}", using default rate`);
      rate = DEFAULT_RATE;
    }
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

  // CLI provider does not add OpenRouter-estimated spend; do not block on API budget.
  if (loadDashboardLlmConfig().provider === "cli") {
    return;
  }

  // TOCTOU: concurrent requests can all pass the check before any log their cost,
  // allowing overshoot by up to N×(max call cost). Acceptable for a daily soft cap.
  // CURRENT_DATE uses the PostgreSQL session timezone (default UTC); the budget
  // window resets at midnight UTC regardless of the server's local timezone.
  // Only `openrouter` rows contribute token-derived estimated spend; CLI rows use cost 0.
  try {
    const result = await query(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0)::text AS total
       FROM llm_usage
       WHERE created_at >= CURRENT_DATE
         AND llm_provider = 'openrouter'`,
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
