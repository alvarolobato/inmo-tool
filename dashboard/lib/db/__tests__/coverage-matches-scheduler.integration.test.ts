/**
 * #330 — the cost panel's assessment coverage must equal what the scheduler
 * actually assesses. Real-Postgres integration.
 *
 * The bug (#330): `lib/db/llm-health.ts` computed the backlog with an OLDER,
 * looser eligibility rule (any active listing with a non-empty description),
 * while the scheduler (`selectPropertiesNeedingAssessment`, #327) had narrowed
 * to *profile-matched candidates of an active profile* from a *non-disabled
 * source*. So the panel showed a too-large backlog vs. reality.
 *
 * The one thing worth proving against a real database, not a mock: after
 * seeding properties that are eligible under the OLD rule but NOT the #327 rule
 * (an unmatched one, and one whose only source is disabled), the panel's
 * `coverage.pending` equals `selectPropertiesNeedingAssessment(BIG).length`
 * EXACTLY — both now use the shared `eligibility.ts` predicate, so the count
 * can no longer diverge. On the pre-#330 code this equality fails (the panel
 * over-counts the unmatched / disabled-source properties).
 *
 * Skips cleanly when no database is reachable; REQUIRE_DB=1 makes that a hard
 * failure (AGENTS.md contract, mirrored from the sibling integration files).
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool as resetWritePool } from "@/lib/db-write";
import { resetPool as resetReadPool } from "@/lib/db";
import { selectPropertiesNeedingAssessment } from "@/lib/ai-assessment/batch";
import { getLlmHealth } from "../llm-health";

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
        "REQUIRE_DB=1 but Postgres is unreachable for coverage-matches-scheduler.integration.test.ts: " +
          String(err),
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[coverage-matches-scheduler.integration.test] no reachable Postgres — skipping. " +
        "Set POSTGRES_DSN to run.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("panel coverage == scheduler selection (#330)", () => {
  const createdPropertyIds: number[] = [];
  const createdProfileIds: number[] = [];
  const createdConnectorNames: string[] = [];

  afterAll(async () => {
    await resetWritePool();
    await resetReadPool();
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
        await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
        await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [createdProfileIds]);
      }
      if (createdConnectorNames.length > 0) {
        await pool.query("DELETE FROM connector_config WHERE connector_name = ANY($1::text[])", [createdConnectorNames]);
        await pool.query("DELETE FROM connector_registry WHERE connector_name = ANY($1::text[])", [createdConnectorNames]);
      }
    });
    createdPropertyIds.length = 0;
    createdProfileIds.length = 0;
    createdConnectorNames.length = 0;
  });

  async function makeProfile(pool: Pool, tag: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO search_profile (name, scope, archived_at)
       VALUES ($1, '{"geography":{"type":"radius"},"property_types":["piso"]}'::jsonb, NULL)
       RETURNING id`,
      [`Cov profile ${tag}`],
    );
    const id = Number(rows[0].id);
    createdProfileIds.push(id);
    return id;
  }

  async function registerConnector(pool: Pool, name: string, on: boolean): Promise<void> {
    createdConnectorNames.push(name);
    await pool.query(
      `INSERT INTO connector_registry (connector_name, registered, supports_discovery, supported_filters)
       VALUES ($1, true, true, '[]'::jsonb)
       ON CONFLICT (connector_name) DO UPDATE SET supports_discovery = EXCLUDED.supports_discovery`,
      [name],
    );
    await pool.query(
      `INSERT INTO connector_config (connector_name, enabled, capture_enabled, filters)
       VALUES ($1, $2, true, '{}'::jsonb)
       ON CONFLICT (connector_name) DO UPDATE SET enabled = $2`,
      [name, on],
    );
  }

  /** A property with one active advert (default source `fotocasa`), no
   * assessments. Optionally matched to a fresh active profile. */
  async function seedProperty(
    pool: Pool,
    tag: string,
    opts?: { match?: boolean; source?: string },
  ): Promise<number> {
    const source = opts?.source ?? "fotocasa";
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type, m2_built, rooms)
       VALUES ($1, 'piso', 85, 3) RETURNING id`,
      [`Calle Cov ${tag}`],
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, description)
       VALUES ($1, $2, $3, 'active', 'sale', 180000, 'Piso con inquilino, buena rentabilidad.')`,
      [propertyId, source, `cov-${tag}`],
    );
    if (opts?.match) {
      const profileId = await makeProfile(pool, tag);
      await pool.query(
        `INSERT INTO profile_listing_state (profile_id, property_id, matched)
         VALUES ($1, $2, true)
         ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = true`,
        [profileId, propertyId],
      );
    }
    return propertyId;
  }

  it("coverage.pending equals the scheduler's global pending population", async () => {
    await withRealDb(async (pool) => {
      // Eligible + pending under BOTH rules — a matched candidate from an
      // active source, no verdicts yet.
      const matched = await seedProperty(pool, "match", { match: true });

      // Eligible under the OLD panel rule (active listing + non-empty desc) but
      // NOT under #327 — never matched to any profile. Must NOT be counted.
      await seedProperty(pool, "unmatched", { match: false });

      // Matched, but its only source is switched OFF (#322 / D-055) — hidden
      // from the feed, so NOT assessed and NOT counted.
      const offSource = "d330-cov-off";
      await registerConnector(pool, offSource, /* on */ false);
      await seedProperty(pool, "offsrc", { match: true, source: offSource });

      // A very large batch → the scheduler returns the ENTIRE pending
      // population (no LIMIT truncation), so its length is the global count.
      const selected = await selectPropertiesNeedingAssessment(1_000_000);
      const health = await getLlmHealth();

      // The core #330 invariant: the panel's backlog equals reality.
      expect(health.coverage.pending).toBe(selected.length);

      // Not vacuous: the matched candidate is in the population; the
      // unmatched / disabled-source ones are not (they'd inflate the OLD
      // panel's pending above selected.length).
      expect(selected).toContain(matched);
      expect(health.coverage.pending).toBeGreaterThan(0);
      expect(health.coverage.covered).toBe(
        Math.max(0, health.coverage.eligible - health.coverage.pending),
      );
    });
  });
});
