/**
 * Real-Postgres integration test for POST /api/profiles/scope-preview
 * (issue #659, #665 review M1).
 *
 * A unit test could assert the SQL string builder produces plausible
 * fragments, but this route's whole job is a hand-composed CTE + FILTER
 * query over three shared helpers (assessmentEligibleClause,
 * missingCurrentVerdictClause, activeSourceClause) that were never combined
 * this way before — the only thing that actually proves the SQL is valid
 * and counts the right rows is running it against real Postgres.
 *
 * Scenario proven: of four properties that all match the draft scope,
 * exactly ONE is "newly eligible for assessment" — the one that is
 * readable (active listing, non-empty description, active source), still
 * pending (no current-prompt-version verdict for any selection flow), and
 * NOT already matched by an existing active profile. The other three are
 * excluded for three different, specific reasons — not just "excluded".
 *
 * Skips cleanly when no database is reachable; REQUIRE_DB=1 makes that a
 * hard failure (AGENTS.md's REQUIRE_DB contract).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { NextRequest } from "next/server";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile } from "@/lib/db/profiles";
import {
  ASSESSMENT_SELECTION_FLOWS,
  DISABLED_SOURCES_CTE,
  assessmentEligibleClause,
  missingCurrentVerdictClause,
  selectionFlowValues,
} from "@/lib/ai-assessment/eligibility";
import { POST } from "../route";
import type { Scope } from "@/lib/profiles-schema";

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
        "REQUIRE_DB=1 but Postgres is unreachable for scope-preview route.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[scope-preview route.integration.test] no reachable Postgres - skipping real-DB tests.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const MADRID_SOL: [number, number] = [40.4168, -3.7038];

function postReq(scope: Scope): NextRequest {
  return new NextRequest("http://localhost:4000/api/profiles/scope-preview", {
    method: "POST",
    body: JSON.stringify({ scope }),
    headers: { "Content-Type": "application/json" },
  });
}

describe.runIf(dbAvailable)("POST /api/profiles/scope-preview — real Postgres", () => {
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
        await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [createdProfileIds]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
      }
    });
  });

  async function insertProperty(pool: Pool): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built)
       VALUES ($1, $2, 'piso', 70) RETURNING id`,
      [MADRID_SOL[0], MADRID_SOL[1]],
    );
    const id = result.rows[0].id;
    createdPropertyIds.push(id);
    return id;
  }

  async function insertListing(
    pool: Pool,
    propertyId: number,
    overrides: Partial<{ description: string | null; source: string }> = {},
  ): Promise<void> {
    const row = {
      description: "Piso luminoso con vistas, reformado recientemente.",
      // A source with NO connector_registry row (D-055: missing row = active)
      // — several real connectors (fotocasa included) seed as DISABLED by
      // default in a fresh init.sql install, which would make activeSourceClause
      // reject them and silently break this test's "readable" assumption.
      source: "e2e-scope-preview-test-source",
      ...overrides,
    };
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, operation, description)
       VALUES ($1, $2, $3, 'active', 300000, 'sale', $4)`,
      [propertyId, row.source, `int-test-preview-${Math.random().toString(36).slice(2)}`, row.description],
    );
  }

  /** Writes a current-prompt-version verdict for EVERY selection flow — makes the property NOT pending. */
  async function markFullyAssessed(pool: Pool, propertyId: number): Promise<void> {
    for (const flow of ASSESSMENT_SELECTION_FLOWS) {
      await pool.query(
        `INSERT INTO ai_assessment (property_id, assessment_type, result, prompt_version, generated_at)
         VALUES ($1, $2, '{}'::jsonb, $3, NOW())`,
        [propertyId, flow.type, flow.version],
      );
    }
  }

  it("counts newly-eligible correctly: readable+pending+unmatched-elsewhere only, three distinct exclusions", async () => {
    await withRealDb(async (pool) => {
      const scope: Scope = {
        geography: { type: "radius", center: MADRID_SOL, radius_km: 10 },
        property_types: ["piso"],
        hard_exclusions: {},
      };

      // Baseline BEFORE inserting anything — this test's own isolated DB
      // (test-with-isolated-db.ts) is shared across every test FILE in one
      // `npm test` invocation, so other files' fixtures near Madrid Sol can
      // legitimately share this radius. Asserting on the DELTA this test's
      // own 4 properties contribute (rather than an absolute number) keeps
      // the assertion exact without being coupled to what else is running.
      const baselineRes = await POST(postReq(scope));
      expect(baselineRes.status).toBe(200);
      const baseline = await baselineRes.json();

      // A: the one that SHOULD count — readable, pending, not matched by any existing profile.
      const newlyEligibleId = await insertProperty(pool);
      await insertListing(pool, newlyEligibleId);

      // B: already matched by an existing ACTIVE profile — not "newly" anything.
      const alreadyMatchedId = await insertProperty(pool);
      await insertListing(pool, alreadyMatchedId);
      const existingProfile = await createProfile(
        `scope-preview-existing-${Date.now()}`,
        {
          geography: { type: "radius", center: MADRID_SOL, radius_km: 50 },
          property_types: ["piso"],
          hard_exclusions: {},
        },
        {},
      );
      createdProfileIds.push(existingProfile.id);
      await pool.query(
        `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
        [existingProfile.id, alreadyMatchedId],
      );

      // C: no readable description at all — fails stage 2a.
      const noDescriptionId = await insertProperty(pool);
      await insertListing(pool, noDescriptionId, { description: "" });

      // D: readable, but already fully assessed at the current prompt versions — not pending.
      const fullyAssessedId = await insertProperty(pool);
      await insertListing(pool, fullyAssessedId);
      await markFullyAssessed(pool, fullyAssessedId);

      const res = await POST(postReq(scope));
      expect(res.status).toBe(200);
      const body = await res.json();

      // count is exact — property/listing rows for A/B/C/D are all created
      // by THIS test alone, cleaned up in afterEach, so the delta is exactly 4.
      expect(body.count - baseline.count).toBe(4);

      // Exactly ONE of the four newly moves into the eligible bucket — not
      // "at least one" (a route bug that counted B/C/D too, or miscounted A
      // as 0, would both slip past a >=1 check). Verified two ways: the
      // delta the route itself reports, AND independently re-running the
      // EXACT SAME predicates the route composes (not a hand-rolled
      // approximation) scoped to just these 4 ids, so a bug that happened
      // to produce the right delta for the wrong REASON is still caught.
      expect(body.newlyEligibleForAssessment - baseline.newlyEligibleForAssessment).toBe(1);

      const { valuesSql, params: flowParams } = selectionFlowValues(2);
      const { rows: matched } = await pool.query<{ id: number }>(
        `WITH ${DISABLED_SOURCES_CTE}
         SELECT id FROM property WHERE id = ANY($1::bigint[])
           AND EXISTS (
             SELECT 1 FROM listing l WHERE l.property_id = property.id
               AND l.status = 'active' AND COALESCE(TRIM(l.description), '') <> ''
           )
           AND ${missingCurrentVerdictClause("property", valuesSql)}
           AND NOT (${assessmentEligibleClause("property")})`,
        [[newlyEligibleId, alreadyMatchedId, noDescriptionId, fullyAssessedId], ...flowParams],
      );
      expect(matched.map((r) => r.id)).toEqual([newlyEligibleId]);
    });
  });

  it("returns projectedAssessmentDays as a number (or null) alongside the counts — never crashes on the scheduler config read", async () => {
    await withRealDb(async () => {
      const scope: Scope = {
        geography: { type: "everywhere" },
        property_types: "all",
        hard_exclusions: {},
      };
      const res = await POST(postReq(scope));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.count).toBe("number");
      expect(typeof body.newlyEligibleForAssessment).toBe("number");
      expect(body.projectedAssessmentDays === null || typeof body.projectedAssessmentDays === "number").toBe(
        true,
      );
    });
  });

  it("400s on an invalid scope (missing geography) rather than reaching the DB", async () => {
    const res = await POST(
      new NextRequest("http://localhost:4000/api/profiles/scope-preview", {
        method: "POST",
        body: JSON.stringify({ scope: { property_types: ["piso"] } }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });
});
