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
      columns: ["portal", "signature", "detected_at"],
      rows: [
        ["idealista", "captcha_wall", new Date("2026-08-20T10:00:00.000Z")],
        ["aliseda", "geetest_challenge", new Date("2026-08-19T09:00:00.000Z")],
      ],
    });

    const result = await getRecentBlockEpisodes();

    expect(result).toEqual([
      { portal: "idealista", signature: "captcha_wall", detected_at: "2026-08-20T10:00:00.000Z" },
      { portal: "aliseda", signature: "geetest_challenge", detected_at: "2026-08-19T09:00:00.000Z" },
    ]);
    const [text] = mockQuery.mock.calls[0];
    expect(text).toMatch(/ORDER BY detected_at DESC/);
  });

  it("returns an empty array when there are no episodes", async () => {
    mockQuery.mockResolvedValue({ columns: [], rows: [] });
    expect(await getRecentBlockEpisodes()).toEqual([]);
  });
});
