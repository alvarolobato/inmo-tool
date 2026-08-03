/**
 * Condition persistence — real-Postgres integration test (#26).
 *
 * Mirrors occupancy.integration.test.ts (#25): the one thing worth proving
 * against a real database rather than a mock is that a property with
 * multiple merged listings yields exactly ONE `ai_assessment` row for
 * assessment_type='condition', that re-running updates it in place, and that
 * a `normalize()`-shaped result actually survives a real INSERT (this
 * repo's CHECK-violation history — a `property_type` CheckViolation reached
 * `main` with 19 green tests that only ever called `normalize()` — is
 * exactly the failure mode this guards against for `assessment_type`).
 *
 * Skips cleanly when no database is reachable, same REQUIRE_DB=1 contract as
 * occupancy's integration test.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { resetDashboardLlmConfigCache } from "@/lib/llm-provider/config";
import {
  saveConditionAssessment,
  getConditionAssessment,
  parseConditionResult,
  assessPropertyCondition,
  NoListingsError,
  CONDITION_PROMPT_VERSION,
  CONDITION_CATEGORIES,
} from "../condition";

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
        "REQUIRE_DB=1 but Postgres is unreachable for condition.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[condition.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
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
  issues: ["instalación eléctrica antigua", "baño a renovar"],
  evidence: "a reformar, necesita actualización de instalaciones y baño",
  evidence_source: "milanuncios",
  reasoning: "El anuncio pide reforma de instalaciones y baño.",
});

const REFORMADO = JSON.stringify({
  condition: "reformado",
  confidence: 0.9,
  issues: [],
  evidence: "totalmente reformado en 2024",
  evidence_source: "fotocasa",
  reasoning: "Reforma reciente declarada.",
});

describe.runIf(dbAvailable)("condition persistence — real Postgres", () => {
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
      await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [
        createdPropertyIds,
      ]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [
        createdPropertyIds,
      ]);
    });
  });

  /** One property with two active adverts, only one mentioning renovation. */
  async function seedMergedProperty(pool: Pool): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type, m2_built, rooms)
       VALUES ('Calle Test Condicion 1', 'piso', 90, 3) RETURNING id`,
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);

    const adverts: [string, string, string][] = [
      ["fotocasa", "cond-int-a", "Piso luminoso de 90 m2. Tres dormitorios."],
      [
        "milanuncios",
        "cond-int-b",
        "A reformar, necesita actualización de instalaciones y baño.",
      ],
    ];
    for (const [source, externalId, description] of adverts) {
      await pool.query(
        `INSERT INTO listing
            (property_id, source, external_id, status, operation, current_price, description)
         VALUES ($1, $2, $3, 'active', 'sale', 200000, $4)`,
        [propertyId, source, externalId, description],
      );
    }
    return propertyId;
  }

  it("TWO merged listings produce exactly ONE condition assessment row", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);

      await saveConditionAssessment(propertyId, parseConditionResult(A_REFORMAR), "test-model");

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'condition'`,
        [propertyId],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it("re-running UPDATES the verdict in place rather than appending a second", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);

      await saveConditionAssessment(propertyId, parseConditionResult(A_REFORMAR), "model-a");
      await saveConditionAssessment(propertyId, parseConditionResult(REFORMADO), "model-b");

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'condition'`,
        [propertyId],
      );
      expect(Number(rows[0].n)).toBe(1);

      const cached = await getConditionAssessment(propertyId);
      expect(cached?.result.condition).toBe("reformado");
      expect(cached?.model).toBe("model-b");
    });
  });

  it("round-trips the full result through JSONB unchanged, and the scalar confidence column matches", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);
      const written = parseConditionResult(A_REFORMAR);

      await saveConditionAssessment(propertyId, written, "test-model");
      const cached = await getConditionAssessment(propertyId);

      expect(cached).not.toBeNull();
      expect(cached!.result).toEqual(written);
      expect(cached!.result.issues).toEqual(
        expect.arrayContaining(["instalación eléctrica antigua", "baño a renovar"]),
      );

      const { rows } = await pool.query<{ confidence: string; prompt_version: string }>(
        `SELECT confidence, prompt_version FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'condition'`,
        [propertyId],
      );
      expect(Number(rows[0].confidence)).toBeCloseTo(0.85, 3);
      expect(rows[0].prompt_version).toBe(CONDITION_PROMPT_VERSION);
    });
  });

  it("the assessment_type CHECK constraint accepts 'condition' (real INSERT, not just normalize())", async () => {
    // This repo's own cautionary tale: a `property_type` CheckViolation
    // reached `main` with 19 green tests because they all called
    // normalize() and never actually INSERTed. Proving the CHECK constraint
    // accepts our value requires hitting the real constraint.
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);
      await expect(
        saveConditionAssessment(propertyId, parseConditionResult(A_REFORMAR), "test-model"),
      ).resolves.not.toThrow();
    });
  });

  it("returns null for a property that was never assessed", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);
      expect(await getConditionAssessment(propertyId)).toBeNull();
    });
  });

  describe("full chain through the mock provider", () => {
    beforeEach(() => {
      vi.stubEnv("DASHBOARD_LLM_PROVIDER", "mock");
      resetDashboardLlmConfigCache();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      resetDashboardLlmConfigCache();
    });

    it("produces a persisted condition verdict with no LLM stubbing", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await seedMergedProperty(pool);

        const result = await assessPropertyCondition(propertyId);

        expect(CONDITION_CATEGORIES).toContain(result.condition);
        // Pins the mock's actual verdict — if the mock regresses to the flow
        // falling through to the `chat` script, this fails loudly (prose is
        // not valid JSON matching this shape).
        expect(result.condition).toBe("reformado");
        expect(result.confidence).toBeGreaterThan(0);

        const cached = await getConditionAssessment(propertyId);
        expect(cached).not.toBeNull();
        expect(cached!.result).toEqual(result);

        const { rows } = await pool.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM ai_assessment
            WHERE property_id = $1 AND assessment_type = 'condition'`,
          [propertyId],
        );
        expect(Number(rows[0].n)).toBe(1);
      });
    });

    it("refuses to record a verdict for a property with nothing to read", async () => {
      await withRealDb(async (pool) => {
        const { rows } = await pool.query<{ id: number }>(
          `INSERT INTO property (address, property_type)
           VALUES ('Calle Sin Anuncios Condicion', 'piso') RETURNING id`,
        );
        const propertyId = Number(rows[0].id);
        createdPropertyIds.push(propertyId);

        await expect(assessPropertyCondition(propertyId)).rejects.toThrow(NoListingsError);
        expect(await getConditionAssessment(propertyId)).toBeNull();
      });
    });
  });
});
