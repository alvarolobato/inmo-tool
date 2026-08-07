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
import { getTrendingCandidateTypes, getPromotionCandidates } from "../redflag-candidates";

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

// ─── Fase 8 (#399): getPromotionCandidates — real Postgres ───────────────────

const PNONCE = `p${Date.now().toString(36)}`;
const P_SV = `servidumbre_${PNONCE}`; // over threshold, has definition + evidence
const P_HU = `humedad_${PNONCE}`; // exactly at threshold
const P_ONCE = `una_vez_${PNONCE}`; // below threshold

/** Build N `other` flags with candidate_type, candidate_definition and evidence. */
function otherFlagsRich(slug: string, n: number, definition: string) {
  return Array.from({ length: n }, (_, i) => ({
    type: "other",
    description: `problema ${i}`,
    evidence: `${slug} cita ${i}`,
    evidence_source: "fotocasa",
    candidate_type: slug,
    candidate_definition: definition,
  }));
}

describe.runIf(dbAvailable)("getPromotionCandidates — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdPropertyIds: number[] = [];
  let createdProfileIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
    createdProfileIds = [];
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [
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

  async function seedRow(
    pool: Pool,
    flags: unknown[],
    address: string,
  ): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type) VALUES ($1, 'piso') RETURNING id`,
      [address],
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);
    await pool.query(
      `INSERT INTO ai_assessment
          (property_id, assessment_type, result, confidence, model, prompt_version, generated_at)
       VALUES ($1, 'redflags', $2::jsonb, 0.8, 'test-model', 'redflags/v8', NOW())`,
      [propertyId, JSON.stringify({ flags, confidence: 0.8, reasoning: "x" })],
    );
    return propertyId;
  }

  const mine = (rows: { candidateType: string }[]) =>
    rows.filter((r) => r.candidateType.endsWith(PNONCE));

  it("groups by slug, threshold-filters, and returns count + definition + evidence + properties", async () => {
    await withRealDb(async (pool) => {
      // A profile so the property ref can carry a deep-link profileId.
      const { rows: pr } = await pool.query<{ id: number }>(
        `INSERT INTO search_profile (name, scope, thesis_params) VALUES ($1, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
        [`Perfil ${PNONCE}`],
      );
      const profileId = Number(pr[0].id);
      createdProfileIds.push(profileId);

      const svProp = await seedRow(
        pool,
        otherFlagsRich(P_SV, 6, "Un tercero tiene derecho de paso por la finca."),
        `Calle Servidumbre ${PNONCE}`,
      );
      await pool.query(
        `INSERT INTO profile_listing_state (profile_id, property_id) VALUES ($1, $2)`,
        [profileId, svProp],
      );
      await seedRow(pool, otherFlagsRich(P_HU, 5, "Manchas de humedad estructural."), `Calle Humedad ${PNONCE}`);
      await seedRow(pool, otherFlagsRich(P_ONCE, 1, "algo raro"), `Calle Una Vez ${PNONCE}`);

      const rows = await getPromotionCandidates({ threshold: 5, limit: 100 });
      const ours = mine(rows);

      // P_SV(6) and P_HU(5) clear threshold 5; P_ONCE(1) is filtered out.
      expect(ours.map((r) => r.candidateType)).toEqual([P_SV, P_HU]);

      const sv = ours.find((r) => r.candidateType === P_SV)!;
      expect(sv.count).toBe(6);
      expect(sv.definition).toBe("Un tercero tiene derecho de paso por la finca.");
      // Up to 3 example evidence quotes, all belonging to this slug.
      expect(sv.evidence.length).toBeGreaterThan(0);
      expect(sv.evidence.length).toBeLessThanOrEqual(3);
      for (const q of sv.evidence) expect(q).toContain(P_SV);
      // The single property, deep-linkable via the seeded profile.
      expect(sv.properties).toHaveLength(1);
      expect(sv.properties[0].id).toBe(svProp);
      expect(sv.properties[0].address).toBe(`Calle Servidumbre ${PNONCE}`);
      expect(sv.properties[0].profileId).toBe(profileId);

      // P_HU has no profile_listing_state → profileId null (page shows no link).
      const hu = ours.find((r) => r.candidateType === P_HU)!;
      expect(hu.count).toBe(5);
      expect(hu.properties[0].profileId).toBeNull();
    });
  });

  it("empty case: an unreachable threshold yields [] (cold-start empty state)", async () => {
    await withRealDb(async (pool) => {
      await seedRow(pool, otherFlagsRich(P_SV, 6, "def"), `Calle X ${PNONCE}`);
      const rows = await getPromotionCandidates({ threshold: 999999, limit: 100 });
      expect(mine(rows)).toEqual([]);
    });
  });
});
