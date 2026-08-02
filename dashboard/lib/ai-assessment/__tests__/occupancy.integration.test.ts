/**
 * Occupancy persistence — real-Postgres integration test (#25).
 *
 * The one thing worth proving against a real database rather than a mock:
 * a property with THREE merged listings yields exactly ONE `ai_assessment`
 * row, and re-running the assessment updates that row instead of appending
 * a second. That is the entire point of the listing_id → property_id re-key,
 * and no amount of mocking `sql()` can catch a unique constraint that was
 * never actually created (the DDL lives in init.sql, not in TypeScript).
 *
 * It also exercises `loadPropertyListings()` against the real schema — a
 * column rename or a status filter regression shows up here and nowhere else.
 *
 * Cleanup is scoped to exact IDs this file creates, never a broad scan:
 * vitest runs test files in separate workers against the same live Postgres,
 * so a table-wide delete here can race with unrelated integration files.
 * (Same rationale as candidates.integration.test.ts — see its header.)
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import {
  loadPropertyListings,
  saveOccupancyAssessment,
  getOccupancyAssessment,
  parseOccupancyResult,
  OCCUPANCY_PROMPT_VERSION,
} from "../occupancy";

async function withRealDb(fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[occupancy.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const TENANTED = JSON.stringify({
  occupancy: {
    status: "tenanted",
    confidence: 0.9,
    evidence: "se vende con inquilino",
    evidence_source: "milanuncios",
  },
  transaction: { kind: "compraventa", confidence: 0.8 },
  ownership: { extent: "pleno_dominio", confidence: 0.7, share_pct: null },
  reasoning: "Un anuncio declara inquilino.",
});

const VACANT = JSON.stringify({
  occupancy: {
    status: "vacant",
    confidence: 0.5,
    evidence: "libre de inquilinos",
    evidence_source: "fotocasa",
  },
  transaction: { kind: "compraventa", confidence: 0.8 },
  ownership: { extent: "pleno_dominio", confidence: 0.7, share_pct: null },
  reasoning: "Revisado tras nueva información.",
});

describe.runIf(dbAvailable)("occupancy persistence — real Postgres", () => {
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
      // ai_assessment first: no ON DELETE CASCADE, deliberately.
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

  /** One property with three active adverts across three portals. */
  async function seedMergedProperty(pool: Pool): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type, m2_built, rooms)
       VALUES ('Calle Test Ocupacion 1', 'piso', 90, 3) RETURNING id`,
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);

    const adverts: [string, string, string][] = [
      ["fotocasa", "occ-int-a", "Piso luminoso de 90 m2. Tres dormitorios."],
      ["milanuncios", "occ-int-b", "Se vende con inquilino, rentabilidad garantizada."],
      ["idealista", "occ-int-c", "Vivienda en la zona. Consultar condiciones."],
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

  it("loads every ACTIVE advert of the property, and no inactive one", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);
      // A withdrawn advert describes a state of the world that may no longer
      // hold — it must not be fed to the model as current evidence.
      await pool.query(
        `INSERT INTO listing
            (property_id, source, external_id, status, operation, current_price, description)
         VALUES ($1, 'fotocasa', 'occ-int-dead', 'withdrawn', 'sale', 200000, $2)`,
        [propertyId, "ANUNCIO RETIRADO - no debe aparecer"],
      );

      const listings = await loadPropertyListings(propertyId);

      expect(listings).toHaveLength(3);
      expect(listings.every((l) => l.propertyId === propertyId)).toBe(true);
      const descriptions = listings.map((l) => l.description ?? "").join("\n");
      expect(descriptions).toContain("Se vende con inquilino");
      expect(descriptions).not.toContain("ANUNCIO RETIRADO");
      // Property-level facts are joined onto every advert.
      expect(listings.every((l) => l.m2Built === 90)).toBe(true);
    });
  });

  it("returns no listings for a property that has none", async () => {
    await withRealDb(async (pool) => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO property (address, property_type)
         VALUES ('Calle Sin Anuncios 2', 'piso') RETURNING id`,
      );
      const propertyId = Number(rows[0].id);
      createdPropertyIds.push(propertyId);

      expect(await loadPropertyListings(propertyId)).toEqual([]);
    });
  });

  it("THREE merged listings produce exactly ONE assessment row", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);

      await saveOccupancyAssessment(propertyId, parseOccupancyResult(TENANTED), "test-model");

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'occupancy'`,
        [propertyId],
      );
      // Under the old listing_id key this would legitimately have been 3.
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it("re-running UPDATES the verdict in place rather than appending a second", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);

      await saveOccupancyAssessment(propertyId, parseOccupancyResult(TENANTED), "model-a");
      await saveOccupancyAssessment(propertyId, parseOccupancyResult(VACANT), "model-b");

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'occupancy'`,
        [propertyId],
      );
      expect(Number(rows[0].n)).toBe(1);

      const cached = await getOccupancyAssessment(propertyId);
      expect(cached?.result.occupancy.value).toBe("vacant");
      expect(cached?.model).toBe("model-b");
    });
  });

  it("round-trips the full three-axis result through JSONB unchanged", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);
      const written = parseOccupancyResult(TENANTED);

      await saveOccupancyAssessment(propertyId, written, "test-model");
      const cached = await getOccupancyAssessment(propertyId);

      expect(cached).not.toBeNull();
      // Every axis survives the trip, including the evidence trail that lets
      // an investor go back to the advert that justified the verdict.
      expect(cached!.result).toEqual(written);
      expect(cached!.result.occupancy.evidence_source).toBe("milanuncios");
      expect(cached!.result.caveats).toEqual(["tenanted"]);

      // The scalar `confidence` column mirrors the strongest flagged axis, so
      // SQL-level sorting/filtering agrees with the JSON.
      const { rows } = await pool.query<{ confidence: string; prompt_version: string }>(
        `SELECT confidence, prompt_version FROM ai_assessment
          WHERE property_id = $1 AND assessment_type = 'occupancy'`,
        [propertyId],
      );
      expect(Number(rows[0].confidence)).toBeCloseTo(0.9, 3);
      expect(rows[0].prompt_version).toBe(OCCUPANCY_PROMPT_VERSION);
    });
  });

  it("returns null for a property that was never assessed", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedMergedProperty(pool);
      expect(await getOccupancyAssessment(propertyId)).toBeNull();
    });
  });
});
