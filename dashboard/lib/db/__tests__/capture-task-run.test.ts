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

import { getTaskRuns, recordTaskRun, getPortalCaptureActivity } from "../capture-task-run";
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
    expect(params).toEqual([7, "t1"]);
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
