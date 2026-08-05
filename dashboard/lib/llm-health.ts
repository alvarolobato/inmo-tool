/**
 * LLM cost / usage visibility — shared pure helpers (issue #324).
 *
 * Client-safe: no `pg` import, so both the "Salud de datos" page (client
 * component) and the API route (server) can share the types and the cost /
 * projection arithmetic. DB access lives in lib/db/llm-health.ts (server-only),
 * the same split as lib/data-health.ts ↔ lib/db/data-health.ts.
 *
 * What this surface answers, cheaply, from the tracking tables the platform
 * already writes (`llm_usage`, `llm_errors`, `ai_assessment`):
 *   - How many LLM calls today / last 7d, by flow and by provider.
 *   - Tokens + an ESTIMATED € cost via a small, configurable per-model rate
 *     table. CLI-provider rows cost €0 (they run on a flat subscription).
 *   - Assessment coverage/backlog: how many eligible properties still lack a
 *     current-prompt-version verdict, and a projected time / € to clear it at
 *     the current batch rate.
 *   - The scheduler throttle (batch size / interval / kill switch) so the rate
 *     is visible next to the backlog it drains.
 *   - Recent LLM error / rate-limit counts.
 *
 * The one judgement call this whole surface turns on: cost is an *estimate*.
 * `llm_usage` logs tokens per model+provider; € is tokens × a rate the owner
 * controls, never a billed number. A CLI-provider row is €0 by construction
 * (subscription), not "unknown" — `isCliProvider` encodes exactly that so the
 * UI can label it rather than pretend it's free-because-untracked.
 */

// ─── Provider vocabulary ─────────────────────────────────────────────────────

/** The flat-subscription transport: its rows are €0, not "cost unknown". */
export const CLI_PROVIDER = "cli";

/** True when a usage/provider row was served by the local CLI (flat cost). */
export function isCliProvider(provider: string | null | undefined): boolean {
  return (provider ?? "").trim().toLowerCase() === CLI_PROVIDER;
}

// ─── Rate table ──────────────────────────────────────────────────────────────

/** Per-model price, in € per 1,000,000 tokens, split by direction. */
export interface LlmModelRate {
  /** € per 1M input (prompt) tokens. */
  in_eur_per_mtok: number;
  /** € per 1M output (completion) tokens. */
  out_eur_per_mtok: number;
}

/** model-id → rate. Keys match `llm_usage.model` (a leading `openrouter/` is stripped before lookup). */
export type LlmRateTable = Record<string, LlmModelRate>;

/**
 * Baked-in default € rates (per 1M tokens). Rough public list prices — the
 * point is an order-of-magnitude cost signal for the owner, not an invoice.
 * Override / extend per deployment via `dashboard.llm_cost_rates_eur` (a JSON
 * object of the same shape, merged on top of these).
 */
export const DEFAULT_LLM_RATES: LlmRateTable = {
  "anthropic/claude-sonnet-4": { in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 },
  "anthropic/claude-sonnet-4-5": { in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 },
  "anthropic/claude-3-5-sonnet": { in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 },
  "anthropic/claude-3-7-sonnet": { in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 },
  "anthropic/claude-haiku-4-5": { in_eur_per_mtok: 0.8, out_eur_per_mtok: 4.0 },
  "anthropic/claude-3-5-haiku": { in_eur_per_mtok: 0.8, out_eur_per_mtok: 4.0 },
  "anthropic/claude-opus-4": { in_eur_per_mtok: 15.0, out_eur_per_mtok: 75.0 },
  "openai/gpt-4o": { in_eur_per_mtok: 2.5, out_eur_per_mtok: 10.0 },
  "openai/gpt-4o-mini": { in_eur_per_mtok: 0.15, out_eur_per_mtok: 0.6 },
};

/**
 * Parse the operator's rate-table override (a JSON object string) and merge it
 * on top of `DEFAULT_LLM_RATES`. Tolerant: a null/empty/malformed override, or
 * a well-formed object with junk entries, degrades to the defaults rather than
 * throwing — a cost panel must never take the page down over bad config.
 */
export function parseRateTable(
  override: string | null | undefined,
  base: LlmRateTable = DEFAULT_LLM_RATES,
): LlmRateTable {
  const merged: LlmRateTable = { ...base };
  if (!override || !override.trim()) return merged;
  let parsed: unknown;
  try {
    parsed = JSON.parse(override);
  } catch {
    return merged;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return merged;
  for (const [model, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const inRate = Number(r.in_eur_per_mtok);
    const outRate = Number(r.out_eur_per_mtok);
    if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) continue;
    if (inRate < 0 || outRate < 0) continue;
    merged[normalizeModel(model)] = {
      in_eur_per_mtok: inRate,
      out_eur_per_mtok: outRate,
    };
  }
  return merged;
}

/** Drop a leading transport prefix (`openrouter/`) so `model` keys line up. */
export function normalizeModel(model: string): string {
  return (model ?? "").trim().replace(/^openrouter\//i, "");
}

/** The rate for a model, or null when the model isn't in the table (unpriced). */
export function rateForModel(
  rates: LlmRateTable,
  model: string,
): LlmModelRate | null {
  return rates[normalizeModel(model)] ?? null;
}

/**
 * € cost of one (model, provider) token bucket. CLI provider → 0 (subscription).
 * An unpriced model → 0 € but the caller should track it as unpriced so the UI
 * can flag the gap rather than silently under-report.
 */
export function modelCostEur(
  rate: LlmModelRate | null,
  promptTokens: number,
  completionTokens: number,
): number {
  if (!rate) return 0;
  return (
    (promptTokens / 1_000_000) * rate.in_eur_per_mtok +
    (completionTokens / 1_000_000) * rate.out_eur_per_mtok
  );
}

// ─── Cost roll-up over per-(provider,model) token buckets ────────────────────

/** One (provider, model) token bucket, split into the two windows. */
export interface ModelTokenBucket {
  provider: string;
  model: string;
  prompt_today: number;
  completion_today: number;
  prompt_7d: number;
  completion_7d: number;
}

export interface CostRollup {
  /** € across all non-CLI, priced buckets, today. */
  cost_today_eur: number;
  /** € across all non-CLI, priced buckets, last 7d. */
  cost_7d_eur: number;
  /** € per provider (openrouter/cli/…) for today and 7d, for a per-provider column. */
  by_provider: Record<string, { today: number; week: number }>;
  /**
   * Models seen (non-CLI) with tokens but NO rate — the cost gap. Their € is
   * counted as 0; surfacing the list lets the UI say "add a rate for these".
   */
  unpriced_models: string[];
}

/**
 * Fold per-(provider,model) token buckets into a € roll-up. Pure — the server
 * gathers the buckets from `llm_usage`, this does the arithmetic so it stays
 * unit-testable without a DB. CLI buckets contribute €0 (subscription) and are
 * never treated as unpriced.
 */
export function rollUpCosts(
  buckets: ModelTokenBucket[],
  rates: LlmRateTable,
): CostRollup {
  let costToday = 0;
  let cost7d = 0;
  const byProvider: Record<string, { today: number; week: number }> = {};
  const unpriced = new Set<string>();

  for (const b of buckets) {
    const cli = isCliProvider(b.provider);
    const rate = cli ? null : rateForModel(rates, b.model);
    const today = cli ? 0 : modelCostEur(rate, b.prompt_today, b.completion_today);
    const week = cli ? 0 : modelCostEur(rate, b.prompt_7d, b.completion_7d);

    // A non-CLI model with real tokens but no rate is a cost gap, not free.
    if (!cli && !rate && (b.prompt_7d > 0 || b.completion_7d > 0)) {
      unpriced.add(normalizeModel(b.model));
    }

    costToday += today;
    cost7d += week;
    const key = b.provider || "openrouter";
    const acc = byProvider[key] ?? { today: 0, week: 0 };
    acc.today += today;
    acc.week += week;
    byProvider[key] = acc;
  }

  return {
    cost_today_eur: costToday,
    cost_7d_eur: cost7d,
    by_provider: byProvider,
    unpriced_models: [...unpriced].sort(),
  };
}

// ─── Assessment coverage / backlog projection ────────────────────────────────

/** Coverage as a 0–1 fraction (covered / eligible). Null when nothing eligible. */
export function coverageFraction(
  covered: number,
  eligible: number,
): number | null {
  if (eligible <= 0) return null;
  return covered / eligible;
}

/**
 * Ticks needed to drain `pending` at `batchSize` per tick (ceil). Null when the
 * batch size is non-positive (a stopped/misconfigured scheduler can't drain).
 */
export function projectBacklogTicks(
  pending: number,
  batchSize: number,
): number | null {
  if (batchSize <= 0) return null;
  if (pending <= 0) return 0;
  return Math.ceil(pending / batchSize);
}

/**
 * Wall-clock seconds to drain the backlog: (ticks − 1) × interval. The current
 * tick clears the first batch immediately, so N ticks span N−1 intervals. Null
 * when ticks can't be computed. 0 when there's nothing pending.
 */
export function projectBacklogSeconds(
  pending: number,
  batchSize: number,
  intervalSeconds: number,
): number | null {
  const ticks = projectBacklogTicks(pending, batchSize);
  if (ticks === null) return null;
  if (ticks <= 0) return 0;
  return (ticks - 1) * Math.max(0, intervalSeconds);
}

/**
 * Projected € to clear the backlog: `pending` × the observed average € per
 * assessed property. Null when the per-property cost isn't known (no priced
 * assessment usage in the window) — the panel then shows the time projection
 * only, never a fabricated €0.
 */
export function projectBacklogCostEur(
  pending: number,
  avgCostEurPerProperty: number | null,
): number | null {
  if (avgCostEurPerProperty === null) return null;
  if (pending <= 0) return 0;
  return pending * avgCostEurPerProperty;
}

// ─── Response types (shared by route + page) ─────────────────────────────────

/** Per-flow (endpoint) call + token counts, both windows. */
export interface FlowUsage {
  endpoint: string;
  calls_today: number;
  calls_7d: number;
  tokens_today: number;
  tokens_7d: number;
}

/** Per-provider call + token + € counts, both windows. */
export interface ProviderUsage {
  provider: string;
  is_cli: boolean;
  calls_today: number;
  calls_7d: number;
  tokens_today: number;
  tokens_7d: number;
  cost_today_eur: number;
  cost_7d_eur: number;
}

/** Assessment coverage / backlog + projection at the current batch rate. */
export interface AssessmentCoverage {
  eligible: number;
  covered: number;
  pending: number;
  /** covered / eligible as a fraction, or null when nothing is eligible. */
  coverage_fraction: number | null;
  /** Ticks to drain the backlog, or null when the scheduler can't drain it. */
  projected_ticks: number | null;
  /** Wall-clock seconds to drain, or null. */
  projected_seconds: number | null;
  /** € to clear the backlog, or null when per-property cost is unknown. */
  projected_cost_eur: number | null;
  /** Observed average € per assessed property (7d), or null. */
  avg_cost_eur_per_property: number | null;
}

/** The scheduler throttle / kill-switch, surfaced next to the backlog. */
export interface SchedulerState {
  enabled: boolean;
  batch_size: number;
  interval_seconds: number;
}

/** Recent LLM error / rate-limit counts. */
export interface LlmErrorSummary {
  errors_today: number;
  errors_7d: number;
  /** Top error codes over the 7d window (code + count), most frequent first. */
  by_code: Array<{ code: string; count: number }>;
}

export interface LlmHealthResponse {
  /** Per-flow usage, most-used first. Empty when nothing is logged yet. */
  flows: FlowUsage[];
  /** Per-provider usage + €. */
  providers: ProviderUsage[];
  /** Total estimated € today / 7d + the unpriced-model gap. */
  cost: {
    cost_today_eur: number;
    cost_7d_eur: number;
    unpriced_models: string[];
  };
  coverage: AssessmentCoverage;
  scheduler: SchedulerState;
  errors: LlmErrorSummary;
  /**
   * True when `llm_usage` carries any token rows — i.e. per-token cost is
   * derivable. False (the current pre-wiring state) tells the UI to show call
   * counts + a "cost needs token logging" note instead of a fake €0.
   */
  tokens_logged: boolean;
  generated_at: string;
}
