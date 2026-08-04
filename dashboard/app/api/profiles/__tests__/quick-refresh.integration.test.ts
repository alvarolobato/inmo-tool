/**
 * Real-Postgres integration test for issue #245: a profile save kicks off a
 * quick refresh — it re-materializes the profile AND enqueues an ad-hoc
 * connector sweep (an `etl_manual_trigger` row), but ONLY when the
 * crawl-relevant scope actually changed.
 *
 * A mocked query can't prove any of the four behaviors that matter here:
 *   1. create → a pending full-sweep trigger row is really inserted, and the
 *      profile is really materialized (last_materialized_at set);
 *   2. a geography edit → a new sweep is enqueued;
 *   3. a rename (no scope change) → NOTHING is enqueued and the profile is
 *      NOT re-materialized;
 *   4. rapid successive saves coalesce onto ONE pending sweep (the
 *      single-pending unique index), reported as `already_pending`.
 *
 * These drive the real route handlers against a real schema, then read the
 * `etl_manual_trigger` / `search_profile` rows back directly.
 *
 * Skips cleanly when no database is reachable; REQUIRE_DB=1 makes that a hard
 * failure (see AGENTS.md / etl/tests/conftest.py's contract).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { NextRequest } from "next/server";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { POST } from "../route";
import { PATCH } from "../[id]/route";
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
        "REQUIRE_DB=1 but Postgres is unreachable for quick-refresh.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[quick-refresh.integration.test] no reachable Postgres - skipping real-DB tests.",
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

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4000/api/profiles", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function patchReq(id: number, body: unknown) {
  const req = new NextRequest(`http://localhost:4000/api/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return PATCH(req, { params: Promise.resolve({ id: String(id) }) });
}

interface RefreshBody {
  id: number;
  refresh: {
    materialized: boolean;
    crawl: { status: string; triggerId: number | null };
  } | null;
}

async function pendingTriggerCount(pool: Pool): Promise<number> {
  const r = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM etl_manual_trigger WHERE status = 'pending'",
  );
  return Number(r.rows[0].n);
}

describe.runIf(dbAvailable)("issue #245 — quick refresh on profile save (real Postgres)", () => {
  let createdIds: number[] = [];

  beforeEach(async () => {
    createdIds = [];
    // Each test reasons about a clean trigger queue — the isolated test DB is
    // per-run, not per-test, so a prior test's pending row would otherwise
    // make the next enqueue coalesce unexpectedly.
    await withRealDb((pool) => pool.query("DELETE FROM etl_manual_trigger").then(() => undefined));
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE profile_id = ANY($1::bigint[])", [createdIds]);
        await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [createdIds]);
      }
      await pool.query("DELETE FROM etl_manual_trigger");
    });
  });

  afterAll(async () => {
    await resetPool();
  });

  it("create enqueues a full-sweep trigger and materializes the profile", async () => {
    const res = await POST(postReq({ name: "Valencia centro", scope: VALID_SCOPE }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as RefreshBody;
    createdIds.push(json.id);

    // Response advertises the refresh so the UI can show the indicator.
    expect(json.refresh).not.toBeNull();
    expect(json.refresh?.materialized).toBe(true);
    expect(json.refresh?.crawl.status).toBe("enqueued");
    expect(typeof json.refresh?.crawl.triggerId).toBe("number");

    await withRealDb(async (pool) => {
      // Exactly one pending sweep, scoped to ALL connectors (connector_name NULL).
      const trig = await pool.query<{ connector_name: string | null; triggered_by: string | null }>(
        "SELECT connector_name, triggered_by FROM etl_manual_trigger WHERE status = 'pending'",
      );
      expect(trig.rows).toHaveLength(1);
      expect(trig.rows[0].connector_name).toBeNull();
      expect(trig.rows[0].triggered_by).toBe("profile-refresh");

      // Materialization actually ran: last_materialized_at is set (issue #191's
      // "ran, even if matched nothing" marker).
      const p = await pool.query<{ last_materialized_at: string | null }>(
        "SELECT last_materialized_at FROM search_profile WHERE id = $1",
        [json.id],
      );
      expect(p.rows[0].last_materialized_at).not.toBeNull();
    });
  });

  it("a geography change on edit enqueues a new sweep", async () => {
    const created = (await (await POST(postReq({ name: "Perfil", scope: VALID_SCOPE }))).json()) as RefreshBody;
    createdIds.push(created.id);
    // Simulate the create's sweep having been claimed/finished so we can prove
    // the PATCH enqueues its OWN fresh pending row rather than coalescing.
    await withRealDb((pool) => pool.query("DELETE FROM etl_manual_trigger").then(() => undefined));

    const changed: Scope = { ...VALID_SCOPE, geography: { ...VALID_SCOPE.geography, radius_km: 15 } };
    const res = await patchReq(created.id, { name: "Perfil", scope: changed });
    expect(res.status).toBe(200);
    const json = (await res.json()) as RefreshBody;

    expect(json.refresh).not.toBeNull();
    expect(json.refresh?.crawl.status).toBe("enqueued");
    await withRealDb(async (pool) => {
      expect(await pendingTriggerCount(pool)).toBe(1);
    });
  });

  it("a rename (no scope change) enqueues nothing and does NOT re-materialize", async () => {
    const created = (await (await POST(postReq({ name: "Antiguo", scope: VALID_SCOPE }))).json()) as RefreshBody;
    createdIds.push(created.id);

    // The pg driver returns TIMESTAMPTZ as a Date; compare by ISO string so an
    // "unchanged" assertion is about the value, not object identity.
    let materializedAt: string | null = null;
    await withRealDb(async (pool) => {
      await pool.query("DELETE FROM etl_manual_trigger");
      const p = await pool.query<{ last_materialized_at: Date | null }>(
        "SELECT last_materialized_at FROM search_profile WHERE id = $1",
        [created.id],
      );
      materializedAt = p.rows[0].last_materialized_at?.toISOString() ?? null;
    });

    const res = await patchReq(created.id, { name: "Nuevo nombre" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as RefreshBody;

    // No scope change → no refresh at all.
    expect(json.refresh).toBeNull();
    await withRealDb(async (pool) => {
      expect(await pendingTriggerCount(pool)).toBe(0);
      // last_materialized_at must be UNCHANGED — a rename must not re-run the
      // (potentially expensive) materialize/score pipeline.
      const p = await pool.query<{ last_materialized_at: Date | null }>(
        "SELECT last_materialized_at FROM search_profile WHERE id = $1",
        [created.id],
      );
      expect(p.rows[0].last_materialized_at?.toISOString() ?? null).toBe(materializedAt);
    });
  });

  it("an identical-scope edit (reordered types, false==absent exclusion) enqueues nothing", async () => {
    const twoTypeScope: Scope = { ...VALID_SCOPE, property_types: ["piso", "local"], hard_exclusions: {} };
    const created = (await (await POST(postReq({ name: "P", scope: twoTypeScope }))).json()) as RefreshBody;
    createdIds.push(created.id);
    await withRealDb((pool) => pool.query("DELETE FROM etl_manual_trigger").then(() => undefined));

    // Same scope semantically: property_types reordered, and an explicit
    // requires_elevator:false (which equals "absent").
    const noisyButEqual: Scope = {
      ...VALID_SCOPE,
      property_types: ["local", "piso"],
      hard_exclusions: { requires_elevator: false },
    };
    const res = await patchReq(created.id, { name: "P", scope: noisyButEqual });
    expect(res.status).toBe(200);
    const json = (await res.json()) as RefreshBody;

    expect(json.refresh).toBeNull();
    await withRealDb(async (pool) => {
      expect(await pendingTriggerCount(pool)).toBe(0);
    });
  });

  it("rapid successive saves coalesce onto one pending sweep (already_pending)", async () => {
    const first = (await (await POST(postReq({ name: "A", scope: VALID_SCOPE }))).json()) as RefreshBody;
    createdIds.push(first.id);
    const second = (await (await POST(postReq({ name: "B", scope: VALID_SCOPE }))).json()) as RefreshBody;
    createdIds.push(second.id);

    expect(first.refresh?.crawl.status).toBe("enqueued");
    expect(second.refresh?.crawl.status).toBe("already_pending");
    // The coalesced save still hands the UI the existing pending trigger to poll.
    expect(second.refresh?.crawl.triggerId).toBe(first.refresh?.crawl.triggerId);

    await withRealDb(async (pool) => {
      expect(await pendingTriggerCount(pool)).toBe(1);
    });
  });
});
