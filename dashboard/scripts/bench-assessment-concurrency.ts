#!/usr/bin/env tsx
/**
 * #666 — measured before/after throughput for the AI-assessment batch's
 * bounded-concurrency worker pool (D-149).
 *
 * Runs the REAL `runAssessmentBatch()` (`lib/ai-assessment/batch.ts`) end to
 * end — real Postgres selection/cache/failure-ledger code, real
 * `assessPropertyOccupancy` flow, real LLM backend (whatever
 * `dashboard.llm_provider`/`DASHBOARD_LLM_PROVIDER` resolves to; the #666 PR
 * measurement used `cli`, the production default) — and reports wall-clock
 * assessments/hour, plus the `llm_usage` cache_creation vs cache_read token
 * split for the run (D-103's prompt-cache question).
 *
 * ## #666/D-149 review finding 4 — n MUST be >> concurrency
 *
 * `workerCount = Math.min(concurrency, propertyIds.length)`
 * (`batch.ts`) — a run with `n ≈ concurrency` is a SINGLE wave whose wall
 * clock is just `max(call latency)`, with no queueing tail, and flatters
 * high concurrency. The PR's first measurement made exactly this mistake
 * (`--n 6 --concurrency 4`, `--n 8 --concurrency 8`, `--n 10 --concurrency
 * 10` — always one wave) and reported speedups the review could not
 * reproduce at a real multi-wave `n`. The default `n` here is now large
 * enough (`--n`, default 24) that every `--concurrency` level in a normal
 * comparison run (4/8/10/12) is several waves deep, not one.
 *
 * This is a MECHANISM measurement, not a synthetic proxy: only the listing
 * TEXT is synthetic (generic, made-up Spanish real-estate prose — never
 * scraped content, per this repo's public-data policy); the code path that
 * runs is exactly what production runs on a real backlog. The wall-clock
 * CURVE this reports is host-dependent — one `claude` CLI child process per
 * in-flight call (D-106) — re-run it on the actual deployment host if you
 * need a number to size that host's own default off.
 *
 * ## Usage
 *
 *   1. Point POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) at a
 *      THROWAWAY database with etl/schema/init.sql applied — never a
 *      database anything else reads. This script INSERTs and DELETEs rows
 *      under a fixed synthetic address prefix; it refuses to run if that
 *      prefix already has rows left over from a previous interrupted run
 *      (clean up manually rather than risk double-processing stale IDs).
 *   2. `npx tsx scripts/bench-assessment-concurrency.ts [--n 24] [--concurrency 8] [--skip-before]`
 *
 *      `--skip-before` omits the concurrency=1 baseline leg (useful when
 *      comparing several `--concurrency` values back to back against a
 *      baseline already measured in an earlier invocation — a fresh
 *      concurrency=1 baseline at large `n` is the single most expensive leg
 *      to re-run every time).
 *
 * Costs real LLM calls under whatever provider/backend is configured
 * (n, or 2n with the baseline leg). Under `cli` with a Claude subscription
 * this is quota, not €.
 */
import { fileURLToPath } from "url";
import { sql, resetPool } from "../lib/db-write";
import { runAssessmentBatch, DEFAULT_BATCH_FLOWS } from "../lib/ai-assessment/batch";

const ADDRESS_PREFIX = "Calle Ficticia Bench666 ";

function parseIntArg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || !process.argv[idx + 1]) return fallback;
  const n = Number(process.argv[idx + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** A generic, made-up (never scraped) Spanish listing description. */
function fakeDescription(m2: number): string {
  return (
    `Piso de ${m2} metros cuadrados en zona residencial tranquila, buena ` +
    "orientación, cocina reformada hace unos años, sin ascensor. Se vende " +
    "libre de cargas y de inquilinos, para entrar a vivir. Comunidad con " +
    "gastos moderados, ideal para inversión o primera vivienda. Datos de " +
    "contacto ficticios de prueba, nunca reales."
  );
}

async function seed(n: number): Promise<number[]> {
  const existing = await sql<{ n: string }>(
    `SELECT COUNT(*) AS n FROM property WHERE address LIKE $1`,
    [`${ADDRESS_PREFIX}%`],
  );
  if (Number(existing[0].n) > 0) {
    throw new Error(
      `Found ${existing[0].n} leftover "${ADDRESS_PREFIX}*" properties from a ` +
        "previous run — clean them up (and their listing/ai_assessment rows) " +
        "before re-running, so this run's IDs are unambiguous.",
    );
  }
  const ids: number[] = [];
  for (let i = 1; i <= n; i++) {
    const m2 = 60 + i;
    const propRows = await sql<{ id: string }>(
      `INSERT INTO property (address, property_type, m2_built)
       VALUES ($1, 'piso', $2) RETURNING id`,
      [`${ADDRESS_PREFIX}${i}`, m2],
    );
    const propertyId = Number(propRows[0].id);
    ids.push(propertyId);
    await sql(
      `INSERT INTO listing
         (property_id, source, external_id, url, operation, status, listing_kind,
          current_price, description, last_seen_at, first_seen_at)
       VALUES ($1, 'bench666_source', $2, $3, 'sale', 'active', 'particular',
               $4, $5, now(), now() - interval '30 days')`,
      [
        propertyId,
        `bench666-${propertyId}`,
        `https://example.invalid/bench666/${propertyId}`,
        150000 + propertyId * 1000,
        fakeDescription(m2),
      ],
    );
  }
  return ids;
}

async function cleanup(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await sql(`DELETE FROM ai_assessment_failure WHERE property_id = ANY($1::bigint[])`, [ids]);
  await sql(`DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])`, [ids]);
  await sql(`DELETE FROM listing WHERE property_id = ANY($1::bigint[])`, [ids]);
  await sql(`DELETE FROM property WHERE id = ANY($1::bigint[])`, [ids]);
}

interface RunOutcome {
  label: string;
  concurrency: number;
  properties: number;
  assessed: number;
  errors: number;
  stopped: string | null;
  elapsedMs: number;
  perHour: number;
  waves: number;
}

/** #666/D-149 review finding 5 — cache_creation vs cache_read tokens logged during [startedAt, now]. */
async function cacheTokenSplit(startedAt: Date): Promise<{ creation: number; read: number }> {
  const rows = await sql<{ creation: string | null; read: string | null }>(
    `SELECT COALESCE(SUM(cache_creation_input_tokens), 0)::text AS creation,
            COALESCE(SUM(cache_read_input_tokens), 0)::text AS read
       FROM llm_usage
      WHERE endpoint = 'occupancy' AND created_at >= $1`,
    [startedAt.toISOString()],
  );
  return { creation: Number(rows[0]?.creation ?? 0), read: Number(rows[0]?.read ?? 0) };
}

async function runOne(
  label: string,
  propertyIds: number[],
  concurrency: number,
): Promise<RunOutcome> {
  const occupancyOnly = DEFAULT_BATCH_FLOWS.filter((f) => f.type === "occupancy");
  const startedAt = new Date();
  const started = Date.now();
  const result = await runAssessmentBatch({
    flows: occupancyOnly,
    concurrency,
    selectPropertyIds: async () => propertyIds,
    fetchTrendingCandidates: async () => [],
    fetchDismissedCandidates: async () => [],
  });
  const elapsedMs = Date.now() - started;
  const perHour = result.assessed > 0 ? (result.assessed / (elapsedMs / 1000)) * 3600 : 0;
  const waves = Math.ceil(propertyIds.length / Math.max(1, Math.min(concurrency, propertyIds.length)));
  const outcome: RunOutcome = {
    label,
    concurrency,
    properties: propertyIds.length,
    assessed: result.assessed,
    errors: result.errors,
    stopped: result.stopped,
    elapsedMs,
    perHour,
    waves,
  };
  const cacheSplit = await cacheTokenSplit(startedAt);
  const cacheTotal = cacheSplit.creation + cacheSplit.read;
  const readPct = cacheTotal > 0 ? ((cacheSplit.read / cacheTotal) * 100).toFixed(0) : "n/a";
  console.log(
    `[${label}] concurrency=${concurrency} properties=${propertyIds.length} waves=${waves} ` +
      `assessed=${result.assessed} errors=${result.errors} stopped=${result.stopped ?? "none"} ` +
      `elapsedMs=${elapsedMs} assessments/hour=${perHour.toFixed(0)} ` +
      `cache_creation_tokens=${cacheSplit.creation} cache_read_tokens=${cacheSplit.read} ` +
      `(${readPct}% of cache-relevant tokens were reads, not writes)`,
  );
  return outcome;
}

async function main() {
  const n = parseIntArg("n", 24);
  const concurrency = parseIntArg("concurrency", 8);
  const skipBefore = hasFlag("skip-before");

  console.log("#666 assessment-batch concurrency benchmark");
  console.log("============================================");
  console.log(
    `n=${n} properties per run, concurrency=${concurrency} for the "after" run` +
      `${skipBefore ? " (baseline leg SKIPPED)" : ""}.\n`,
  );

  const totalNeeded = skipBefore ? n : n * 2;
  const allIds = await seed(totalNeeded);
  const baselineIds = skipBefore ? [] : allIds.slice(0, n);
  const concurrentIds = skipBefore ? allIds : allIds.slice(n);

  try {
    const before = skipBefore
      ? null
      : await runOne("BEFORE (concurrency=1, the old always-serial shape)", baselineIds, 1);
    const after = await runOne(
      `AFTER (concurrency=${concurrency}, #666/D-149)`,
      concurrentIds,
      concurrency,
    );

    console.log("\n=== Summary ===");
    if (before) {
      console.log(
        `BEFORE: ${before.perHour.toFixed(0)} assessments/hour (${before.elapsedMs} ms for ${before.assessed} calls, ${before.waves} wave(s))`,
      );
    }
    console.log(
      `AFTER:  ${after.perHour.toFixed(0)} assessments/hour (${after.elapsedMs} ms for ${after.assessed} calls, ${after.waves} wave(s))`,
    );
    if (before && before.elapsedMs > 0) {
      console.log(`Speedup: ${(before.elapsedMs / after.elapsedMs).toFixed(2)}x wall-clock for the same call count`);
    }
  } finally {
    await cleanup(allIds);
    await resetPool();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[bench-assessment-concurrency] failed:", err);
    process.exit(1);
  });
}
