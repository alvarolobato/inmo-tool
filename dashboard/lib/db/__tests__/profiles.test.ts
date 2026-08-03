import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class MockPool {
    query = mockQuery;
    end = mockEnd;
  },
  // db-shared.ts (#155) registers the int8 type parser at module load — the
  // mock needs a minimal stand-in so that import doesn't throw.
  types: { setTypeParser: vi.fn(), builtins: { INT8: 20 } },
}));

import {
  listActiveProfileEntries,
  listActiveProfiles,
  toProfileListEntry,
  touchProfileViewedAt,
  type ProfileListEntry,
} from "../profiles";
import { resetPool } from "@/lib/db-write";

const VALID_SCOPE = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
  property_types: ["piso"],
};

function rawRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    name: "Perfil válido",
    scope: VALID_SCOPE,
    thesis_params: {},
    archived_at: null,
    created_at: "2026-08-02T00:00:00.000Z",
    last_materialized_at: null,
    last_viewed_at: null,
    ...overrides,
  };
}

beforeEach(async () => {
  mockQuery.mockReset();
  mockEnd.mockClear();
  await resetPool();
});

describe("toProfileListEntry (issue #113)", () => {
  it("returns {ok: true, profile} for a row with a valid scope", () => {
    const entry = toProfileListEntry(rawRow());
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.profile.id).toBe(1);
      expect(entry.profile.name).toBe("Perfil válido");
    }
  });

  it("returns {ok: false, id, name, issues} for a row with the DB default '{}' scope, rather than null", () => {
    // Regression target: this is exactly the DB-level default (now dropped,
    // see D-010) that used to be silently skipped by toSearchProfileRowSafe.
    const entry = toProfileListEntry(rawRow({ id: 42, name: "Perfil roto", scope: {} }));
    expect(entry.ok).toBe(false);
    if (!entry.ok) {
      expect(entry.id).toBe(42);
      expect(entry.name).toBe("Perfil roto");
      expect(entry.issues.length).toBeGreaterThan(0);
      // Names the actual missing field, not just "invalid" — the operator
      // needs to see *what's* wrong to act on it (issue #113 acceptance
      // criteria: "the operator can act on it... without needing direct
      // database access").
      expect(entry.issues.some((i) => i.includes("geography"))).toBe(true);
    }
  });

  it("returns {ok: false, ...} for a malformed thesis_params, distinct from a scope issue", () => {
    const entry = toProfileListEntry(
      rawRow({ id: 7, thesis_params: { rent_assumption: { eur_per_m2_month: -5 } } }),
    );
    expect(entry.ok).toBe(false);
    if (!entry.ok) {
      expect(entry.issues.some((i) => i.startsWith("thesis_params"))).toBe(true);
    }
  });

  it("never throws on a malformed row (safe-parse, not parse)", () => {
    expect(() => toProfileListEntry(rawRow({ scope: null }))).not.toThrow();
    expect(() => toProfileListEntry(rawRow({ scope: "not an object" }))).not.toThrow();
  });
});

describe("listActiveProfileEntries (issue #113)", () => {
  it("includes a malformed-scope row as {ok: false, ...} alongside valid rows, rather than dropping it", async () => {
    mockQuery.mockResolvedValue({
      rows: [rawRow({ id: 1, scope: {} }), rawRow({ id: 2, name: "Válido" })],
    });
    const entries: ProfileListEntry[] = await listActiveProfileEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ ok: false, id: 1, name: "Perfil válido", issues: expect.any(Array) });
    expect(entries[1].ok).toBe(true);
    if (entries[1].ok) expect(entries[1].profile.id).toBe(2);
  });

  it("queries only non-archived profiles, ordered by created_at DESC", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await listActiveProfileEntries();
    const [sqlText] = mockQuery.mock.calls[0];
    expect(String(sqlText)).toContain("WHERE archived_at IS NULL");
    expect(String(sqlText)).toContain("ORDER BY created_at DESC");
  });

  it("selects last_materialized_at and last_viewed_at (issue #191)", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await listActiveProfileEntries();
    const [sqlText] = mockQuery.mock.calls[0];
    expect(String(sqlText)).toContain("last_materialized_at");
    expect(String(sqlText)).toContain("last_viewed_at");
  });
});

describe("listActiveProfiles (backward-compatible plain shape)", () => {
  it("filters out malformed-scope rows — GET /api/profiles's existing contract is unchanged by issue #113", async () => {
    mockQuery.mockResolvedValue({
      rows: [rawRow({ id: 1, scope: {} }), rawRow({ id: 2, name: "Válido" })],
    });
    const profiles = await listActiveProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe(2);
  });
});

describe("touchProfileViewedAt (issue #191)", () => {
  it("issues an UPDATE setting last_viewed_at = NOW() for the given id", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await touchProfileViewedAt(5);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET last_viewed_at = NOW()"),
      [5],
    );
  });

  it("propagates a DB failure to the caller (callers are responsible for best-effort catch)", async () => {
    mockQuery.mockRejectedValue(new Error("connection lost"));
    await expect(touchProfileViewedAt(5)).rejects.toThrow("connection lost");
  });
});
