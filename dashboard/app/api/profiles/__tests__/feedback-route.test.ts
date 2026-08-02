/**
 * Real-Postgres integration test for the feedback event API (task 3.1, #20).
 *
 * Every EC here is a real database-correctness question (does the derived
 * "current state" actually read the latest row, does profile-scoping
 * actually isolate two profiles' state, does property-level keying actually
 * ignore which listing was passed) — exactly the class of behavior a mocked
 * query response can assert the SQL text for without ever proving the
 * underlying logic is right. Same gating/cleanup pattern as
 * lib/__tests__/candidates.integration.test.ts: `describe.runIf(dbAvailable)`,
 * cleanup scoped to exact IDs this file creates, never a broad scan (vitest's
 * file-level parallelism runs this against the same live Postgres as other
 * integration test files).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile } from "@/lib/db/profiles";
import type { Scope } from "@/lib/profiles-schema";
import { GET, POST } from "../[id]/candidates/[propertyId]/feedback/route";

// Far from candidates.integration.test.ts's and materialize.integration.test.ts's
// coordinates (~17km+) so this file's profiles/properties can never overlap
// with either's real geographic-scan production code when run concurrently.
const TEST_COORDS: [number, number] = [40.30, -3.85];

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
      "[feedback route.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/profiles/1/candidates/1/feedback", {
    method: "POST",
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

function ctx(id: number, propertyId: number) {
  return { params: Promise.resolve({ id: String(id), propertyId: String(propertyId) }) };
}

describe.runIf(dbAvailable)("feedback event API — real Postgres", () => {
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
      if (createdProfileIds.length > 0 || createdPropertyIds.length > 0) {
        await pool.query(
          "DELETE FROM feedback_event WHERE profile_id = ANY($1::bigint[]) OR property_id = ANY($2::bigint[])",
          [createdProfileIds, createdPropertyIds],
        );
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE profile_id = ANY($1::bigint[])", [
          createdProfileIds,
        ]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE property_id = ANY($1::bigint[])", [
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

  async function insertProperty(pool: Pool): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', 70, 'Calle de prueba, feedback-int-test') RETURNING id`,
      [TEST_COORDS[0], TEST_COORDS[1]],
    );
    const id = Number(result.rows[0].id);
    createdPropertyIds.push(id);
    return id;
  }

  async function insertListing(pool: Pool, propertyId: number, source: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
       VALUES ($1, $2, $3, 'active', 285000, NOW()) RETURNING id`,
      [propertyId, source, `feedback-int-test-${Math.random().toString(36).slice(2)}`],
    );
    return Number(result.rows[0].id);
  }

  async function makeProfile(): Promise<number> {
    const scope: Scope = {
      geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
      property_types: ["piso"],
      hard_exclusions: {},
    };
    const profile = await createProfile(`feedback-int-test-${Date.now()}-${Math.random()}`, scope, {});
    createdProfileIds.push(profile.id);
    return profile.id;
  }

  async function markMatched(pool: Pool, profileId: number, propertyId: number) {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched)
       VALUES ($1, $2, true)
       ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = true`,
      [profileId, propertyId],
    );
  }

  it("note does not affect accept/reject state", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileId = await makeProfile();
      await markMatched(pool, profileId, propertyId);

      await POST(makeRequest({ feedbackType: "reject" }), ctx(profileId, propertyId));
      const res = await POST(makeRequest({ feedbackType: "note", note: "revisar planos" }), ctx(profileId, propertyId));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.currentState).toBe("reject");
    });
  });

  it("feedback is profile-scoped", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileA = await makeProfile();
      const profileB = await makeProfile();
      await markMatched(pool, profileA, propertyId);
      await markMatched(pool, profileB, propertyId);

      await POST(makeRequest({ feedbackType: "reject" }), ctx(profileA, propertyId));

      const resA = await GET(makeRequest(), ctx(profileA, propertyId));
      const resB = await GET(makeRequest(), ctx(profileB, propertyId));
      expect((await resA.json()).currentState).toBe("reject");
      expect((await resB.json()).currentState).toBeNull();
    });
  });

  it("feedback keyed on property is listing-source-independent", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const idealistaListingId = await insertListing(pool, propertyId, "idealista");
      const fotocasaListingId = await insertListing(pool, propertyId, "fotocasa");
      const profileId = await makeProfile();
      await markMatched(pool, profileId, propertyId);

      const rejectRes = await POST(
        makeRequest({ feedbackType: "reject", listingId: idealistaListingId }),
        ctx(profileId, propertyId),
      );
      expect(rejectRes.status).toBe(201);

      // "Viewed via Fotocasa" is just a different listingId on the same
      // property_id — the state read (not another feedback action) must
      // already reflect the earlier rejection made while looking at the
      // Idealista listing.
      const res = await GET(makeRequest(), ctx(profileId, propertyId));
      const body = await res.json();
      expect(body.currentState).toBe("reject");
      expect(body.history[0].listing_id).toBe(idealistaListingId);
      expect(body.history[0].listing_id).not.toBe(fotocasaListingId);
    });
  });

  it("history is append-only, current state is latest", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileId = await makeProfile();
      await markMatched(pool, profileId, propertyId);

      await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, propertyId));
      await POST(makeRequest({ feedbackType: "reject" }), ctx(profileId, propertyId));
      const finalRes = await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, propertyId));

      expect((await finalRes.json()).currentState).toBe("accept");

      const res = await GET(makeRequest(), ctx(profileId, propertyId));
      const body = await res.json();
      expect(body.currentState).toBe("accept");
      expect(body.history).toHaveLength(3);
      expect(body.history.map((e: { feedback_type: string }) => e.feedback_type)).toEqual([
        "accept",
        "reject",
        "accept",
      ]);
    });
  });

  it("re-recording the already-active state is a no-op, not a new event", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileId = await makeProfile();
      await markMatched(pool, profileId, propertyId);

      await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, propertyId));
      const res = await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, propertyId));
      const body = await res.json();

      expect(body.noop).toBe(true);
      expect(body.history).toHaveLength(1);
    });
  });

  it("returns 404 when the property is not a matched candidate for this profile", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileId = await makeProfile();
      // deliberately not marked matched

      const res = await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, propertyId));
      expect(res.status).toBe(404);
    });
  });

  it("rejects an unrecognized feedback_type with 400", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileId = await makeProfile();
      await markMatched(pool, profileId, propertyId);

      const res = await POST(makeRequest({ feedbackType: "love-it" }), ctx(profileId, propertyId));
      expect(res.status).toBe(400);
    });
  });
});
