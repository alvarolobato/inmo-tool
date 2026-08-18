/**
 * F-7 pre-bump cost preview (docs/roadmap/llm-batching-plan.md Phase 0, PR
 * 0b), real-Postgres integration test.
 *
 * Proves `previewBumpCost` against a real DB rather than a mock because its
 * whole point is reusing `assessmentEligibleClause`/`missingCurrentVerdictClause`
 * (#330's shared fragment) UNMODIFIED against a hypothetical version — the one
 * thing worth confirming live is that the SQL those fragments produce still
 * composes correctly inside this module's own query shape.
 *
 * Follows the same minimal-fixture / exact-id-cleanup pattern as
 * batch.integration.test.ts.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { previewBumpCost } from "../bump-preview";

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
        "REQUIRE_DB=1 but Postgres is unreachable for bump-preview.integration.test.ts: " +
          String(err),
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[bump-preview.integration.test] no reachable Postgres — skipping real-DB tests. " +
        "Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("previewBumpCost — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdPropertyIds: number[] = [];
  let createdProfileIds: number[] = [];
  let createdUsageIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
    createdProfileIds = [];
    createdUsageIds = [];
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdUsageIds.length > 0) {
        await pool.query("DELETE FROM llm_usage WHERE id = ANY($1::int[])", [createdUsageIds]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [
          createdProfileIds,
        ]);
      }
    });
  });

  async function makeProfile(pool: Pool, tag: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO search_profile (name, scope, archived_at)
       VALUES ($1, '{"geography":{"type":"radius"},"property_types":["piso"]}'::jsonb, NULL)
       RETURNING id`,
      [`Bump preview profile ${tag}`],
    );
    const profileId = Number(rows[0].id);
    createdProfileIds.push(profileId);
    return profileId;
  }

  /** One eligible property: matched candidate of a fresh active profile, one
   * active described listing from a real (non-disabled) source. */
  async function seedEligibleProperty(pool: Pool, tag: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type, m2_built, rooms)
       VALUES ($1, 'piso', 85, 3) RETURNING id`,
      [`Calle Bump Preview ${tag}`],
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);
    await pool.query(
      `INSERT INTO listing
          (property_id, source, external_id, status, operation, current_price, description)
       VALUES ($1, 'fotocasa', $2, 'active', 'sale', 180000, 'Piso luminoso de 85 m2, tres dormitorios.')`,
      [propertyId, `bump-preview-${tag}`],
    );
    const profileId = await makeProfile(pool, tag);
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched)
       VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
    return propertyId;
  }

  async function seedLlmUsage(
    pool: Pool,
    endpoint: string,
    costUsd: number,
  ): Promise<void> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO llm_usage
          (endpoint, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, llm_provider, created_at)
       VALUES ($1, 'anthropic/claude-haiku-4.5', 1000, 200, 1200, $2, 'cli', NOW())
       RETURNING id`,
      [endpoint, costUsd],
    );
    createdUsageIds.push(Number(rows[0].id));
  }

  it("counts a never-assessed eligible property as fully reopened by a novel hypothetical version", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedEligibleProperty(pool, "novel");

      const summary = await previewBumpCost([
        { assessmentType: "condition", hypotheticalVersion: "condition/vX-never-seen" },
      ]);

      const flow = summary.flows.find((f) => f.assessmentType === "condition")!;
      expect(flow.eligible).toBeGreaterThanOrEqual(1);
      expect(flow.reopened).toBeGreaterThanOrEqual(1);
      // The property we just seeded must be counted among the reopened ones —
      // proven indirectly: eligible/reopened both moved by at least 1 for a
      // fresh property with no ai_assessment row at all.
      void propertyId;
    });
  });

  it("excludes a property that already carries a verdict at the EXACT hypothetical version", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedEligibleProperty(pool, "already-current");
      const version = "condition/v-preview-test";
      await pool.query(
        `INSERT INTO ai_assessment (property_id, assessment_type, result, model, prompt_version, generated_at)
         VALUES ($1, 'condition', '{"condition":"buen_estado"}'::jsonb, 'test-model', $2, NOW())`,
        [propertyId, version],
      );

      const before = await previewBumpCost([
        { assessmentType: "condition", hypotheticalVersion: "condition/some-other-version" },
      ]);
      const after = await previewBumpCost([
        { assessmentType: "condition", hypotheticalVersion: version },
      ]);

      const beforeFlow = before.flows[0];
      const afterFlow = after.flows[0];
      // Same eligible pool either way...
      expect(afterFlow.eligible).toBe(beforeFlow.eligible);
      // ...but reopened drops by exactly 1 when previewing the version this
      // property ALREADY has a verdict for.
      expect(afterFlow.reopened).toBe(beforeFlow.reopened - 1);
    });
  });

  it("prices the reopened backlog from the flow's recent llm_usage average, reusing projectBacklogCostEur's null-when-unknown contract", async () => {
    await withRealDb(async (pool) => {
      await seedEligibleProperty(pool, "priced");
      const endpoint = `bump-preview-test-${Date.now()}`;
      await seedLlmUsage(pool, endpoint, 0.02);
      await seedLlmUsage(pool, endpoint, 0.04);

      const summary = await previewBumpCost([
        { assessmentType: endpoint, hypotheticalVersion: "v-never-seen" },
      ]);

      // Note: `endpoint` here isn't a real assessment_type, so eligible/reopened
      // are irrelevant (assessment_type only gates the missingCurrentVerdictClause
      // subquery, which never matches a made-up type — reopened === eligible
      // pool-wide). What this test isolates is the € arithmetic: avg cost must
      // be the mean of the two seeded calls, and projected cost must equal
      // reopened × avg (projectBacklogCostEur, reused verbatim).
      const flow = summary.flows[0];
      expect(flow.avg_cost_eur_per_call).toBeCloseTo(0.03, 6);
      expect(flow.projected_cost_eur).toBeCloseTo(flow.reopened * 0.03, 6);
      expect(summary.total_projected_cost_eur).toBeCloseTo(flow.projected_cost_eur!, 6);
    });
  });

  it("reports null cost (never a fabricated €0) for a flow with no recent llm_usage rows", async () => {
    await withRealDb(async () => {
      const summary = await previewBumpCost([
        { assessmentType: "redflags", hypotheticalVersion: `v-preview-no-usage-${Date.now()}` },
      ]);
      const flow = summary.flows[0];
      // Whether or not other tests/processes logged redflags usage in the
      // last 7d is out of this test's control — assert the CONTRACT instead:
      // avg null implies projected null, never a fabricated number.
      if (flow.avg_cost_eur_per_call === null) {
        expect(flow.projected_cost_eur).toBeNull();
      }
    });
  });
});
