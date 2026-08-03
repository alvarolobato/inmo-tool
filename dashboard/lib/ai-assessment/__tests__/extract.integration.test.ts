/**
 * Extraction persistence — real-Postgres integration test (#28).
 *
 * Mirrors condition.integration.test.ts: the one thing worth proving against
 * a real database rather than a mock is that a property with multiple merged
 * listings yields exactly ONE `ai_assessment` row for assessment_type=
 * 'extract', that re-running updates it in place, that a real result survives
 * a real INSERT against the CHECK constraint (this repo's own cautionary
 * tale — a `property_type` CheckViolation reached `main` with 19 green tests
 * that only ever called normalize()), AND — the EC-3 cost-control claim,
 * which only means something against real property rows — that a property
 * with every relevant field already structured is skipped without an LLM
 * call, while a property missing even one field is not.
 *
 * Skips cleanly when no database is reachable, same REQUIRE_DB=1 contract as
 * the other three flows' integration tests.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { resetDashboardLlmConfigCache } from "@/lib/llm-provider/config";
import {
  saveExtractAssessment,
  getExtractAssessment,
  parseExtractResult,
  assessPropertyExtract,
  loadPropertyStructuredFields,
  NoListingsError,
  EXTRACT_PROMPT_VERSION,
} from "../extract";

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
        "REQUIRE_DB=1 but Postgres is unreachable for extract.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[extract.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const FULL_FACTS = JSON.stringify({
  m2_built: 85,
  m2_useful: null,
  rooms: 3,
  bathrooms: 2,
  floor: null,
  has_elevator: true,
  confidence_per_field: { m2_built: 0.9, rooms: 0.9, bathrooms: 0.85, has_elevator: 0.8 },
  reasoning: "El anuncio da metros, habitaciones, baños y ascensor.",
});

const DIFFERENT_FACTS = JSON.stringify({
  m2_built: 90,
  m2_useful: null,
  rooms: 4,
  bathrooms: 2,
  floor: null,
  has_elevator: false,
  confidence_per_field: { m2_built: 0.7, rooms: 0.7, bathrooms: 0.6, has_elevator: 0.6 },
  reasoning: "Segunda lectura.",
});

describe.runIf(dbAvailable)("extract persistence — real Postgres", () => {
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

  /** A property with two active adverts and NO structured m2/rooms/bathrooms/floor/elevator. */
  async function seedIncompleteProperty(pool: Pool): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type) VALUES ('Calle Test Extract 1', 'piso') RETURNING id`,
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);

    const adverts: [string, string, string][] = [
      ["fotocasa", "ext-int-a", "Piso luminoso muy bien situado, no dejes pasar la oportunidad."],
      [
        "milanuncios",
        "ext-int-b",
        "Piso de 85m2, 3 habitaciones, 2 baños, con ascensor. Particular.",
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

  /** A property whose structured fields are ALREADY fully populated. */
  async function seedCompleteProperty(pool: Pool): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type, m2_built, m2_useful, rooms, bathrooms, floor, has_elevator)
       VALUES ('Calle Test Extract Completa 1', 'piso', 90, 80, 3, 2, '2', true) RETURNING id`,
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);

    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, description)
       VALUES ($1, 'fotocasa', 'ext-complete-a', 'active', 'sale', 200000, 'Piso muy bonito.')`,
      [propertyId],
    );
    return propertyId;
  }

  it("TWO merged listings produce exactly ONE extract assessment row", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIncompleteProperty(pool);

      await saveExtractAssessment(propertyId, parseExtractResult(FULL_FACTS), "test-model");

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'extract'`,
        [propertyId],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it("re-running UPDATES the row in place rather than appending a second", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIncompleteProperty(pool);

      await saveExtractAssessment(propertyId, parseExtractResult(FULL_FACTS), "model-a");
      await saveExtractAssessment(propertyId, parseExtractResult(DIFFERENT_FACTS), "model-b");

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'extract'`,
        [propertyId],
      );
      expect(Number(rows[0].n)).toBe(1);

      const cached = await getExtractAssessment(propertyId);
      expect(cached?.result.rooms).toBe(4);
      expect(cached?.model).toBe("model-b");
    });
  });

  it("round-trips the full result through JSONB unchanged", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIncompleteProperty(pool);
      const written = parseExtractResult(FULL_FACTS);

      await saveExtractAssessment(propertyId, written, "test-model");
      const cached = await getExtractAssessment(propertyId);

      expect(cached).not.toBeNull();
      expect(cached!.result).toEqual(written);
      expect(cached!.stale).toBe(false);

      const { rows } = await pool.query<{ prompt_version: string }>(
        `SELECT prompt_version FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'extract'`,
        [propertyId],
      );
      expect(rows[0].prompt_version).toBe(EXTRACT_PROMPT_VERSION);
    });
  });

  it("the assessment_type CHECK constraint accepts 'extract' (real INSERT, not just normalize())", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIncompleteProperty(pool);
      await expect(
        saveExtractAssessment(propertyId, parseExtractResult(FULL_FACTS), "test-model"),
      ).resolves.not.toThrow();
    });
  });

  it("returns null for a property that was never assessed", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIncompleteProperty(pool);
      expect(await getExtractAssessment(propertyId)).toBeNull();
    });
  });

  it("loadPropertyStructuredFields reads the real property columns this flow gates on", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedCompleteProperty(pool);
      const fields = await loadPropertyStructuredFields(propertyId);
      expect(fields).toEqual({
        m2_built: 90,
        m2_useful: 80,
        rooms: 3,
        bathrooms: 2,
        floor: "2",
        has_elevator: true,
      });
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

    it("produces a persisted extraction with no LLM stubbing", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await seedIncompleteProperty(pool);

        const outcome = await assessPropertyExtract(propertyId);

        expect(outcome.skipped).toBe(false);
        if (!outcome.skipped) {
          expect(outcome.result.rooms).toBe(3);
          expect(outcome.result.m2_built).toBe(90);
        }

        const cached = await getExtractAssessment(propertyId);
        expect(cached).not.toBeNull();

        const { rows } = await pool.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM ai_assessment
            WHERE property_id = $1 AND assessment_type = 'extract'`,
          [propertyId],
        );
        expect(Number(rows[0].n)).toBe(1);
      });
    });

    it("EC-3: skips the LLM call entirely for a property that already has every field (cost control)", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await seedCompleteProperty(pool);

        const outcome = await assessPropertyExtract(propertyId);

        expect(outcome.skipped).toBe(true);
        // No row should have been written — nothing was computed or persisted.
        expect(await getExtractAssessment(propertyId)).toBeNull();
      });
    });

    it("refuses to record an extraction for a property with nothing to read", async () => {
      await withRealDb(async (pool) => {
        const { rows } = await pool.query<{ id: number }>(
          `INSERT INTO property (address, property_type)
           VALUES ('Calle Sin Anuncios Extract', 'piso') RETURNING id`,
        );
        const propertyId = Number(rows[0].id);
        createdPropertyIds.push(propertyId);

        await expect(assessPropertyExtract(propertyId)).rejects.toThrow(NoListingsError);
        expect(await getExtractAssessment(propertyId)).toBeNull();
      });
    });
  });
});
