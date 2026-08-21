#!/usr/bin/env tsx
/**
 * #666 — measured before/after throughput for the AI-assessment batch's
 * bounded-concurrency worker pool (D-149).
 *
 * Runs the REAL `runAssessmentBatch()` (`lib/ai-assessment/batch.ts`) end to
 * end — real Postgres selection/cache/failure-ledger code, real
 * `assessPropertyOccupancy` flow, real LLM backend (whatever
 * `dashboard.llm_provider`/`DASHBOARD_LLM_PROVIDER` resolves to; the #666 PR
 * measurement used `cli`, the production default) — at `concurrency=1`
 * (the old, always-serial behaviour) and then at a configurable
 * `--concurrency` (the new default is 4) over two DISJOINT sets of
 * properties, so neither run can be a #30 cache hit against the other, and
 * reports wall-clock assessments/hour for each.
 *
 * This is a MECHANISM measurement, not a synthetic proxy: only the listing
 * TEXT is synthetic (generic, made-up Spanish real-estate prose — never
 * scraped content, per this repo's public-data policy); the code path that
 * runs is exactly what production runs on a real backlog.
 *
 * ## Usage
 *
 *   1. Point POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) at a
 *      THROWAWAY database with etl/schema/init.sql applied — never a
 *      database anything else reads. This script INSERTs and DELETEs rows
 *      under a fixed synthetic address prefix; it refuses to run if that
 *      prefix already has rows left over from a previous interrupted run
 *      (clean up manually rather than risk double-processing stale IDs).
 *   2. `npx tsx scripts/bench-assessment-concurrency.ts [--n 6] [--concurrency 4]`
 *
 * Costs real LLM calls under whatever provider/backend is configured (2 × N
 * calls). Under `cli` with a Claude subscription this is quota, not €.
 */
import { fileURLToPath } from "url";
import { sql, resetPool } from "../lib/db-write";
import { runAssessmentBatch, DEFAULT_BATCH_FLOWS } from "../lib/ai-assessment/batch";

const ADDRESS_PREFIX = "Calle Ficticia Bench666 ";

function parseArg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || !process.argv[idx + 1]) return fallback;
  const n = Number(process.argv[idx + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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
}

async function runOne(
  label: string,
  propertyIds: number[],
  concurrency: number,
): Promise<RunOutcome> {
  const occupancyOnly = DEFAULT_BATCH_FLOWS.filter((f) => f.type === "occupancy");
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
  const outcome: RunOutcome = {
    label,
    concurrency,
    properties: propertyIds.length,
    assessed: result.assessed,
    errors: result.errors,
    stopped: result.stopped,
    elapsedMs,
    perHour,
  };
  console.log(
    `[${label}] concurrency=${concurrency} properties=${propertyIds.length} ` +
      `assessed=${result.assessed} errors=${result.errors} stopped=${result.stopped ?? "none"} ` +
      `elapsedMs=${elapsedMs} assessments/hour=${perHour.toFixed(0)}`,
  );
  return outcome;
}

async function main() {
  const n = parseArg("n", 6);
  const concurrency = parseArg("concurrency", 4);

  console.log("#666 assessment-batch concurrency benchmark");
  console.log("============================================");
  console.log(`n=${n} properties per run, concurrency=${concurrency} for the "after" run.\n`);

  const allIds = await seed(n * 2);
  const baselineIds = allIds.slice(0, n);
  const concurrentIds = allIds.slice(n);

  try {
    const before = await runOne("BEFORE (concurrency=1, the old always-serial shape)", baselineIds, 1);
    const after = await runOne(`AFTER (concurrency=${concurrency}, #666/D-149 default)`, concurrentIds, concurrency);

    console.log("\n=== Summary ===");
    console.log(`BEFORE: ${before.perHour.toFixed(0)} assessments/hour (${before.elapsedMs} ms for ${before.assessed} calls)`);
    console.log(`AFTER:  ${after.perHour.toFixed(0)} assessments/hour (${after.elapsedMs} ms for ${after.assessed} calls)`);
    if (before.elapsedMs > 0) {
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
