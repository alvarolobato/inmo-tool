/**
 * Shared assessment cache — real-Postgres integration test (#30).
 *
 * cache.test.ts proves `getOrCompute`'s decision logic against a mocked
 * `sql`; this file proves the actual round trip against a real
 * `ai_assessment` row: a real INSERT writes `content_hash`, a real SELECT
 * (`getLatestAssessment`, via `getConditionAssessment`) reads it back, and the
 * hit/miss decision holds against genuine Postgres NUMERIC/TEXT/JSONB
 * round-tripping — not just the in-memory shape `cache.test.ts`'s mock hands
 * back. `computeFn` is a plain spy (not the real LLM): this test is about the
 * cache/DB layer, not about model output, which the per-flow integration
 * tests already cover via the mock provider.
 *
 * Skips cleanly when no database is reachable, same REQUIRE_DB=1 contract as
 * every other *.integration.test.ts in this directory.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { sql, resetPool } from "@/lib/db-write";
import { getOrCompute, getLatestAssessment } from "../cache";
import {
  saveConditionAssessment,
  getConditionAssessment,
  parseConditionResult,
  CONDITION_PROMPT_VERSION,
  type ConditionResult,
} from "../condition";
import type { ListingSnapshot } from "@/lib/llm-context";

/**
 * `saveConditionAssessment` always writes the flow's own hardcoded
 * `CONDITION_PROMPT_VERSION` — by construction, real callers only ever invoke
 * it via `assessPropertyCondition`, where the `promptVersion` passed to
 * `getOrCompute` and the version `save` writes are the SAME constant. The
 * "prompt bump" test below deliberately breaks that invariant to simulate a
 * version change without needing a second real flow module, so it needs a
 * `save` that actually writes whichever version string it's given.
 */
async function saveAtVersion(
  propertyId: number,
  result: ConditionResult,
  model: string | null,
  contentHash: string | null,
  promptVersion: string,
): Promise<void> {
  await sql(
    `INSERT INTO ai_assessment
        (property_id, assessment_type, result, confidence, model, prompt_version, content_hash, generated_at)
     VALUES ($1, 'condition', $2::jsonb, $3, $4, $5, $6, NOW())
     ON CONFLICT ON CONSTRAINT ai_assessment_property_key
     DO UPDATE SET result = EXCLUDED.result,
                   confidence = EXCLUDED.confidence,
                   model = EXCLUDED.model,
                   content_hash = EXCLUDED.content_hash,
                   generated_at = EXCLUDED.generated_at`,
    [propertyId, JSON.stringify(result), result.confidence, model, promptVersion, contentHash],
  );
}

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
        "REQUIRE_DB=1 but Postgres is unreachable for cache.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[cache.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const A_REFORMAR = JSON.stringify({
  condition: "a_reformar",
  confidence: 0.85,
  issues: ["instalación eléctrica antigua"],
  evidence: "a reformar, necesita actualización de instalaciones",
  evidence_source: "milanuncios",
  reasoning: "El anuncio pide reforma.",
});

describe.runIf(dbAvailable)("assessment cache — real Postgres round trip", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdPropertyIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdPropertyIds.length === 0) return;
      await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [
        createdPropertyIds,
      ]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [
        createdPropertyIds,
      ]);
    });
  });

  async function seedProperty(pool: Pool): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type) VALUES ('Calle Test Cache 1', 'piso') RETURNING id`,
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);
    return propertyId;
  }

  it("writes content_hash on a real INSERT and reads it back via getConditionAssessment", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedProperty(pool);
      const listings: ListingSnapshot[] = [
        { listingId: 1, description: "a reformar, necesita instalaciones" },
      ];
      const computeFn = vi.fn().mockResolvedValue({
        result: parseConditionResult(A_REFORMAR),
        model: "test-model",
      });

      const first = await getOrCompute(
        propertyId,
        "condition",
        CONDITION_PROMPT_VERSION,
        listings,
        computeFn,
        saveConditionAssessment,
      );
      expect(first.fromCache).toBe(false);
      expect(computeFn).toHaveBeenCalledTimes(1);

      const { rows } = await pool.query<{ content_hash: string | null }>(
        `SELECT content_hash FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'condition'`,
        [propertyId],
      );
      expect(rows[0].content_hash).not.toBeNull();

      const cached = await getConditionAssessment(propertyId);
      expect(cached?.content_hash).toBe(rows[0].content_hash);
      expect(cached?.stale).toBe(false);
    });
  });

  it("a SECOND real call for the SAME unchanged listings is a cache hit — computeFn runs exactly once (EC-1, real DB)", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedProperty(pool);
      const listings: ListingSnapshot[] = [
        { listingId: 1, description: "a reformar, necesita instalaciones" },
      ];
      const computeFn = vi.fn().mockResolvedValue({
        result: parseConditionResult(A_REFORMAR),
        model: "test-model",
      });

      await getOrCompute(
        propertyId,
        "condition",
        CONDITION_PROMPT_VERSION,
        listings,
        computeFn,
        saveConditionAssessment,
      );
      const second = await getOrCompute(
        propertyId,
        "condition",
        CONDITION_PROMPT_VERSION,
        listings,
        computeFn,
        saveConditionAssessment,
      );

      expect(second.fromCache).toBe(true);
      expect(computeFn).toHaveBeenCalledTimes(1); // NOT called again
    });
  });

  it("a real description change invalidates the real row — computeFn runs a second time", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedProperty(pool);
      const original: ListingSnapshot[] = [{ listingId: 1, description: "descripción original" }];
      const changed: ListingSnapshot[] = [
        { listingId: 1, description: "a reformar, necesita instalaciones" },
      ];
      const computeFn = vi.fn().mockResolvedValue({
        result: parseConditionResult(A_REFORMAR),
        model: "test-model",
      });

      await getOrCompute(
        propertyId,
        "condition",
        CONDITION_PROMPT_VERSION,
        original,
        computeFn,
        saveConditionAssessment,
      );
      const afterChange = await getOrCompute(
        propertyId,
        "condition",
        CONDITION_PROMPT_VERSION,
        changed,
        computeFn,
        saveConditionAssessment,
      );

      expect(afterChange.fromCache).toBe(false);
      expect(computeFn).toHaveBeenCalledTimes(2);

      // Still exactly one row (UPDATE in place, not a second row).
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'condition'`,
        [propertyId],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it("a prompt-version bump invalidates the real row, and GET still returns the old row marked stale (the #30 skew fix)", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedProperty(pool);
      const listings: ListingSnapshot[] = [
        { listingId: 1, description: "a reformar, necesita instalaciones" },
      ];
      const computeFn = vi.fn().mockResolvedValue({
        result: parseConditionResult(A_REFORMAR),
        model: "test-model",
      });

      await getOrCompute(
        propertyId,
        "condition",
        CONDITION_PROMPT_VERSION,
        listings,
        computeFn,
        (pid, result, model, contentHash) =>
          saveAtVersion(pid, result, model, contentHash, CONDITION_PROMPT_VERSION),
      );

      // GET under the CURRENT version: fresh, not stale.
      const freshRead = await getLatestAssessment(propertyId, "condition", CONDITION_PROMPT_VERSION);
      expect(freshRead?.stale).toBe(false);

      // THE ACTUAL SKEW THIS FIXES: the prompt bumps to a newer version (the
      // module constant a real flow would now use as "current"), but nobody
      // has recomputed under it yet — only the current row exists. The pre-#30
      // behaviour filtered strictly by the current version, so this would
      // find NOTHING and 404 even though a real (now-stale) verdict exists.
      // getLatestAssessment must still find the existing row, marked stale.
      // `-next` is derived from the constant so this stays correct across real
      // prompt-version bumps (e.g. #313's v1 -> v2), rather than hardcoding a
      // literal that eventually collides with CONDITION_PROMPT_VERSION.
      const bumpedVersion = `${CONDITION_PROMPT_VERSION}-next`;
      const beforeRecompute = await getLatestAssessment(propertyId, "condition", bumpedVersion);
      expect(beforeRecompute).not.toBeNull();
      expect(beforeRecompute?.prompt_version).toBe(CONDITION_PROMPT_VERSION);
      expect(beforeRecompute?.stale).toBe(true);

      // Simulate a prompt bump: caller now asks with a newer version string,
      // and its own save() writes that same new version (real usage: both
      // come from the SAME flow constant, e.g. CONDITION_PROMPT_VERSION).
      const afterBump = await getOrCompute(
        propertyId,
        "condition",
        bumpedVersion,
        listings,
        computeFn,
        (pid, result, model, contentHash) =>
          saveAtVersion(pid, result, model, contentHash, bumpedVersion),
      );
      expect(afterBump.fromCache).toBe(false);
      expect(computeFn).toHaveBeenCalledTimes(2);

      // The v1 row is still there — GET under v1 must show it, marked stale
      // relative to v2 (this is the fix for the issue's "v1 badge next to a
      // 404" skew: GET never disappears a row just because the current
      // version moved on).
      const oldRead = await getLatestAssessment(propertyId, "condition", bumpedVersion);
      // Latest-per-axis picks the NEWEST generated_at — that's now the v2 row.
      expect(oldRead?.prompt_version).toBe(bumpedVersion);
      expect(oldRead?.stale).toBe(false);

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'condition'`,
        [propertyId],
      );
      // Both versions kept as distinct rows (UNIQUE includes prompt_version).
      expect(Number(rows[0].n)).toBe(2);
    });
  });

  it("stampede guard: two concurrent getOrCompute calls for the same key produce exactly ONE LLM call (#30 review, also-fix)", async () => {
    // This is a real-DB-only claim by nature: the advisory lock IS a Postgres
    // feature, so cache.test.ts's mocked `sql` cannot exercise it — only this
    // integration test can prove two truly concurrent calls serialize instead
    // of both observing a miss (confirmed empirically as broken before this
    // fix: `getOrCompute` was a plain read-then-write with no lock at all).
    await withRealDb(async (pool) => {
      const propertyId = await seedProperty(pool);
      const listings: ListingSnapshot[] = [
        { listingId: 1, description: "a reformar, necesita instalaciones" },
      ];
      let callCount = 0;
      const computeFn = vi.fn().mockImplementation(async () => {
        callCount++;
        // Simulate LLM latency so both concurrent calls are genuinely
        // in-flight at once, not accidentally serialized by Node's own
        // single-threaded event loop finishing the first call instantly.
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { result: parseConditionResult(A_REFORMAR), model: "test-model" };
      });

      const [a, b] = await Promise.all([
        getOrCompute(
          propertyId,
          "condition",
          CONDITION_PROMPT_VERSION,
          listings,
          computeFn,
          saveConditionAssessment,
        ),
        getOrCompute(
          propertyId,
          "condition",
          CONDITION_PROMPT_VERSION,
          listings,
          computeFn,
          saveConditionAssessment,
        ),
      ]);

      expect(callCount).toBe(1); // the whole point of the lock
      expect([a.fromCache, b.fromCache].sort()).toEqual([false, true]);

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'condition'`,
        [propertyId],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });
});
