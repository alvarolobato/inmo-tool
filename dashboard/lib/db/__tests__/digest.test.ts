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
  it("maps raw rows to DigestProfile, carrying cadence, email override and BOTH watermarks", async () => {
    sql.mockResolvedValue([
      { id: 1, name: "Madrid", digest_cadence: "daily", digest_email: "p@x", last_sent_at: "2026-08-04T07:00:00Z", last_seguimiento_at: "2026-08-05T08:00:00Z" },
      { id: 2, name: "Off one", digest_cadence: "off", digest_email: null, last_sent_at: null, last_seguimiento_at: null },
    ]);
    const rows = await listDigestProfiles();
    expect(rows).toEqual([
      { id: 1, name: "Madrid", cadence: "daily", email: "p@x", lastSentAt: "2026-08-04T07:00:00Z", lastSeguimientoAt: "2026-08-05T08:00:00Z" },
      { id: 2, name: "Off one", cadence: "off", email: null, lastSentAt: null, lastSeguimientoAt: null },
    ]);
    // Only active profiles; both per-kind watermark subqueries (#428).
    const text = sql.mock.calls[0][0] as string;
    expect(text).toContain("archived_at IS NULL");
    expect(text).toContain("kind = 'digest'");
    expect(text).toContain("kind = 'seguimiento'");
  });
});

describe("recordDigestRun", () => {
  it("inserts a run row (defaulting kind='digest') and returns the new sent_at watermark", async () => {
    sql.mockResolvedValue([{ sent_at: "2026-08-05T07:00:00.000Z" }]);
    const at = await recordDigestRun(7, 3, true);
    expect(at).toBe("2026-08-05T07:00:00.000Z");
    expect(sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO digest_run"), [7, 3, true, "digest"]);
  });

  it("#428: records a seguimiento run under kind='seguimiento'", async () => {
    sql.mockResolvedValue([{ sent_at: "2026-08-05T09:00:00.000Z" }]);
    await recordDigestRun(7, 1, false, "seguimiento");
    expect(sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO digest_run"), [7, 1, false, "seguimiento"]);
  });
});
