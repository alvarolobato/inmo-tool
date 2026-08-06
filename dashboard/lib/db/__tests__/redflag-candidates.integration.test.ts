/**
 * Trending `other`-flag candidates — real-Postgres integration test (#396).
 *
 * Proves the aggregation `getTrendingCandidateTypes` runs against a live
 * Postgres: it unnests each redflags row's `result->'flags'`, keeps only
 * evidenced `other` flags carrying a non-empty `candidate_type`, GROUPs BY the
 * slug, applies the minimum-count threshold, orders by count desc, and honours
 * the LIMIT. Unit-mocking Postgres would test none of that JSON-path SQL — the
 * exact class of bug (a mistyped `->>` or a LATERAL that errors on a non-array
 * `flags`) only shows up against a real engine.
 *
 * Seeds slugs with a per-run nonce so a shared/dirty test DB cannot collide,
 * and uses dominating counts so LIMIT/ordering assertions stay deterministic.
 * Skips cleanly when no database is reachable (same REQUIRE_DB=1 contract as the
 * other *.integration.test.ts files).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { getTrendingCandidateTypes } from "../redflag-candidates";

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
        "REQUIRE_DB=1 but Postgres is unreachable for redflag-candidates.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[redflag-candidates.integration.test] no reachable Postgres — skipping real-DB tests.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

// Per-run nonce so slugs don't collide with any pre-existing data.
const NONCE = `t${Date.now().toString(36)}`;
const SV = `servidumbre_paso_${NONCE}`; // dominating count
const RU = `ruido_excesivo_${NONCE}`; // middle count
const TH = `humedad_${NONCE}`; // lowest qualifying count
const ONCE = `solo_una_vez_${NONCE}`; // below threshold

/** Build a redflags `result` JSON with N `other` flags of the given slug. */
function otherFlags(slug: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: "other",
    description: `problema ${i}`,
    evidence: `cita ${i}`,
    evidence_source: "fotocasa",
    candidate_type: slug,
  }));
}

describe.runIf(dbAvailable)("getTrendingCandidateTypes — real Postgres", () => {
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
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
    });
  });

  async function seedRedflagsRow(
    pool: Pool,
    flags: unknown[],
    promptVersion: string,
  ): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type) VALUES ($1, 'piso') RETURNING id`,
      [`Calle Trending ${createdPropertyIds.length}`],
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);
    await pool.query(
      `INSERT INTO ai_assessment
          (property_id, assessment_type, result, confidence, model, prompt_version, generated_at)
       VALUES ($1, 'redflags', $2::jsonb, 0.8, 'test-model', $3, NOW())`,
      [propertyId, JSON.stringify({ flags, confidence: 0.8, reasoning: "x" }), promptVersion],
    );
    return propertyId;
  }

  /** Seed the standard mix: SV=20, RU=15, TH=10, ONCE=1, plus noise rows. */
  async function seedStandardMix(pool: Pool): Promise<void> {
    await seedRedflagsRow(pool, otherFlags(SV, 20), "redflags/v6");
    await seedRedflagsRow(pool, otherFlags(RU, 15), "redflags/v6");
    await seedRedflagsRow(pool, otherFlags(TH, 10), "redflags/v6");
    await seedRedflagsRow(pool, otherFlags(ONCE, 1), "redflags/v6");
    // Noise that must NOT be counted:
    // - a named flag with no candidate_type
    // - an `other` with an empty candidate_type
    // - a clean row (empty flags array) — also exercises the non-empty-array path
    await seedRedflagsRow(
      pool,
      [
        {
          type: "herencia_yacente",
          description: "d",
          evidence: "e",
          evidence_source: null,
        },
        { type: "other", description: "d", evidence: "e", evidence_source: null, candidate_type: "" },
      ],
      "redflags/v5",
    );
    await seedRedflagsRow(pool, [], "redflags/v6");
  }

  const mine = (rows: { candidateType: string; count: number }[]) =>
    rows.filter((r) => r.candidateType.endsWith(NONCE));

  it("groups by slug, counts occurrences, and orders by count desc (threshold 2)", async () => {
    await withRealDb(async (pool) => {
      await seedStandardMix(pool);
      const rows = await getTrendingCandidateTypes({ limit: 50, minCount: 2 });
      const ours = mine(rows);
      // SV(20) > RU(15) > TH(10); ONCE(1) filtered by the >=2 threshold; the
      // named flag, the empty-slug `other`, and the clean row contribute nothing.
      expect(ours).toEqual([
        { candidateType: SV, count: 20 },
        { candidateType: RU, count: 15 },
        { candidateType: TH, count: 10 },
      ]);
    });
  });

  it("the minimum-count threshold excludes slugs seen fewer than `minCount` times", async () => {
    await withRealDb(async (pool) => {
      await seedStandardMix(pool);
      const rows = await getTrendingCandidateTypes({ limit: 50, minCount: 16 });
      // Only SV(20) clears a threshold of 16; RU/TH/ONCE fall below it.
      expect(mine(rows)).toEqual([{ candidateType: SV, count: 20 }]);
    });
  });

  it("honours LIMIT — the dominating counts guarantee the global top-2 are SV then RU", async () => {
    await withRealDb(async (pool) => {
      await seedStandardMix(pool);
      const rows = await getTrendingCandidateTypes({ limit: 2, minCount: 2 });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.candidateType)).toEqual([SV, RU]);
    });
  });

  it("empty case: an unreachable threshold yields [] (the normal cold-start state)", async () => {
    await withRealDb(async (pool) => {
      await seedStandardMix(pool);
      const rows = await getTrendingCandidateTypes({ limit: 50, minCount: 999999 });
      expect(rows).toEqual([]);
    });
  });
});
