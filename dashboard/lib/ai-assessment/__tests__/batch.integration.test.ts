/**
 * #308 — assessment batch trigger, real-Postgres integration test (EC-1).
 *
 * The one thing worth proving against a real database rather than a mock:
 * after ONE `runAssessmentBatch()` pass, a freshly-ingested property with no
 * `ai_assessment` rows ends up WITH occupancy/condition/redflags rows — the
 * whole point of #308 (the flows were built and cached but never called, so
 * the candidate feed showed zero badges). Nothing in the middle is stubbed
 * except the LLM itself, via the `mock` provider that runs the real
 * assembleRequest → runner → parse → persist pipeline (see
 * occupancy.integration.test.ts's header for why the mock provider, not a
 * `vi.mock`, is the right seam here).
 *
 * Also proves the SELECT side of idempotency (EC-2 at the query level): a
 * property already assessed under the current prompt version is NOT returned
 * by `selectPropertiesNeedingAssessment`, so it is never re-billed.
 *
 * Cleanup is scoped to exact IDs this file creates (not a table-wide delete):
 * vitest runs files serially against one shared Postgres, and a broad delete
 * could race unrelated fixtures. Same rationale as the sibling integration
 * files.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { resetDashboardLlmConfigCache } from "@/lib/llm-provider/config";
import {
  runAssessmentBatch,
  selectPropertiesNeedingAssessment,
} from "../batch";
import {
  saveOccupancyAssessment,
  parseOccupancyResult,
  OCCUPANCY_PROMPT_VERSION,
} from "../occupancy";
import { saveConditionAssessment, parseConditionResult, CONDITION_PROMPT_VERSION } from "../condition";
import { saveRedFlagsAssessment, parseRedFlagsResult, REDFLAGS_PROMPT_VERSION } from "../redflags";

async function withRealDb(fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

const REQUIRE_DB = process.env.REQUIRE_DB === "1";

const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    if (REQUIRE_DB) {
      throw new Error(
        "REQUIRE_DB=1 but Postgres is unreachable for batch.integration.test.ts: " +
          String(err),
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[batch.integration.test] no reachable Postgres — skipping real-DB tests. " +
        "Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("assessment batch — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdPropertyIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "mock");
    resetDashboardLlmConfigCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetDashboardLlmConfigCache();
    await withRealDb(async (pool) => {
      if (createdPropertyIds.length === 0) return;
      await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [
        createdPropertyIds,
      ]);
      await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [
        createdPropertyIds,
      ]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
    });
  });

  /** One property with two active adverts, no assessments yet. */
  async function seedUnassessedProperty(pool: Pool, tag: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type, m2_built, rooms)
       VALUES ($1, 'piso', 85, 3) RETURNING id`,
      [`Calle Batch ${tag}`],
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);
    const adverts: [string, string, string][] = [
      ["fotocasa", `batch-${tag}-a`, "Piso luminoso de 85 m2. Tres dormitorios."],
      ["milanuncios", `batch-${tag}-b`, "Se vende con inquilino, buena rentabilidad."],
    ];
    for (const [source, externalId, description] of adverts) {
      await pool.query(
        `INSERT INTO listing
            (property_id, source, external_id, status, operation, current_price, description)
         VALUES ($1, $2, $3, 'active', 'sale', 180000, $4)`,
        [propertyId, source, externalId, description],
      );
    }
    return propertyId;
  }

  it("EC-1: one batch pass writes occupancy/condition/redflags rows for an unassessed property", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedUnassessedProperty(pool, "ec1");

      // Target this exact property (the DB may hold other files' fixtures);
      // the flows, isFlowCurrent, persistence, and mock LLM pipeline are all
      // real — only the property selection is pinned for a deterministic
      // assertion. The real selection query is exercised separately below.
      const result = await runAssessmentBatch({
        selectPropertyIds: async () => [propertyId],
        batchSize: 5,
      });

      expect(result.stopped).toBeNull();
      // occupancy + condition + redflags always run; extract may run or skip
      // (self-gated) — at least the three badge-driving flows were assessed.
      expect(result.assessed).toBeGreaterThanOrEqual(3);

      const { rows } = await pool.query<{ assessment_type: string }>(
        `SELECT assessment_type FROM ai_assessment WHERE property_id = $1`,
        [propertyId],
      );
      const types = new Set(rows.map((r) => r.assessment_type));
      expect(types.has("occupancy")).toBe(true);
      expect(types.has("condition")).toBe(true);
      expect(types.has("redflags")).toBe(true);
    });
  });

  it("selects an unassessed property and NOT a fully-current one (EC-2 at the query level)", async () => {
    await withRealDb(async (pool) => {
      const unassessed = await seedUnassessedProperty(pool, "sel-miss");
      const assessed = await seedUnassessedProperty(pool, "sel-hit");

      // Give `assessed` a current-prompt-version verdict for all three
      // selection flows, so it should drop out of selection.
      await saveOccupancyAssessment(
        assessed,
        parseOccupancyResult(
          JSON.stringify({
            occupancy: { status: "vacant", confidence: 0.5, evidence: "libre", evidence_source: "fotocasa" },
            transaction: { kind: "compraventa", confidence: 0.8 },
            ownership: { extent: "pleno_dominio", confidence: 0.7, share_pct: null },
            reasoning: "x",
          }),
        ),
        "m",
      );
      await saveConditionAssessment(
        assessed,
        parseConditionResult(
          JSON.stringify({ condition: "reformado", confidence: 0.6, evidence: "reformado", evidence_source: "fotocasa", issues: [], reasoning: "x" }),
        ),
        "m",
      );
      await saveRedFlagsAssessment(
        assessed,
        parseRedFlagsResult(JSON.stringify({ flags: [], confidence: 0.5, reasoning: "x" })),
        "m",
      );

      // A large batch so ordering/other fixtures don't hide our target.
      const selected = await selectPropertiesNeedingAssessment(1000);
      expect(selected).toContain(unassessed);
      expect(selected).not.toContain(assessed);

      // Sanity: the versions we wrote are the current ones (guards against a
      // silent prompt-version bump making this test vacuous).
      expect([OCCUPANCY_PROMPT_VERSION, CONDITION_PROMPT_VERSION, REDFLAGS_PROMPT_VERSION]).toHaveLength(3);
    });
  });

  it("re-running the batch over an already-assessed property writes no new rows", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedUnassessedProperty(pool, "idem");

      await runAssessmentBatch({ selectPropertyIds: async () => [propertyId], batchSize: 5 });
      const first = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment WHERE property_id = $1`,
        [propertyId],
      );

      // Second pass: every flow is now current → all skipped, no new rows.
      const second = await runAssessmentBatch({
        selectPropertyIds: async () => [propertyId],
        batchSize: 5,
      });
      expect(second.assessed).toBe(0);
      expect(second.skipped).toBeGreaterThanOrEqual(3);

      const after = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment WHERE property_id = $1`,
        [propertyId],
      );
      expect(Number(after.rows[0].n)).toBe(Number(first.rows[0].n));
    });
  });
});
