/**
 * Digest scheduling DB layer — unit tests (issue #35, Phase 5.5 v1).
 *
 * `@/lib/db-write` is mocked, so the row mapping (`listDigestProfiles`) and the
 * INSERT+RETURNING (`recordDigestRun`) are exercised without a live Postgres.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sql = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>();
vi.mock("@/lib/db-write", () => ({ sql: (t: string, p?: unknown[]) => sql(t, p) }));

import { listDigestProfiles, recordDigestRun } from "../digest";

beforeEach(() => sql.mockReset());

describe("listDigestProfiles", () => {
  it("maps raw rows to DigestProfile, carrying cadence, email override and last watermark", async () => {
    sql.mockResolvedValue([
      { id: 1, name: "Madrid", digest_cadence: "daily", digest_email: "p@x", last_sent_at: "2026-08-04T07:00:00Z" },
      { id: 2, name: "Off one", digest_cadence: "off", digest_email: null, last_sent_at: null },
    ]);
    const rows = await listDigestProfiles();
    expect(rows).toEqual([
      { id: 1, name: "Madrid", cadence: "daily", email: "p@x", lastSentAt: "2026-08-04T07:00:00Z" },
      { id: 2, name: "Off one", cadence: "off", email: null, lastSentAt: null },
    ]);
    // Only active (non-archived) profiles, and the per-profile last-run subquery.
    const text = sql.mock.calls[0][0] as string;
    expect(text).toContain("archived_at IS NULL");
    expect(text).toContain("FROM digest_run");
  });
});

describe("recordDigestRun", () => {
  it("inserts a run row and returns the new sent_at watermark", async () => {
    sql.mockResolvedValue([{ sent_at: "2026-08-05T07:00:00.000Z" }]);
    const at = await recordDigestRun(7, 3, true);
    expect(at).toBe("2026-08-05T07:00:00.000Z");
    expect(sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO digest_run"), [7, 3, true]);
  });
});
