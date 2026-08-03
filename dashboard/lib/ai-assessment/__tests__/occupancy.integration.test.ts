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
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { resetDashboardLlmConfigCache } from "@/lib/llm-provider/config";
import {
  loadPropertyListings,
  saveOccupancyAssessment,
  getOccupancyAssessment,
  parseOccupancyResult,
  assessPropertyOccupancy,
  NoListingsError,
  OCCUPANCY_PROMPT_VERSION,
  OCCUPANCY_STATUSES,
  TRANSACTION_KINDS,
  OWNERSHIP_EXTENTS,
} from "../occupancy";

async function withRealDb(fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

// #156 review, must-fix 4 (source-side half): CI's `dashboard-test` job has no
// `postgres` service, so this file's 8 tests have been silently skipping and
// reporting green — the workflow-file fix is proposed separately (can't be
// pushed from here, see D-004 / docs/pending-workflow-changes/). REQUIRE_DB=1
// (CI should set it once the service is wired in) turns "no reachable
// Postgres" from a quiet skip into a hard failure, so a future regression in
// the workflow file (a dropped `services:` block) trips CI immediately
// instead of reverting to silent green.
const REQUIRE_DB = process.env.REQUIRE_DB === "1";

const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    if (REQUIRE_DB) {
      throw new Error(
        "REQUIRE_DB=1 but Postgres is unreachable for occupancy.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
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

  /**
   * The whole chain, with nothing in the middle stubbed: real Postgres →
   * loadPropertyListings → assessOccupancy → the REAL llm-context assembly →
   * the mock LLM provider → parseOccupancyResult → real Postgres.
   *
   * `llm-context` is deliberately NOT mocked. Mocking it would delete the two
   * seams this is here to protect, both of which every other test in the repo
   * is blind to:
   *
   *  1. `detectMockFlow()` recognises the occupancy flow by matching a literal
   *     Spanish task heading against the assembled system prompt. Reword that
   *     heading in system-prompt.ts and the mock silently falls through to the
   *     `chat` script — which returns prose, not JSON. Only a run that builds
   *     the real prompt and feeds it to the real provider notices.
   *  2. The mock's canned verdict and `parseOccupancyResult` are otherwise
   *     asserted only against hand-written fixtures on each side — the mock
   *     with a raw `JSON.parse`, the parser with its own literals. Nothing
   *     connected the two, so the mock could keep emitting the pre-#145 flat
   *     `{status, confidence}` shape and every unit test would stay green
   *     while every e2e verdict silently degraded to `unknown`.
   */
  describe("full chain through the mock provider", () => {
    beforeEach(() => {
      // env > config.yaml > default, so this beats a developer's local
      // config.yaml. The cache reset matters because loadDashboardLlmConfig()
      // memoises the provider: without it this inherits whichever provider an
      // earlier test resolved, and a stale `cli` would spawn a real `claude`.
      vi.stubEnv("DASHBOARD_LLM_PROVIDER", "mock");
      resetDashboardLlmConfigCache();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      resetDashboardLlmConfigCache();
    });

    it("produces a persisted three-axis verdict with no LLM stubbing", async () => {
      await withRealDb(async (pool) => {
        const propertyId = await seedMergedProperty(pool);

        const result = await assessPropertyOccupancy(propertyId);

        // Structured three-axis shape — this is the assertion that fails loudly
        // if the mock regresses to the flat pre-#145 `result.status`.
        expect(OCCUPANCY_STATUSES).toContain(result.occupancy.value);
        expect(TRANSACTION_KINDS).toContain(result.transaction.value);
        expect(OWNERSHIP_EXTENTS).toContain(result.ownership.value);

        // A `chat`-script fallthrough returns prose, which parseOccupancyResult
        // would either throw on or degrade to unknown/0. Pinning the mock's
        // actual verdict catches the silent-degradation direction too.
        expect(result.occupancy.value).toBe("vacant");
        expect(result.occupancy.confidence).toBeGreaterThan(0);
        expect(result.occupancy.evidence_source).toBe("fotocasa");

        // Derived in code from the axes, never model-authored: a clean property
        // carries no badge.
        expect(result.caveats).toEqual([]);

        // And it reached the database through the real writer.
        const cached = await getOccupancyAssessment(propertyId);
        expect(cached).not.toBeNull();
        expect(cached!.result).toEqual(result);

        const { rows } = await pool.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM ai_assessment
            WHERE property_id = $1 AND assessment_type = 'occupancy'`,
          [propertyId],
        );
        expect(Number(rows[0].n)).toBe(1);
      });
    });

    it("refuses to record a verdict for a property with nothing to read", async () => {
      await withRealDb(async (pool) => {
        const { rows } = await pool.query<{ id: number }>(
          `INSERT INTO property (address, property_type)
           VALUES ('Calle Sin Anuncios 3', 'piso') RETURNING id`,
        );
        const propertyId = Number(rows[0].id);
        createdPropertyIds.push(propertyId);

        // "We never looked" must not be written as "we looked and could not
        // tell" — an `unknown` row here would be indistinguishable downstream.
        await expect(assessPropertyOccupancy(propertyId)).rejects.toThrow(
          NoListingsError,
        );
        expect(await getOccupancyAssessment(propertyId)).toBeNull();
      });
    });
  });
});
