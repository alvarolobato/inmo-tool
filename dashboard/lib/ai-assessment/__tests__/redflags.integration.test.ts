/**
 * Red-flags persistence — real-Postgres integration test (#27).
 *
 * Mirrors occupancy.integration.test.ts (#25) and condition.integration.test.ts
 * (#26): proves the property-keyed uniqueness invariant (one merged property
 * → one `ai_assessment` row for assessment_type='redflags'), that re-running
 * updates in place, and that the row survives a real INSERT against the
 * live `assessment_type` CHECK constraint — not just `parseRedFlagsResult()`
 * in isolation, which would pass regardless of whether 'redflags' were ever
 * added to the CHECK list.
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
  saveRedFlagsAssessment,
  getRedFlagsAssessment,
  parseRedFlagsResult,
  assessPropertyRedFlags,
  NoListingsError,
  REDFLAGS_PROMPT_VERSION,
} from "../redflags";

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
        "REQUIRE_DB=1 but Postgres is unreachable for redflags.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[redflags.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const HERENCIA_FLAG = JSON.stringify({
  flags: [
    {
      type: "herencia_yacente",
      description: "Verificar si la herencia está formalmente aceptada y partida.",
      evidence: "se vende por herencia yacente, pendiente de partición",
      evidence_source: "milanuncios",
    },
  ],
  confidence: 0.85,
  reasoning: "El anuncio declara una herencia sin resolver.",
});

const CLEAN = JSON.stringify({
  flags: [],
  confidence: 0.8,
  reasoning: "Ningún riesgo mencionado.",
});

describe.runIf(dbAvailable)("redflags persistence — real Postgres", () => {
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

  /** One property with two active adverts, only one disclosing the inheritance. */
  async function seedMergedProperty(pool: Pool): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type, m2_built, rooms)
       VALUES ('Calle Test Redflags 1', 'piso', 90, 3) RETURNING id`,
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);

    const adverts: [string, string, string][] = [
      ["fotocasa", "rf-int-a", "Piso luminoso de 90 m2. Tres dormitorios."],
      [
        "milanuncios",
        "rf-int-b",
        "Se vende por herencia yacente, pendiente de partición. Urge venta.",
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

  it("TWO merged listings produce exactly ONE redflags assessment row", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);

      await saveRedFlagsAssessment(propertyId, parseRedFlagsResult(HERENCIA_FLAG), "test-model");

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'redflags'`,
        [propertyId],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it("re-running UPDATES the verdict in place rather than appending a second", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);

      await saveRedFlagsAssessment(propertyId, parseRedFlagsResult(HERENCIA_FLAG), "model-a");
      await saveRedFlagsAssessment(propertyId, parseRedFlagsResult(CLEAN), "model-b");

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'redflags'`,
        [propertyId],
      );
      expect(Number(rows[0].n)).toBe(1);

      const cached = await getRedFlagsAssessment(propertyId);
      expect(cached?.result.flags).toEqual([]);
      expect(cached?.model).toBe("model-b");
    });
  });

  it("round-trips the full result through JSONB unchanged, including per-flag evidence_source", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);
      const written = parseRedFlagsResult(HERENCIA_FLAG);

      await saveRedFlagsAssessment(propertyId, written, "test-model");
      const cached = await getRedFlagsAssessment(propertyId);

      expect(cached).not.toBeNull();
      expect(cached!.result).toEqual(written);
      expect(cached!.result.flags[0].type).toBe("herencia_yacente");
      expect(cached!.result.flags[0].evidence_source).toBe("milanuncios");

      const { rows } = await pool.query<{ confidence: string; prompt_version: string }>(
        `SELECT confidence, prompt_version FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'redflags'`,
        [propertyId],
      );
      expect(Number(rows[0].confidence)).toBeCloseTo(0.85, 3);
      expect(rows[0].prompt_version).toBe(REDFLAGS_PROMPT_VERSION);
    });
  });

  it("the assessment_type CHECK constraint accepts 'redflags' (real INSERT, not just parseRedFlagsResult())", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);
      await expect(
        saveRedFlagsAssessment(propertyId, parseRedFlagsResult(HERENCIA_FLAG), "test-model"),
      ).resolves.not.toThrow();
    });
  });

  it("an empty flags array round-trips as an empty array (not null, not omitted)", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);
      await saveRedFlagsAssessment(propertyId, parseRedFlagsResult(CLEAN), "test-model");

      const cached = await getRedFlagsAssessment(propertyId);
      expect(cached!.result.flags).toEqual([]);
    });
  });

  it("returns null for a property that was never assessed", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);
      expect(await getRedFlagsAssessment(propertyId)).toBeNull();
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

    it("produces a persisted (empty) redflags verdict with no LLM stubbing", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await seedMergedProperty(pool);

        const result = await assessPropertyRedFlags(propertyId);

        // The mock's clean-case canned response — see lib/llm-provider/mock/script.ts.
        expect(result.flags).toEqual([]);
        expect(result.confidence).toBeGreaterThan(0);

        const cached = await getRedFlagsAssessment(propertyId);
        expect(cached).not.toBeNull();
        expect(cached!.result).toEqual(result);

        const { rows } = await pool.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM ai_assessment
            WHERE property_id = $1 AND assessment_type = 'redflags'`,
          [propertyId],
        );
        expect(Number(rows[0].n)).toBe(1);
      });
    });

    it("refuses to record a verdict for a property with nothing to read", async () => {
      await withRealDb(async (pool) => {
        const { rows } = await pool.query<{ id: number }>(
          `INSERT INTO property (address, property_type)
           VALUES ('Calle Sin Anuncios Redflags', 'piso') RETURNING id`,
        );
        const propertyId = Number(rows[0].id);
        createdPropertyIds.push(propertyId);

        await expect(assessPropertyRedFlags(propertyId)).rejects.toThrow(NoListingsError);
        expect(await getRedFlagsAssessment(propertyId)).toBeNull();
      });
    });
  });
});
