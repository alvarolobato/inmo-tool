import { sql } from "@/lib/db-write";
import { getLlmEndpointMetaEs } from "@/lib/llm-endpoint-meta";
import {
  fetchToolCallAggregates,
  type ToolCallAggregateRow,
} from "@/lib/llm-tools/logging";

export type { ToolCallAggregateRow };
export { fetchToolCallAggregates as getLlmToolCallAggregates };

export interface PeriodStats {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_usd: string;
}

export interface EndpointStats {
  endpoint: string;
  /** Human-readable name in Spanish (stable for known `logUsage` keys). */
  endpoint_label_es: string;
  /** What triggered this usage row (Spanish). */
  endpoint_detail_es: string;
  calls: number;
  total_tokens: number;
  estimated_cost_usd: string;
}

export interface ProviderStats {
  llm_provider: string;
  calls: number;
  total_tokens: number;
  estimated_cost_usd: string;
  /** Sum of cache_creation_input_tokens; null when all rows have NULL (e.g. CLI provider). */
  cache_creation_tokens: number | null;
  /** Sum of cache_read_input_tokens; null when all rows have NULL (e.g. CLI provider). */
  cache_read_tokens: number | null;
  /**
   * Cache hit rate as a number in [0, 100], or null when cache data is unavailable.
   * Formula: cache_read / (prompt_tokens + cache_read) * 100.
   */
  cache_hit_rate_pct: number | null;
}

export interface LlmUsageAggregates {
  today: PeriodStats;
  week: PeriodStats;
  month: PeriodStats;
  by_endpoint: EndpointStats[];
  /** Roll-up by transport (`openrouter` vs `cli`). */
  by_provider: ProviderStats[];
}

const ZERO_PERIOD: PeriodStats = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  estimated_cost_usd: "0.000000",
};

function rowToStats(row: Record<string, unknown> | undefined): PeriodStats {
  if (!row) return ZERO_PERIOD;
  return {
    prompt_tokens: Number(row.prompt_tokens) || 0,
    completion_tokens: Number(row.completion_tokens) || 0,
    total_tokens: Number(row.total_tokens) || 0,
    estimated_cost_usd: (Number(row.estimated_cost_usd) || 0).toFixed(6),
  };
}

/** Load LLM usage aggregates from `llm_usage` (same logic as GET /api/usage). */
export async function getLlmUsageAggregates(): Promise<LlmUsageAggregates> {
  try {
    const [periodRows, endpointRows, providerRows] = await Promise.all([
      sql<Record<string, unknown>>(`
        SELECT
          SUM(CASE WHEN created_at >= CURRENT_DATE THEN prompt_tokens ELSE 0 END)         AS today_prompt,
          SUM(CASE WHEN created_at >= CURRENT_DATE THEN completion_tokens ELSE 0 END)     AS today_completion,
          SUM(CASE WHEN created_at >= CURRENT_DATE THEN total_tokens ELSE 0 END)          AS today_total,
          SUM(CASE WHEN created_at >= CURRENT_DATE THEN estimated_cost_usd ELSE 0 END)    AS today_cost,

          SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN prompt_tokens ELSE 0 END)       AS week_prompt,
          SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN completion_tokens ELSE 0 END)   AS week_completion,
          SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN total_tokens ELSE 0 END)        AS week_total,
          SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN estimated_cost_usd ELSE 0 END)  AS week_cost,

          SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN prompt_tokens ELSE 0 END)      AS month_prompt,
          SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN completion_tokens ELSE 0 END)  AS month_completion,
          SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN total_tokens ELSE 0 END)       AS month_total,
          SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN estimated_cost_usd ELSE 0 END) AS month_cost
        FROM llm_usage
      `),
      sql<Record<string, unknown>>(`
        SELECT
          endpoint,
          COUNT(*)::integer             AS calls,
          SUM(total_tokens)::integer    AS total_tokens,
          SUM(estimated_cost_usd)       AS estimated_cost_usd
        FROM llm_usage
        GROUP BY endpoint
        ORDER BY SUM(total_tokens) DESC
      `),
      sql<Record<string, unknown>>(`
        SELECT
          COALESCE(llm_provider, 'openrouter')               AS llm_provider,
          COUNT(*)::integer                                   AS calls,
          SUM(total_tokens)::float8                          AS total_tokens,
          SUM(estimated_cost_usd)                            AS estimated_cost_usd,
          SUM(prompt_tokens)::bigint                         AS prompt_tokens_sum,
          SUM(cache_creation_input_tokens)::bigint           AS cache_creation_sum,
          SUM(cache_read_input_tokens)::bigint               AS cache_read_sum
        FROM llm_usage
        GROUP BY COALESCE(llm_provider, 'openrouter')
        ORDER BY calls DESC
      `),
    ]);

    const r = periodRows[0] ?? {};

    const today = rowToStats({
      prompt_tokens: r.today_prompt,
      completion_tokens: r.today_completion,
      total_tokens: r.today_total,
      estimated_cost_usd: r.today_cost,
    });

    const week = rowToStats({
      prompt_tokens: r.week_prompt,
      completion_tokens: r.week_completion,
      total_tokens: r.week_total,
      estimated_cost_usd: r.week_cost,
    });

    const month = rowToStats({
      prompt_tokens: r.month_prompt,
      completion_tokens: r.month_completion,
      total_tokens: r.month_total,
      estimated_cost_usd: r.month_cost,
    });

    const by_endpoint: EndpointStats[] = endpointRows.map((row) => {
      const endpoint = String(row.endpoint);
      const meta = getLlmEndpointMetaEs(endpoint);
      return {
        endpoint,
        endpoint_label_es: meta.label,
        endpoint_detail_es: meta.detail,
        calls: Number(row.calls) || 0,
        total_tokens: Number(row.total_tokens) || 0,
        estimated_cost_usd: (Number(row.estimated_cost_usd) || 0).toFixed(6),
      };
    });

    const by_provider: ProviderStats[] = providerRows.map((row) => {
      const cacheCreation = row.cache_creation_sum != null ? Number(row.cache_creation_sum) : null;
      const cacheRead = row.cache_read_sum != null ? Number(row.cache_read_sum) : null;
      const promptSum = Number(row.prompt_tokens_sum) || 0;
      // Cache hit rate = cache_read / (non-cached prompt + cache_creation + cache_read) * 100
      const hitDenominator = promptSum + (cacheCreation ?? 0) + (cacheRead ?? 0);
      const cacheHitRatePct =
        cacheRead != null && hitDenominator > 0
          ? (cacheRead / hitDenominator) * 100
          : null;
      return {
        llm_provider: String(row.llm_provider),
        calls: Number(row.calls) || 0,
        total_tokens: Number(row.total_tokens) || 0,
        estimated_cost_usd: (Number(row.estimated_cost_usd) || 0).toFixed(6),
        cache_creation_tokens: cacheCreation,
        cache_read_tokens: cacheRead,
        cache_hit_rate_pct: cacheHitRatePct,
      };
    });

    return { today, week, month, by_endpoint, by_provider };
  } catch (err) {
    if (process.env.VITEST !== "true") {
      console.error("[llm-usage-stats] aggregate query failed:", err);
    }
    return {
      today: ZERO_PERIOD,
      week: ZERO_PERIOD,
      month: ZERO_PERIOD,
      by_endpoint: [],
      by_provider: [],
    };
  }
}
