// @vitest-environment node
/**
 * Unit tests for the worklist-seed trigger DB helpers (issue #260).
 *
 * Mocks @/lib/db-write's `sql` so no real Postgres is needed here — the "does a
 * real seed trigger get claimed and run" half lives in
 * etl/tests/test_worklist_seed.py. This pins the SQL these helpers emit and how
 * they shape their results.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db-write", () => ({ sql: vi.fn() }));

import {
  createWorklistSeedTrigger,
  getPendingWorklistSeedTrigger,
} from "../worklist-seed";
import { sql } from "@/lib/db-write";

const mockSql = vi.mocked(sql);

describe("createWorklistSeedTrigger", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a pending row for the portal and returns its id", async () => {
    mockSql.mockResolvedValue([{ id: 11 }]);
    const id = await createWorklistSeedTrigger("cimenta2");
    expect(id).toBe(11);
    const [text, params] = mockSql.mock.calls[0];
    expect(text).toContain("INSERT INTO capture_worklist_seed_trigger");
    expect(text).toContain("'pending'");
    expect(params).toEqual(["cimenta2", "dashboard"]);
  });

  it("passes through an explicit triggeredBy", async () => {
    mockSql.mockResolvedValue([{ id: 3 }]);
    await createWorklistSeedTrigger("cimenta2", "cli");
    expect(mockSql.mock.calls[0][1]).toEqual(["cimenta2", "cli"]);
  });
});

describe("getPendingWorklistSeedTrigger", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the pending row for the portal", async () => {
    const row = {
      id: 9,
      source_portal: "cimenta2",
      status: "pending" as const,
      added_count: null,
      error_msg: null,
      triggered_by: "dashboard",
      requested_at: "2026-08-05T00:00:00.000Z",
      picked_up_at: null,
      finished_at: null,
    };
    mockSql.mockResolvedValue([row]);
    const got = await getPendingWorklistSeedTrigger("cimenta2");
    expect(got).toEqual(row);
    const [text, params] = mockSql.mock.calls[0];
    expect(text).toContain("FROM capture_worklist_seed_trigger");
    expect(text).toContain("status = 'pending'");
    expect(params).toEqual(["cimenta2"]);
  });

  it("returns null when nothing is pending", async () => {
    mockSql.mockResolvedValue([]);
    expect(await getPendingWorklistSeedTrigger("cimenta2")).toBeNull();
  });
});
