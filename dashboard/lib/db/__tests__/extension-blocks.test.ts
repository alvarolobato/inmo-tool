// @vitest-environment node
/**
 * Unit tests for recordBlockEpisode/getRecentBlockEpisodes (issue #634).
 * @/lib/db-write's `sql` and @/lib/db's `query` are mocked — no real DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSql, mockQuery } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockQuery: vi.fn(),
}));

vi.mock("@/lib/db-write", () => ({ sql: mockSql }));
vi.mock("@/lib/db", () => ({ query: mockQuery }));

import { recordBlockEpisode, getRecentBlockEpisodes } from "../extension-blocks";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordBlockEpisode", () => {
  it("inserts portal, signature, and the ISO detectedAt — nothing else", async () => {
    mockSql.mockResolvedValue([]);
    const detectedAt = new Date("2026-08-20T10:00:00.000Z");
    await recordBlockEpisode("idealista", "captcha_wall", detectedAt);

    expect(mockSql).toHaveBeenCalledTimes(1);
    const [text, params] = mockSql.mock.calls[0];
    expect(text).toMatch(/INSERT INTO extension_block_episode/);
    expect(params).toEqual(["idealista", "captcha_wall", "2026-08-20T10:00:00.000Z"]);
  });
});

describe("getRecentBlockEpisodes", () => {
  it("maps rows newest-first into the client-safe shape", async () => {
    mockQuery.mockResolvedValue({
      columns: ["portal", "signature", "detected_at", "resolved_at"],
      rows: [
        ["idealista", "captcha_wall", new Date("2026-08-20T10:00:00.000Z"), null],
        [
          "aliseda",
          "geetest_challenge",
          new Date("2026-08-19T09:00:00.000Z"),
          new Date("2026-08-19T11:30:00.000Z"),
        ],
      ],
    });

    const result = await getRecentBlockEpisodes();

    expect(result).toEqual([
      {
        portal: "idealista",
        signature: "captcha_wall",
        detected_at: "2026-08-20T10:00:00.000Z",
        resolved_at: null,
      },
      {
        portal: "aliseda",
        signature: "geetest_challenge",
        detected_at: "2026-08-19T09:00:00.000Z",
        resolved_at: "2026-08-19T11:30:00.000Z",
      },
    ]);
    const [text] = mockQuery.mock.calls[0];
    expect(text).toMatch(/ORDER BY l\.detected_at DESC/);
  });

  it("derives resolution from the capture ledger, keyed and clocked correctly", async () => {
    // Issue #711 / D-169. Four properties of the SQL, each of which was wrong
    // (or absent) in the version that put a three-hour-stale "idealista
    // bloqueado" alarm on the owner's board while idealista was ingesting:
    mockQuery.mockResolvedValue({ columns: [], rows: [] });
    await getRecentBlockEpisodes();
    const [text, params] = mockQuery.mock.calls[0];

    // 1. Resolution comes from extension_capture, correlated to THIS episode.
    expect(text).toMatch(/LEFT JOIN LATERAL/);
    expect(text).toMatch(/FROM extension_capture ec/);
    // 2. Per portal — a hipoges recovery must never clear an idealista wall.
    expect(text).toMatch(/ec\.connector_name = l\.portal/);
    // 3. Strictly AFTER the block, against a server-clock anchor.
    //    `detected_at` alone is the extension's CLIENT clock; comparing it to a
    //    server-stamped created_at is a cross-clock comparison a skewed laptop
    //    can win, in the direction that silences the alarm early.
    expect(text).toMatch(/GREATEST\(detected_at, reported_at\)/);
    expect(text).toMatch(/ec\.created_at > l\.block_anchor/);
    // 4. Only outcomes that prove the portal SERVED us the page clear a block.
    //    Not 'blocked' (the wall), not 'never_rendered' (asserts only that we
    //    ran out of patience — exactly what a slow challenge page produces),
    //    not 'failed' (bytes arrived, the parser rejected them).
    expect(params[0]).toEqual(["done", "withdrawn", "listing"]);
    for (const excluded of ["blocked", "never_rendered", "failed", "pending"]) {
      expect(params[0]).not.toContain(excluded);
    }
  });

  it("asks for one row PER PORTAL, so a noisy portal can't hide a quiet one", async () => {
    // PR #710 review. This read feeds a per-portal STATE derivation
    // (activeBlocksByPortal → Estado's aviso chip, Fuentes' block banner), not
    // a history table. A flat `LIMIT 20` over all episodes meant 20 detections
    // on one portal inside the 24 h window pushed every other portal's
    // still-active block off the end and its chip silently vanished.
    mockQuery.mockResolvedValue({ columns: [], rows: [] });
    await getRecentBlockEpisodes();

    const [text, params] = mockQuery.mock.calls[0];
    expect(text).toMatch(/DISTINCT ON \(portal\)/);
    expect(text).toMatch(/ORDER BY portal, detected_at DESC/);
    // The bound is a PORTAL count now, not an episode count.
    expect(params[1]).toBe(20);
  });

  it("returns an empty array when there are no episodes", async () => {
    mockQuery.mockResolvedValue({ columns: [], rows: [] });
    expect(await getRecentBlockEpisodes()).toEqual([]);
  });
});
