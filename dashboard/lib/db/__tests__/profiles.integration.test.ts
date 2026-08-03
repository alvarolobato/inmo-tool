/**
 * Real-Postgres integration test for issue #113 (malformed-scope profiles
 * must not vanish) and issue #191 (last_materialized_at/last_viewed_at
 * round-trip) — a mocked query can't prove a raw '{}' scope inserted via
 * direct SQL (bypassing every application-level validated write path)
 * actually reaches listActiveProfileEntries as {ok: false, ...} rather than
 * silently disappearing, nor that the ALTER TABLE ... DROP DEFAULT (D-010)
 * actually took effect against a real schema application.
 *
 * Skips cleanly when no database is reachable; REQUIRE_DB=1 makes that a
 * hard failure (see AGENTS.md / etl/tests/conftest.py's contract).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import {
  listActiveProfileEntries,
  listActiveProfiles,
  touchProfileViewedAt,
  createProfile,
} from "../profiles";
import { materializeProfile } from "@/lib/filtering/materialize";
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
        "REQUIRE_DB=1 but Postgres is unreachable for profiles.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[profiles.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const VALID_SCOPE: Scope = {
  geography: { type: "radius", center: [39.4699, -0.3763], radius_km: 5 },
  property_types: ["piso"],
  hard_exclusions: {},
};

describe.runIf(dbAvailable)("issue #113/#191 — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdProfileIds: number[] = [];

  beforeEach(() => {
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
    });
  });

  it("D-010: search_profile.scope has no DB-level default — INSERT without a scope fails loudly", async () => {
    await withRealDb(async (pool) => {
      await expect(pool.query(`INSERT INTO search_profile (name) VALUES ('no scope')`)).rejects.toThrow(
        /null value in column "scope"/,
      );
    });
  });

  it("a manually-inserted row with the (former) '{}' default surfaces as {ok: false, ...}, never silently dropped", async () => {
    let brokenId!: number;
    let validId!: number;
    await withRealDb(async (pool) => {
      const broken = await pool.query<{ id: number }>(
        `INSERT INTO search_profile (name, scope, thesis_params) VALUES ($1, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
        ["Perfil roto (manual insert)"],
      );
      brokenId = broken.rows[0].id;
      const valid = await createProfile("Perfil válido", VALID_SCOPE, {});
      validId = valid.id;
    });
    createdProfileIds = [brokenId, validId];

    const entries = await listActiveProfileEntries();
    const brokenEntry = entries.find((e) => (e.ok ? e.profile.id : e.id) === brokenId);
    const validEntry = entries.find((e) => (e.ok ? e.profile.id : e.id) === validId);

    expect(brokenEntry).toBeDefined();
    expect(brokenEntry?.ok).toBe(false);
    if (brokenEntry && !brokenEntry.ok) {
      expect(brokenEntry.name).toBe("Perfil roto (manual insert)");
      expect(brokenEntry.issues.length).toBeGreaterThan(0);
    }

    // The malformed row must not take down every other profile's listing —
    // the valid profile still appears, correctly parsed.
    expect(validEntry).toBeDefined();
    expect(validEntry?.ok).toBe(true);

    // The plain (backward-compatible) list still filters malformed rows out
    // — GET /api/profiles's existing contract is unchanged by issue #113.
    const plainList = await listActiveProfiles();
    expect(plainList.some((p) => p.id === brokenId)).toBe(false);
    expect(plainList.some((p) => p.id === validId)).toBe(true);
  });

  it("last_materialized_at is NULL until the first materialize run, then set even when zero properties match (issue #191)", async () => {
    const profile = await createProfile("Perfil aislado", VALID_SCOPE, {});
    createdProfileIds = [profile.id];

    const before = await listActiveProfileEntries();
    const beforeEntry = before.find((e) => e.ok && e.profile.id === profile.id);
    expect(beforeEntry?.ok).toBe(true);
    if (beforeEntry?.ok) expect(beforeEntry.profile.last_materialized_at).toBeNull();

    // No properties exist anywhere near this profile's coordinates —
    // materialize should still set last_materialized_at, distinguishing
    // "ran, found nothing" from "never ran" (the whole point of #191).
    const result = await materializeProfile(profile.id);
    expect(result?.matchedCount).toBe(0);

    const after = await listActiveProfileEntries();
    const afterEntry = after.find((e) => e.ok && e.profile.id === profile.id);
    expect(afterEntry?.ok).toBe(true);
    if (afterEntry?.ok) expect(afterEntry.profile.last_materialized_at).not.toBeNull();
  });

  it("touchProfileViewedAt sets last_viewed_at for the given profile only", async () => {
    const a = await createProfile("Perfil A", VALID_SCOPE, {});
    const b = await createProfile("Perfil B", VALID_SCOPE, {});
    createdProfileIds = [a.id, b.id];

    await touchProfileViewedAt(a.id);

    const entries = await listActiveProfileEntries();
    const entryA = entries.find((e) => e.ok && e.profile.id === a.id);
    const entryB = entries.find((e) => e.ok && e.profile.id === b.id);
    expect(entryA?.ok && entryA.profile.last_viewed_at).not.toBeNull();
    expect(entryB?.ok && entryB.profile.last_viewed_at).toBeNull();
  });
});
