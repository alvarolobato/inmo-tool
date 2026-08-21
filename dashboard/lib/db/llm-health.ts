/**
 * LLM cost / usage aggregation (issue #324) — server-only.
 *
 * Read-only: every query is a SELECT, run through the read-only `query()` pool
 * (lib/db). Feeds the "LLM / IA" section of the "Salud de datos" page with the
 * cost-control signals the owner asked for (call volume + € + backlog):
 *
 *   1. Calls + tokens by flow (endpoint)  — llm_usage, today + 7d windows.
 *   2. Calls + tokens by provider         — llm_usage, today + 7d windows.
 *   3. Tokens by (provider, model)        — llm_usage, folded into € via the
 *      configurable rate table (pure `rollUpCosts`). CLI provider = €0.
 *   4. Assessment coverage / backlog      — property + listing + ai_assessment,
 *      mirroring `selectPropertiesNeedingAssessment`'s eligibility exactly.
 *   5. Error / rate-limit counts          — llm_errors, today + 7d.
 *
 * The scheduler throttle (batch size / interval / kill switch) comes from the
 * same `loadSchedulerConfig()` the scheduler itself reads, so the rate shown is
 * the rate that actually runs.
 *
 * Cost is an ESTIMATE (tokens × operator-controlled rate), never a billed
 * figure — the pure arithmetic lives in lib/llm-health.ts. This module only
 * runs the reads and hands the numbers over.
 *
 * Degrades cleanly: the tracking tables are empty until the LLM path is wired,
 * so every count is a straight aggregate that returns 0 / [] rather than
 * throwing, and `tokens_logged` tells the UI to show "sin datos aún" instead of
 * a fabricated €0.
 */

import { query } from "@/lib/db";
import { loadSchedulerConfig } from "@/lib/ai-assessment/scheduler";
import { getSystemConfig } from "@/lib/system-config/loader";
import {
  DISABLED_SOURCES_CTE,
  assessmentEligibleClause,
  selectionFlowValues,
  missingCurrentVerdictClause,
} from "@/lib/ai-assessment/eligibility";
import {
  parseRateTable,
  rollUpCosts,
  coverageFraction,
  projectBacklogTicks,
  projectBacklogSeconds,
  projectBacklogCostEur,
  isCliProvider,
  type FlowUsage,
  type ProviderUsage,
  type LlmHealthResponse,
  type ModelTokenBucket,
} from "@/lib/llm-health";

/** Coerce a pg value (number | numeric-string | null) to a number, 0 on null. */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Endpoints that count as an AI-assessment run (for per-property avg cost). */
const ASSESSMENT_ENDPOINTS = ["occupancy", "condition", "redflags", "extract", "compare"];

/**
 * Aggregate every LLM cost/usage signal. Independent reads run in parallel;
 * each is a grouped aggregate over indexed columns (created_at / generated_at),
 * cheap enough for a page that polls at a slow cadence.
 */
export async function getLlmHealth(): Promise<LlmHealthResponse> {
  const rateOverride = readRateOverride();
  const rates = parseRateTable(rateOverride);
  const scheduler = loadSchedulerConfig();

  // Coverage query params: the (atype, ver) pairs, built with the SHARED
  // fragment so eligibility + backlog match `selectPropertiesNeedingAssessment`
  // exactly (#330).
  const { valuesSql: covValues, params: covParams } = selectionFlowValues(1);

  const [
    flowRes,
    providerRes,
    modelRes,
    coverageRes,
    avgCostRes,
    errorRes,
    errorCodeRes,
    cliZeroUsageRes,
  ] = await Promise.all([
      // 1. Calls + tokens by flow (endpoint), today + 7d.
      query(
        `SELECT endpoint,
                COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)                          AS calls_today,
                COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days')       AS calls_7d,
                COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= CURRENT_DATE), 0)     AS tokens_today,
                COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'), 0) AS tokens_7d
           FROM llm_usage
          WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
          GROUP BY endpoint
          ORDER BY tokens_7d DESC, calls_7d DESC, endpoint`,
      ),

      // 2. Calls + tokens by provider, today + 7d.
      query(
        `SELECT COALESCE(llm_provider, 'openrouter') AS provider,
                COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)                          AS calls_today,
                COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days')       AS calls_7d,
                COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= CURRENT_DATE), 0)     AS tokens_today,
                COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'), 0) AS tokens_7d
           FROM llm_usage
          WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
          GROUP BY COALESCE(llm_provider, 'openrouter')
          ORDER BY calls_7d DESC, provider`,
      ),

      // 3. Prompt/completion tokens by (provider, model), today + 7d — folded
      //    into € by the pure rate-table roll-up. Split by direction because
      //    input and output tokens are priced differently.
      query(
        `SELECT COALESCE(llm_provider, 'openrouter') AS provider,
                model,
                COALESCE(SUM(prompt_tokens)     FILTER (WHERE created_at >= CURRENT_DATE), 0)                    AS prompt_today,
                COALESCE(SUM(completion_tokens) FILTER (WHERE created_at >= CURRENT_DATE), 0)                    AS completion_today,
                COALESCE(SUM(prompt_tokens)     FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'), 0) AS prompt_7d,
                COALESCE(SUM(completion_tokens) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'), 0) AS completion_7d,
                -- Provider-reported cost (D-102). The only way to price cli
                -- buckets: no local rate table can model the CLI cache mix.
                COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= CURRENT_DATE), 0)                    AS reported_today,
                COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'), 0) AS reported_7d
           FROM llm_usage
          WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
          GROUP BY COALESCE(llm_provider, 'openrouter'), model`,
      ),

      // 4. Assessment coverage / backlog, using the SHARED eligibility predicate
      //    (#330) so these numbers equal what the scheduler actually assesses.
      //    Eligible = matched candidate of an active profile + a readable
      //    active listing from a non-disabled source (#327 rule). Pending =
      //    eligible AND missing a current-prompt-version verdict for at least
      //    one selection flow. Covered = eligible − pending.
      query(
        `WITH ${DISABLED_SOURCES_CTE},
         eligible AS (
           SELECT p.id
             FROM property p
            WHERE ${assessmentEligibleClause("p")}
         ),
         pending AS (
           SELECT e.id
             FROM eligible e
            WHERE ${missingCurrentVerdictClause("e", covValues)}
         )
         SELECT (SELECT COUNT(*) FROM eligible) AS eligible,
                (SELECT COUNT(*) FROM pending)  AS pending`,
        covParams,
      ),

      // 5. Average € per assessed property (7d): assessment-flow token spend
      //    over the 7d window, per (provider, model), plus the count of DISTINCT
      //    properties that received an assessment in that window. The € comes
      //    from the same rate table; the division happens below.
      query(
        `SELECT
           (SELECT COUNT(DISTINCT property_id)
              FROM ai_assessment
             WHERE generated_at >= CURRENT_DATE - INTERVAL '7 days') AS properties_7d`,
      ),

      // 6a. Error counts, today + 7d.
      query(
        `SELECT
           COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)                    AS errors_today,
           COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') AS errors_7d
           FROM llm_errors`,
      ),

      // 6b. Top error codes over the 7d window.
      query(
        `SELECT code, COUNT(*) AS n
           FROM llm_errors
          WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
          GROUP BY code
          ORDER BY n DESC, code
          LIMIT 8`,
      ),

      // 7. F-8 zero-usage canary: CLI-provider rows in the last 24h that
      //    logged total_tokens = 0. Post-D-102 this must always be 0 — see
      //    the field doc on LlmHealthResponse.cli_zero_usage_24h.
      query(
        `SELECT COUNT(*)
           FROM llm_usage
          WHERE llm_provider = 'cli'
            AND total_tokens = 0
            AND created_at >= NOW() - INTERVAL '24 hours'`,
      ),
    ]);

  const flows: FlowUsage[] = flowRes.rows.map((r) => ({
    endpoint: String(r[0]),
    calls_today: num(r[1]),
    calls_7d: num(r[2]),
    tokens_today: num(r[3]),
    tokens_7d: num(r[4]),
  }));

  // Per-(provider, model) buckets → € roll-up (pure).
  const buckets: ModelTokenBucket[] = modelRes.rows.map((r) => ({
    provider: String(r[0]),
    model: String(r[1] ?? ""),
    prompt_today: num(r[2]),
    completion_today: num(r[3]),
    prompt_7d: num(r[4]),
    completion_7d: num(r[5]),
    reported_today: num(r[6]),
    reported_7d: num(r[7]),
  }));
  const costRollup = rollUpCosts(buckets, rates);

  const providers: ProviderUsage[] = providerRes.rows.map((r) => {
    const provider = String(r[0]);
    const perProv = costRollup.by_provider[provider] ?? { today: 0, week: 0 };
    return {
      provider,
      is_cli: isCliProvider(provider),
      calls_today: num(r[1]),
      calls_7d: num(r[2]),
      tokens_today: num(r[3]),
      tokens_7d: num(r[4]),
      cost_today_eur: perProv.today,
      cost_7d_eur: perProv.week,
    };
  });

  // Coverage / backlog + projection.
  const eligible = num(coverageRes.rows[0]?.[0]);
  const pending = num(coverageRes.rows[0]?.[1]);
  const covered = Math.max(0, eligible - pending);

  // Average € per assessed property (7d): assessment-only spend ÷ distinct
  // properties assessed. Assessment spend = € of buckets whose... llm_usage has
  // no property link, so we approximate with the total assessment-endpoint 7d €
  // (a superset that excludes dashboard flows) divided by properties assessed.
  const propertiesAssessed7d = num(avgCostRes.rows[0]?.[0]);
  const assessment7dEur = assessmentSpend7dEur(flows, buckets, rates);
  const avgCostPerProperty =
    propertiesAssessed7d > 0 && assessment7dEur > 0
      ? assessment7dEur / propertiesAssessed7d
      : null;

  const coverage = {
    eligible,
    covered,
    pending,
    coverage_fraction: coverageFraction(covered, eligible),
    projected_ticks: projectBacklogTicks(pending, scheduler.batchSize),
    // #666/D-149: while a real backlog exists, consecutive ticks reschedule
    // after `drainIntervalSeconds`, not the full idle `intervalSeconds` — see
    // scheduler.ts's adaptive duty cycle. Using the idle cadence here would
    // wildly overstate how long the backlog actually takes to clear now that
    // draining doesn't wait out the full interval between ticks.
    projected_seconds: projectBacklogSeconds(
      pending,
      scheduler.batchSize,
      scheduler.drainIntervalSeconds,
    ),
    projected_cost_eur: projectBacklogCostEur(pending, avgCostPerProperty),
    avg_cost_eur_per_property: avgCostPerProperty,
  };

  const errors = {
    errors_today: num(errorRes.rows[0]?.[0]),
    errors_7d: num(errorRes.rows[0]?.[1]),
    by_code: errorCodeRes.rows.map((r) => ({
      code: String(r[0]),
      count: num(r[1]),
    })),
  };

  const tokensLogged = buckets.some(
    (b) => b.prompt_7d > 0 || b.completion_7d > 0,
  );

  return {
    flows,
    providers,
    cost: {
      cost_today_eur: costRollup.cost_today_eur,
      cost_7d_eur: costRollup.cost_7d_eur,
      unpriced_models: costRollup.unpriced_models,
    },
    coverage,
    scheduler: {
      enabled: scheduler.enabled,
      batch_size: scheduler.batchSize,
      interval_seconds: scheduler.intervalSeconds,
    },
    errors,
    tokens_logged: tokensLogged,
    cli_zero_usage_24h: num(cliZeroUsageRes.rows[0]?.[0]),
    generated_at: new Date().toISOString(),
  };
}

/**
 * 7d € spend attributable to the AI-assessment flows, used for the
 * per-property cost estimate that drives the backlog € projection. Sums the €
 * of only the token buckets from assessment endpoints — but `llm_usage`'s model
 * buckets aren't split by endpoint, so we scale the total non-CLI 7d € by the
 * share of 7d tokens that came from assessment endpoints. Rough by design (the
 * projection is a planning aid, not a bill); returns 0 when there's nothing to
 * attribute, which collapses the projection to null upstream.
 */
function assessmentSpend7dEur(
  flows: FlowUsage[],
  buckets: ModelTokenBucket[],
  rates: import("@/lib/llm-health").LlmRateTable,
): number {
  const totalTokens7d = flows.reduce((s, f) => s + f.tokens_7d, 0);
  if (totalTokens7d <= 0) return 0;
  const assessmentTokens7d = flows
    .filter((f) => ASSESSMENT_ENDPOINTS.includes(f.endpoint))
    .reduce((s, f) => s + f.tokens_7d, 0);
  if (assessmentTokens7d <= 0) return 0;
  const total7dEur = rollUpCosts(buckets, rates).cost_7d_eur;
  return total7dEur * (assessmentTokens7d / totalTokens7d);
}

/**
 * Read the operator's per-model € rate override (a JSON object string) through
 * the central config loader, falling back to the env var, then null. Mirrors
 * the scheduler's config-read pattern (env > config.yaml > default).
 */
function readRateOverride(): string | null {
  try {
    const raw = getSystemConfig()["dashboard.llm_cost_rates_eur"]?.value;
    if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
      return String(raw);
    }
  } catch {
    // Loader unavailable (schema missing / build context) — fall through.
  }
  const env = process.env.DASHBOARD_LLM_COST_RATES_EUR;
  return env !== undefined && env.trim() !== "" ? env : null;
}
