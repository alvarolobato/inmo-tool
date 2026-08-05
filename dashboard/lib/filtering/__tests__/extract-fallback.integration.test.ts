/**
 * Real-Postgres integration tests for the #28 extract-row FALLBACK wired into
 * the hard-filter engine (issue #182). These exercise the exact class of bug
 * a mocked `client.query` can't: whether the generated COALESCE + confidence
 * gate actually resolves against real `ai_assessment.result` JSON and changes
 * what `materializeProfile` matches.
 *
 * Gated on POSTGRES_DSN (or split POSTGRES_* vars) being reachable — same
 * skip-gracefully philosophy as materialize.integration.test.ts.
 *
 * Acceptance criteria covered (issue #182):
 *   - EC-1: a NULL m2_built + high-confidence extract (90 @0.9) matches an
 *     80-100 size band; the same shape WITHOUT an extract row does not.
 *   - EC-2: a LOW-confidence has_elevator:false (@0.3) is treated as UNKNOWN,
 *     not a confident exclusion — requires_elevator does not reject it; a
 *     HIGH-confidence false (@0.9) DOES exclude (the gate works both ways).
 *   - EC-3: property.<col> always wins over the fallback when both present.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile } from "@/lib/db/profiles";
import { materializeProfile } from "../materialize";
import type { Scope } from "@/lib/profiles-schema";
import type { ExtractField } from "@/lib/ai-assessment/extract";

const MADRID_SOL: [number, number] = [40.4168, -3.7038];

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
      "[extract-fallback.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("extract-fallback — real Postgres", () => {
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
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE profile_id = ANY($1::bigint[])", [
          createdProfileIds,
        ]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [createdProfileIds]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
      }
    });
  });

  async function insertProperty(
    pool: Pool,
    overrides: Partial<{
      m2_built: number | null;
      has_elevator: boolean | null;
      floor: string | null;
    }> = {},
  ): Promise<number> {
    const row = {
      m2_built: null as number | null,
      has_elevator: null as boolean | null,
      floor: null as string | null,
      ...overrides,
    };
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, has_elevator, floor)
       VALUES ($1, $2, 'piso', $3, $4, $5) RETURNING id`,
      [MADRID_SOL[0], MADRID_SOL[1], row.m2_built, row.has_elevator, row.floor],
    );
    const id = result.rows[0].id;
    createdPropertyIds.push(id);
    return id;
  }

  async function insertActiveSaleListing(pool: Pool, propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, operation)
       VALUES ($1, 'fotocasa', $2, 'active', 250000, 'sale')`,
      [propertyId, `ec-test-${Math.random().toString(36).slice(2)}`],
    );
  }

  /**
   * Insert one `ai_assessment` extract row (#28's write shape) with a single
   * field filled and its confidence, mirroring `saveExtractAssessment`'s JSON
   * structure so the fallback's `result->>'<field>'` and
   * `result->'confidence_per_field'->>'<field>'` paths resolve exactly.
   */
  async function insertExtract(
    pool: Pool,
    propertyId: number,
    field: ExtractField,
    value: number | string | boolean,
    confidence: number,
  ): Promise<void> {
    const result: Record<string, unknown> = {
      m2_built: null,
      m2_useful: null,
      rooms: null,
      bathrooms: null,
      floor: null,
      has_elevator: null,
      confidence_per_field: { [field]: confidence },
      reasoning: "ec-test",
    };
    result[field] = value;
    await pool.query(
      `INSERT INTO ai_assessment
          (property_id, assessment_type, result, confidence, model, prompt_version, generated_at)
       VALUES ($1, 'extract', $2::jsonb, $3, 'test-model', 'extract/v1', NOW())`,
      [propertyId, JSON.stringify(result), confidence],
    );
  }

  async function makeProfile(scope: Scope): Promise<number> {
    const profile = await createProfile(`ec-test-${Date.now()}-${Math.random()}`, scope, {});
    createdProfileIds.push(profile.id);
    return profile.id;
  }

  async function matches(pool: Pool, profileId: number): Promise<number[]> {
    const { rows } = await pool.query<{ property_id: number }>(
      "SELECT property_id FROM profile_listing_state WHERE profile_id = $1 AND matched = true",
      [profileId],
    );
    return rows.map((r) => r.property_id);
  }

  const sizeScope: Scope = {
    geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
    property_types: ["piso"],
    size_min: 80,
    size_max: 100,
    hard_exclusions: {},
  };

  const elevatorScope: Scope = {
    geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
    property_types: ["piso"],
    hard_exclusions: { requires_elevator: true },
  };

  it("EC-1: NULL m2_built + high-confidence extract (90 @0.9) matches an 80-100 size band; no extract row does not", async () => {
    await withRealDb(async (pool) => {
      const withExtract = await insertProperty(pool, { m2_built: null });
      await insertActiveSaleListing(pool, withExtract);
      await insertExtract(pool, withExtract, "m2_built", 90, 0.9);

      const noExtract = await insertProperty(pool, { m2_built: null });
      await insertActiveSaleListing(pool, noExtract);

      const profileId = await makeProfile(sizeScope);
      await materializeProfile(profileId);

      const matched = await matches(pool, profileId);
      expect(matched).toContain(withExtract); // fallback supplies 90 -> in [80,100]
      expect(matched).not.toContain(noExtract); // no data -> falls out, as today
    });
  });

  it("EC-1 (gate): a LOW-confidence m2_built extract (90 @0.3) is NOT trusted for the size band", async () => {
    await withRealDb(async (pool) => {
      const lowConf = await insertProperty(pool, { m2_built: null });
      await insertActiveSaleListing(pool, lowConf);
      await insertExtract(pool, lowConf, "m2_built", 90, 0.3);

      const profileId = await makeProfile(sizeScope);
      await materializeProfile(profileId);

      const matched = await matches(pool, profileId);
      // Below the 0.6 threshold -> treated as UNKNOWN -> COALESCE falls
      // through to NULL m2_built -> fails the size band, exactly like no row.
      expect(matched).not.toContain(lowConf);
    });
  });

  it("EC-2: a LOW-confidence has_elevator:false (@0.3) is treated as unknown — requires_elevator does not reject it", async () => {
    await withRealDb(async (pool) => {
      const shaky = await insertProperty(pool, { has_elevator: null });
      await insertActiveSaleListing(pool, shaky);
      await insertExtract(pool, shaky, "has_elevator", false, 0.3);

      const confidentlyNoElevator = await insertProperty(pool, { has_elevator: null });
      await insertActiveSaleListing(pool, confidentlyNoElevator);
      await insertExtract(pool, confidentlyNoElevator, "has_elevator", false, 0.9);

      const profileId = await makeProfile(elevatorScope);
      await materializeProfile(profileId);

      const matched = await matches(pool, profileId);
      // Below threshold -> unknown -> IS NOT FALSE keeps it.
      expect(matched).toContain(shaky);
      // At/above threshold -> confidently known missing elevator -> excluded.
      expect(matched).not.toContain(confidentlyNoElevator);
    });
  });

  it("EC-3: property.m2_built wins over a conflicting high-confidence extract", async () => {
    await withRealDb(async (pool) => {
      // Structured 50 (out of the 80-100 band) but a high-confidence extract
      // says 90 (in band). COALESCE must use the structured 50 and exclude
      // the property — a stale extraction never shadows a real column.
      const structured = await insertProperty(pool, { m2_built: 50 });
      await insertActiveSaleListing(pool, structured);
      await insertExtract(pool, structured, "m2_built", 90, 0.9);

      const profileId = await makeProfile(sizeScope);
      await materializeProfile(profileId);

      const matched = await matches(pool, profileId);
      expect(matched).not.toContain(structured);
    });
  });

  it("EC-3 (elevator): property.has_elevator=false wins over a high-confidence extract true, so requires_elevator still excludes", async () => {
    await withRealDb(async (pool) => {
      const structuredNoElevator = await insertProperty(pool, { has_elevator: false });
      await insertActiveSaleListing(pool, structuredNoElevator);
      await insertExtract(pool, structuredNoElevator, "has_elevator", true, 0.9);

      const profileId = await makeProfile(elevatorScope);
      await materializeProfile(profileId);

      const matched = await matches(pool, profileId);
      // property.has_elevator=false wins -> false IS NOT FALSE -> excluded,
      // even though the extract confidently claims an elevator.
      expect(matched).not.toContain(structuredNoElevator);
    });
  });
});
