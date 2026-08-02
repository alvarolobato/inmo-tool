import { describe, it, expect, vi, beforeEach } from "vitest";

// Two distinct query surfaces to mock: lib/db/profiles.ts's getProfileById/
// listActiveProfiles use the plain pool.query() (via lib/db-write's sql()),
// while materialize.ts itself runs its filter+upsert inside withTransaction
// (pool.connect() -> client.query()). Same split as lib/__tests__/db-write.test.ts.
const mockPoolQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockClient = { query: mockClientQuery, release: mockRelease };
const mockConnect = vi.fn().mockResolvedValue(mockClient);
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class {
    connect = mockConnect;
    end = mockEnd;
    query = mockPoolQuery;
  },
}));

// Task 3.4 (#23): materializeProfile now calls scoreNewCandidates after its
// own transaction commits. This file's mocks only simulate the match/unmatch
// upsert's own query sequence — the scoring pipeline (and whichever extra
// pool.query() calls it would make) has its own dedicated tests
// (pipeline.test.ts) and a real-Postgres integration test proving the actual
// wiring; stub it out here so this file keeps testing exactly what it always
// tested, not scoring internals it isn't about. vi.hoisted() (not a plain
// `const mock... = vi.fn()`) is required here — vitest's automatic
// mock-prefixed-variable hoisting didn't pick up a chained
// `.mockResolvedValue(...)` initializer, only a bare `vi.fn()`, and left the
// variable in the TDZ when the hoisted vi.mock factory below tried to close
// over it.
const { mockScoreNewCandidates } = vi.hoisted(() => ({ mockScoreNewCandidates: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/scoring/pipeline", () => ({ scoreNewCandidates: mockScoreNewCandidates }));

import { materializeProfile, materializeAllProfiles } from "../materialize";
import { resetPool } from "@/lib/db-write";

const VALID_SCOPE = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
  property_types: ["piso"],
  hard_exclusions: {},
};

function profileRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    name: "Test profile",
    scope: VALID_SCOPE,
    thesis_params: {},
    archived_at: null,
    created_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(mockClient);
  await resetPool();
});

describe("materializeProfile", () => {
  it("returns null for a non-existent profile without starting a transaction", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // getProfileById -> not found

    const result = await materializeProfile(999);

    expect(result).toBeNull();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("returns null for an archived profile without starting a transaction", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [profileRow({ archived_at: "2026-08-01T00:00:00Z" })] });

    const result = await materializeProfile(1);

    expect(result).toBeNull();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("upserts matched properties with matched=true and unmatches previously-matched rows no longer in the set (EC-2)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [profileRow()] }); // getProfileById

    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 11 }] }) // SELECT property.id WHERE ...
      .mockResolvedValueOnce({ rowCount: 2 }) // INSERT ... ON CONFLICT DO UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE ... matched = false
      .mockResolvedValueOnce({ rows: [{ count: "1" }] }) // SELECT COUNT(*) ... matched = false
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await materializeProfile(1);

    // Both fields are current totals (a snapshot after this run), not
    // this-run deltas — matchedCount is the size of the matching set itself,
    // unmatchedCount comes from a fresh COUNT (Opus review, PR #57: the
    // original version mixed a total with a this-run delta under
    // confusingly similar field names).
    expect(result).toEqual({ profileId: 1, matchedCount: 2, unmatchedCount: 1 });

    const selectCall = mockClientQuery.mock.calls[1];
    expect(selectCall[0]).toContain("SELECT property.id FROM property WHERE");

    const upsertCall = mockClientQuery.mock.calls[2];
    expect(upsertCall[0]).toContain("ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = true");
    expect(upsertCall[1]).toEqual([1, [10, 11]]);

    const unmatchCall = mockClientQuery.mock.calls[3];
    expect(unmatchCall[0]).toContain("SET matched = false");
    expect(unmatchCall[0]).toContain("property_id <> ALL($2::bigint[])");
    expect(unmatchCall[1]).toEqual([1, [10, 11]]);

    const countCall = mockClientQuery.mock.calls[4];
    expect(countCall[0]).toContain("SELECT COUNT(*) FROM profile_listing_state");
    expect(countCall[1]).toEqual([1]);
  });

  it("unmatches every previously-matched row when the new matching set is empty, without an INSERT (EC-2 edge case)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [profileRow()] });

    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT -> zero matches
      .mockResolvedValueOnce({ rowCount: 3 }) // UPDATE ... matched = false (all previously matched)
      .mockResolvedValueOnce({ rows: [{ count: "3" }] }) // SELECT COUNT(*) ... matched = false
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await materializeProfile(1);

    expect(result).toEqual({ profileId: 1, matchedCount: 0, unmatchedCount: 3 });
    // No INSERT statement should run when matchedIds is empty.
    const queries = mockClientQuery.mock.calls.map((c) => c[0]);
    expect(queries.some((q) => typeof q === "string" && q.includes("INSERT INTO profile_listing_state"))).toBe(
      false,
    );
  });

  it("passes the profile's own scope-derived WHERE/params through unmodified to the SELECT", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [profileRow({ scope: { ...VALID_SCOPE, price_min: 100000 } })],
    });
    mockClientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce(undefined);

    await materializeProfile(1);

    const selectCall = mockClientQuery.mock.calls[1];
    // price_min's scalar subquery condition should have made it into the SELECT.
    expect(selectCall[0]).toContain("SELECT MIN(listing.current_price) FROM listing");
    expect(selectCall[1]).toContain(100000);
  });
});

describe("materializeAllProfiles", () => {
  it("materializes every active profile and skips archived ones (listActiveProfiles already excludes them)", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [profileRow({ id: 1 }), profileRow({ id: 2 })] }) // listActiveProfiles
      .mockResolvedValueOnce({ rows: [profileRow({ id: 1 })] }) // getProfileById(1) inside materializeProfile
      .mockResolvedValueOnce({ rows: [profileRow({ id: 2 })] }); // getProfileById(2)

    // Generic per-query-shape stub rather than a strict sequence: this test
    // covers materializeAllProfiles' aggregation, not materializeProfile's
    // own query correctness (covered above) — but it still has to return a
    // real `count` row for the COUNT(*) query, or `Number(rows[0].count)`
    // throws on `rows[0]` being undefined.
    mockClientQuery.mockImplementation((sql: unknown) => {
      if (typeof sql === "string" && sql.includes("SELECT COUNT(*)")) {
        return Promise.resolve({ rows: [{ count: "0" }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const results = await materializeAllProfiles();

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(results.map((r) => r.profileId)).toEqual([1, 2]);
  });

  it("isolates one profile's failure so the others' results are still reported, not lost in an all-or-nothing throw", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [profileRow({ id: 1 }), profileRow({ id: 2 })] }) // listActiveProfiles
      .mockResolvedValueOnce({ rows: [profileRow({ id: 1 })] }) // getProfileById(1)
      .mockResolvedValueOnce({ rows: [profileRow({ id: 2 })] }); // getProfileById(2)

    let call = 0;
    mockClientQuery.mockImplementation((sql: unknown) => {
      call += 1;
      // Profile 1's transaction: BEGIN then blow up on the SELECT.
      if (call === 2) {
        return Promise.reject(new Error("simulated DB error for profile 1"));
      }
      if (typeof sql === "string" && sql.includes("SELECT COUNT(*)")) {
        return Promise.resolve({ rows: [{ count: "0" }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const results = await materializeAllProfiles();

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      status: "error",
      profileId: 1,
      error: "simulated DB error for profile 1",
    });
    expect(results[1].status).toBe("ok");
    expect(results[1].profileId).toBe(2);
  });
});
