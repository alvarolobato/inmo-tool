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
  getTaskRuns,
  recordTaskRun,
  getPortalCaptureActivity,
  getProfileConnectorCaptured,
} from "../capture-task-run";
import { resetPool } from "@/lib/db-write";

beforeEach(async () => {
  mockQuery.mockReset();
  await resetPool();
});

describe("getTaskRuns", () => {
  it("returns a { task_id: last_run_at } map with ISO timestamps", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { task_id: "t1", last_run_at: "2026-08-01T00:00:00.000Z" },
        { task_id: "t2", last_run_at: new Date("2026-08-02T00:00:00.000Z") },
      ],
    });
    const out = await getTaskRuns(7);
    expect(out).toEqual({
      t1: "2026-08-01T00:00:00.000Z",
      t2: "2026-08-02T00:00:00.000Z",
    });
    // Scoped to the profile id.
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([7]);
  });

  it("returns {} when the profile has no runs", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getTaskRuns(7)).toEqual({});
  });
});

describe("recordTaskRun", () => {
  it("upserts and returns the stored ISO timestamp", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ last_run_at: "2026-08-05T12:00:00.000Z" }] });
    const iso = await recordTaskRun(7, "t1");
    expect(iso).toBe("2026-08-05T12:00:00.000Z");
    const [text, params] = mockQuery.mock.calls[0];
    expect(text).toContain("INSERT INTO capture_task_run");
    expect(text).toContain("ON CONFLICT (profile_id, task_id)");
    expect(text).toContain("last_result_count");
    // No count passed → NULL for the 3rd param (issue #376).
    expect(params).toEqual([7, "t1", null]);
  });

  it("persists a provided result count (issue #376)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ last_run_at: "2026-08-05T12:00:00.000Z" }] });
    await recordTaskRun(7, "t1", 42);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([7, "t1", 42]);
  });

  it("floors/clamps a non-integer or negative count to a sane value", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ last_run_at: "2026-08-05T12:00:00.000Z" }] });
    await recordTaskRun(7, "t1", 12.9);
    expect(mockQuery.mock.calls[0][1]).toEqual([7, "t1", 12]);
    mockQuery.mockResolvedValueOnce({ rows: [{ last_run_at: "2026-08-05T12:00:00.000Z" }] });
    await recordTaskRun(7, "t1", -5);
    expect(mockQuery.mock.calls[1][1]).toEqual([7, "t1", 0]);
  });

  it("normalises a Date return to ISO", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ last_run_at: new Date("2026-08-05T12:00:00.000Z") }] });
    expect(await recordTaskRun(7, "t1")).toBe("2026-08-05T12:00:00.000Z");
  });

  it("falls back to an ISO string when the row is empty", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const iso = await recordTaskRun(7, "t1");
    expect(() => new Date(iso).toISOString()).not.toThrow();
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});

describe("getPortalCaptureActivity", () => {
  it("aggregates done extension_capture rows per portal by URL host", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { url: "https://www.idealista.com/inmueble/1/", created_at: "2026-08-01T00:00:00.000Z" },
        { url: "https://www.idealista.com/inmueble/2/", created_at: new Date("2026-08-04T00:00:00.000Z") },
        { url: "https://www.alisedainmobiliaria.com/inmueble/A/", created_at: "2026-08-02T00:00:00.000Z" },
      ],
    });
    const out = await getPortalCaptureActivity();
    const byPortal = Object.fromEntries(out.map((a) => [a.portal, a]));
    expect(byPortal.idealista).toEqual({
      portal: "idealista",
      captured: 2,
      lastCapturedAt: "2026-08-04T00:00:00.000Z",
    });
    expect(byPortal.aliseda).toEqual({
      portal: "aliseda",
      captured: 1,
      lastCapturedAt: "2026-08-02T00:00:00.000Z",
    });
    // Only 'done' rows are queried (status filter is in the SQL).
    const [text] = mockQuery.mock.calls[0];
    expect(text).toContain("FROM extension_capture");
    expect(text).toContain("status = 'done'");
  });

  it("returns zero/null entries for every portal when there are no captures", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await getPortalCaptureActivity();
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const a of out) {
      expect(a.captured).toBe(0);
      expect(a.lastCapturedAt).toBeNull();
    }
  });

  it("skips rows whose URL matched the ILIKE but is not a real portal host", async () => {
    // e.g. a URL that merely contains 'idealista.com' in its path/query.
    mockQuery.mockResolvedValueOnce({
      rows: [{ url: "https://example.com/redirect?to=idealista.com", created_at: "2026-08-01T00:00:00.000Z" }],
    });
    const out = await getPortalCaptureActivity();
    for (const a of out) expect(a.captured).toBe(0);
  });
});

describe("getProfileConnectorCaptured (issue #430)", () => {
  it("builds a profileId → { connector: count } map from grouped rows", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { profile_id: 1, connector_name: "idealista", captured: 3 },
        { profile_id: 1, connector_name: "aliseda", captured: 1 },
        // pg may hand back COUNT() as a string — must be coerced to a number.
        { profile_id: 2, connector_name: "idealista", captured: "5" },
      ],
    });
    const out = await getProfileConnectorCaptured([1, 2], ["idealista", "aliseda"]);
    expect(out.get(1)).toEqual({ idealista: 3, aliseda: 1 });
    expect(out.get(2)).toEqual({ idealista: 5 });
  });

  it("scopes the query to the given profile ids and connectors, params bound", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getProfileConnectorCaptured([7, 9], ["idealista"]);
    const [text, params] = mockQuery.mock.calls[0];
    // Joins captures to the profile link and counts DISTINCT properties.
    expect(text).toContain("FROM extension_capture");
    expect(text).toContain("JOIN profile_listing_state");
    expect(text).toContain("COUNT(DISTINCT ec.property_id)");
    expect(text).toContain("status = 'done'");
    expect(text).toContain("matched = true");
    expect(text).toContain("property_id IS NOT NULL");
    // $1 = profile ids, $2 = connector names — de-duplicated, bounded.
    expect(params).toEqual([[7, 9], ["idealista"]]);
  });

  it("de-duplicates ids/connectors and short-circuits on empty inputs", async () => {
    const emptyIds = await getProfileConnectorCaptured([], ["idealista"]);
    const emptyConns = await getProfileConnectorCaptured([1], []);
    expect(emptyIds.size).toBe(0);
    expect(emptyConns.size).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getProfileConnectorCaptured([1, 1, 2], ["idealista", "idealista"]);
    expect(mockQuery.mock.calls[0][1]).toEqual([[1, 2], ["idealista"]]);
  });
});
