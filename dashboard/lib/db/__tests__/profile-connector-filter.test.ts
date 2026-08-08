// @vitest-environment node
/**
 * Unit tests for the profile_connector_filter DB layer (issue #478 P1).
 *
 * Mocks `pg` (the Pool) so the helpers exercise their real SQL shaping without a
 * database — same pattern as capture-task-run.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class MockPool {
    query = mockQuery;
    end = mockEnd;
  },
  // db-shared.ts registers the int8 type parser at module load — the mock needs
  // a minimal stand-in so that import doesn't throw.
  types: { setTypeParser: vi.fn(), builtins: { INT8: 20 } },
}));

import {
  findOverridesForProfile,
  upsertProfileConnectorFilter,
  deleteProfileConnectorFilter,
} from "../profile-connector-filter";
import { resetPool } from "@/lib/db-write";

const ROW = {
  id: 1,
  profile_id: 7,
  connector: "idealista",
  section_key: "",
  url: "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28abc%29%29",
  source: "manual",
  created_at: "2026-08-08T10:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
};

beforeEach(async () => {
  mockQuery.mockReset();
  await resetPool();
});

describe("findOverridesForProfile", () => {
  it("selects all overrides for the profile, newest-updated first, param bound", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] });
    const out = await findOverridesForProfile(7);
    expect(out).toEqual([ROW]);
    const [text, params] = mockQuery.mock.calls[0];
    expect(text).toContain("FROM profile_connector_filter");
    expect(text).toContain("WHERE profile_id = $1");
    expect(text).toContain("ORDER BY updated_at DESC");
    expect(params).toEqual([7]);
  });

  it("returns [] when the profile has no overrides", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await findOverridesForProfile(7)).toEqual([]);
  });
});

describe("upsertProfileConnectorFilter", () => {
  it("upserts with ON CONFLICT DO UPDATE and returns the stored row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] });
    const out = await upsertProfileConnectorFilter({
      profileId: 7,
      connector: "idealista",
      url: ROW.url,
      source: "manual",
    });
    expect(out).toEqual(ROW);
    const [text, params] = mockQuery.mock.calls[0];
    expect(text).toContain("INSERT INTO profile_connector_filter");
    expect(text).toContain("ON CONFLICT (profile_id, connector, section_key)");
    expect(text).toContain("DO UPDATE SET");
    // Default sectionKey is '' when omitted.
    expect(params).toEqual([7, "idealista", "", ROW.url, "manual"]);
  });

  it("passes an explicit sectionKey through", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, section_key: "venta-viviendas" }] });
    await upsertProfileConnectorFilter({
      profileId: 7,
      connector: "idealista",
      sectionKey: "venta-viviendas",
      url: ROW.url,
      source: "extension",
    });
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([7, "idealista", "venta-viviendas", ROW.url, "extension"]);
  });

  it("stores the URL verbatim (shape= not normalised)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] });
    await upsertProfileConnectorFilter({
      profileId: 7,
      connector: "idealista",
      url: ROW.url,
      source: "manual",
    });
    expect(mockQuery.mock.calls[0][1][3]).toBe(ROW.url);
  });
});

describe("deleteProfileConnectorFilter", () => {
  it("returns true when a row was deleted, params bound (default section '')", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const ok = await deleteProfileConnectorFilter(7, "idealista");
    expect(ok).toBe(true);
    const [text, params] = mockQuery.mock.calls[0];
    expect(text).toContain("DELETE FROM profile_connector_filter");
    expect(text).toContain("RETURNING id");
    expect(params).toEqual([7, "idealista", ""]);
  });

  it("returns false when nothing matched", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await deleteProfileConnectorFilter(7, "idealista", "venta-viviendas")).toBe(false);
    expect(mockQuery.mock.calls[0][1]).toEqual([7, "idealista", "venta-viviendas"]);
  });
});
