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
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await materializeProfile(1);

    expect(result).toEqual({ profileId: 1, matched: 2, unmatched: 1 });

    const selectCall = mockClientQuery.mock.calls[1];
    expect(selectCall[0]).toContain("SELECT property.id FROM property WHERE");

    const upsertCall = mockClientQuery.mock.calls[2];
    expect(upsertCall[0]).toContain("ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = true");
    expect(upsertCall[1]).toEqual([1, [10, 11]]);

    const unmatchCall = mockClientQuery.mock.calls[3];
    expect(unmatchCall[0]).toContain("SET matched = false");
    expect(unmatchCall[0]).toContain("property_id <> ALL($2::bigint[])");
    expect(unmatchCall[1]).toEqual([1, [10, 11]]);
  });

  it("unmatches every previously-matched row when the new matching set is empty, without an INSERT (EC-2 edge case)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [profileRow()] });

    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT -> zero matches
      .mockResolvedValueOnce({ rowCount: 3 }) // UPDATE ... matched = false (all previously matched)
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await materializeProfile(1);

    expect(result).toEqual({ profileId: 1, matched: 0, unmatched: 3 });
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

    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const results = await materializeAllProfiles();

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.profileId)).toEqual([1, 2]);
  });
});
