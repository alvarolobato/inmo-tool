/**
 * #542 — triage merge persistence: real-Postgres integration test.
 *
 * D-A's whole compatibility promise is that a triage-written row is
 * INDISTINGUISHABLE from a pre-merge, single-flow-written row to every
 * existing reader. This file proves that against a real database rather than
 * asserting it from the code alone:
 *
 *   - `getConditionAssessment`/`getLocationAssessment`/`getOpportunityAssessment`
 *     (cache.ts's `getLatestAssessment`) round-trip a triage-authored row
 *     exactly like a pre-merge one — same shape, same staleness rule.
 *   - The EXACT query `lib/candidates.ts`'s `loadFlags` runs (`DISTINCT ON
 *     (property_id, assessment_type) ... generated_at DESC NULLS LAST, id DESC`,
 *     no `prompt_version` filter) returns the latest per-axis row regardless
 *     of which flow (triage or the old standalone ones) wrote it, with the
 *     field names `flagsFromAssessments` expects.
 *   - `lib/filtering/scope-query.ts`'s `extractFallbackExpr` — the D-067
 *     extract-fallback SQL builder — is UNAFFECTED: it only ever reads
 *     `assessment_type = 'extract'`, so a property carrying triage-written
 *     condition/location/opportunity rows alongside an extract row still
 *     resolves the same fallback value.
 *
 * Mirrors condition.integration.test.ts's/extract.integration.test.ts's
 * REQUIRE_DB=1 skip contract.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import {
  saveConditionAssessment,
  getConditionAssessment,
  parseConditionResult,
  CONDITION_PROMPT_VERSION,
} from "../condition";
import {
  saveLocationAssessment,
  getLocationAssessment,
  parseLocationResult,
  LOCATION_PROMPT_VERSION,
} from "../location";
import {
  saveOpportunityAssessment,
  getOpportunityAssessment,
  parseOpportunityResult,
  OPPORTUNITY_PROMPT_VERSION,
} from "../opportunity";
import { extractFallbackExpr } from "@/lib/filtering/scope-query";

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
        "REQUIRE_DB=1 but Postgres is unreachable for triage.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[triage.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
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
  reasoning: "El anuncio pide reforma de instalaciones.",
});

const FRONTLINE = JSON.stringify({
  beach_proximity: "frontline",
  beach_evidence: "primera línea de playa",
  beach_evidence_source: "fotocasa",
  heritage_zone: false,
  confidence: 0.9,
  reasoning: "Primera línea declarada.",
});

const VPO = JSON.stringify({
  is_vpo: true,
  vpo_evidence: "vivienda de protección oficial",
  vpo_evidence_source: "fotocasa",
  tourist_license: false,
  confidence: 0.9,
  reasoning: "VPO declarada.",
});

describe.runIf(dbAvailable)("triage merge — real Postgres compatibility", () => {
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

  async function seedProperty(pool: Pool, rooms: number | null = 3): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type, m2_built, rooms)
       VALUES ('Calle Test Triage 1', 'piso', 90, $1) RETURNING id`,
      [rooms],
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);
    await pool.query(
      `INSERT INTO listing
          (property_id, source, external_id, status, operation, current_price, description)
       VALUES ($1, 'fotocasa', 'triage-int-a', 'active', 'sale',
               200000, 'Piso en primera línea de playa, VPO, a reformar.')`,
      [propertyId],
    );
    return propertyId;
  }

  /** Persist condition + location + opportunity exactly as `triage.ts`'s `saveAxis` would (#542). */
  async function seedTriageWrittenRows(propertyId: number, model = "triage-mock-model"): Promise<void> {
    await saveConditionAssessment(propertyId, parseConditionResult(A_REFORMAR), model, "hash-triage");
    await saveLocationAssessment(propertyId, parseLocationResult(FRONTLINE), model, "hash-triage");
    await saveOpportunityAssessment(propertyId, parseOpportunityResult(VPO), model, "hash-triage");
  }

  it("getConditionAssessment/getLocationAssessment/getOpportunityAssessment round-trip a triage-authored row exactly like a pre-merge one", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedProperty(pool);
      await seedTriageWrittenRows(propertyId);

      const condition = await getConditionAssessment(propertyId);
      const location = await getLocationAssessment(propertyId);
      const opportunity = await getOpportunityAssessment(propertyId);

      expect(condition?.result.condition).toBe("a_reformar");
      expect(condition?.prompt_version).toBe(CONDITION_PROMPT_VERSION);
      expect(condition?.stale).toBe(false);

      expect(location?.result.beach_proximity).toBe("frontline");
      expect(location?.prompt_version).toBe(LOCATION_PROMPT_VERSION);
      expect(location?.stale).toBe(false);

      expect(opportunity?.result.is_vpo).toBe(true);
      expect(opportunity?.prompt_version).toBe(OPPORTUNITY_PROMPT_VERSION);
      expect(opportunity?.stale).toBe(false);
    });
  });

  it("exactly ONE ai_assessment row per assessment_type, same as before the merge", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedProperty(pool);
      await seedTriageWrittenRows(propertyId);

      const { rows } = await pool.query<{ assessment_type: string; n: string }>(
        `SELECT assessment_type, COUNT(*) AS n FROM ai_assessment
          WHERE property_id = $1 AND assessment_type IN ('condition', 'location', 'opportunity')
          GROUP BY assessment_type`,
        [propertyId],
      );
      const byType = Object.fromEntries(rows.map((r) => [r.assessment_type, Number(r.n)]));
      expect(byType).toEqual({ condition: 1, location: 1, opportunity: 1 });
    });
  });

  it("loadFlags's EXACT query (lib/candidates.ts) reads a triage-written row identically to a pre-merge one — latest-per-axis, NO prompt_version filter", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedProperty(pool);
      await seedTriageWrittenRows(propertyId);

      // The literal query loadFlags runs — pinned here so a change to either
      // side (this test or candidates.ts) surfaces as a failure, not a silent
      // drift. See candidates.ts's `loadFlags` doc for the DISTINCT ON
      // rationale (#152 review).
      const { rows } = await pool.query<{ property_id: number; assessment_type: string; result: unknown }>(
        `SELECT DISTINCT ON (property_id, assessment_type)
                property_id, assessment_type, result
           FROM ai_assessment
          WHERE property_id = ANY($1::bigint[])
            AND assessment_type IN ('occupancy', 'condition', 'redflags', 'location', 'opportunity')
          ORDER BY property_id, assessment_type, generated_at DESC NULLS LAST, id DESC`,
        [[propertyId]],
      );

      const byType = Object.fromEntries(rows.map((r) => [r.assessment_type, r.result as Record<string, unknown>]));
      expect(byType.condition).toMatchObject({ condition: "a_reformar" });
      expect(byType.location).toMatchObject({ beach_proximity: "frontline" });
      expect(byType.opportunity).toMatchObject({ is_vpo: true });
    });
  });

  it("a prompt-version bump still leaves the OLD row shadowed, not deleted — loadFlags's query picks the newest by generated_at, same as pre-merge", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedProperty(pool);
      // An "old" pre-merge condition row (earlier generated_at, different prompt_version).
      await pool.query(
        `INSERT INTO ai_assessment (property_id, assessment_type, result, confidence, prompt_version, generated_at)
         VALUES ($1, 'condition', $2::jsonb, 0.7, 'condition/v2', NOW() - INTERVAL '1 day')`,
        [propertyId, JSON.stringify({ condition: "reformado" })],
      );
      // The new triage-authored row.
      await saveConditionAssessment(propertyId, parseConditionResult(A_REFORMAR), "m", "hash-triage");

      const cached = await getConditionAssessment(propertyId);
      expect(cached?.result.condition).toBe("a_reformar");

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ai_assessment WHERE property_id = $1 AND assessment_type = 'condition'`,
        [propertyId],
      );
      // saveConditionAssessment's ON CONFLICT is keyed on (property_id,
      // assessment_type, prompt_version) — a DIFFERENT prompt_version is a
      // fresh row, not an update, so both survive (the old one merely stops
      // being "latest").
      expect(Number(rows[0].n)).toBe(2);
    });
  });

  it("D-067's extractFallbackExpr is unaffected by triage-written condition/location/opportunity rows on the same property", async () => {
    await withRealDb(async (pool) => {
      // rooms is NULL on the property row -> the extract fallback should fire.
      const propertyId = await seedProperty(pool, null);
      await seedTriageWrittenRows(propertyId);
      await pool.query(
        `INSERT INTO ai_assessment (property_id, assessment_type, result, confidence, prompt_version, generated_at)
         VALUES ($1, 'extract', $2::jsonb, 0.9, 'extract/v1', NOW())`,
        [
          propertyId,
          JSON.stringify({ rooms: 4, confidence_per_field: { rooms: 0.8 } }),
        ],
      );

      const { rows } = await pool.query<{ rooms: number | null }>(
        `SELECT ${extractFallbackExpr("rooms")} AS rooms FROM property WHERE id = $1`,
        [propertyId],
      );
      // The extract-derived value wins because property.rooms is NULL — and
      // this is unchanged by the presence of the triage-written rows, since
      // extractFallbackExpr only ever reads assessment_type = 'extract'.
      expect(rows[0].rooms).toBe(4);
    });
  });
});
