// @vitest-environment node
/**
 * Unit tests for POST /api/extension/block-episode (issue #634) — the
 * browser-extension's block/challenge episode report. Same admin-gating
 * pattern as capture/heartbeat; mocks @/lib/db/extension-blocks so no real
 * DB connection is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/extension-blocks", () => ({
  recordBlockEpisode: vi.fn(),
}));

import { POST } from "../block-episode/route";
import * as db from "@/lib/db/extension-blocks";

const mockRecord = vi.mocked(db.recordBlockEpisode);

const ADMIN_KEY = "test-admin-key";

function makeRequest(
  body: Record<string, unknown> | null,
  opts: { adminKey?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest("http://localhost:4000/api/extension/block-episode", {
    method: "POST",
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/extension/block-episode", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid admin key and never writes", async () => {
    const res = await POST(
      makeRequest({ portal: "idealista", signature: "captcha_wall" }),
    );
    expect(res.status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("returns 400 when portal is missing", async () => {
    const res = await POST(
      makeRequest({ signature: "captcha_wall" }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("returns 400 when signature is missing", async () => {
    const res = await POST(makeRequest({ portal: "idealista" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty-string portal (not just an absent one)", async () => {
    const res = await POST(
      makeRequest({ portal: "  ", signature: "captcha_wall" }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("records a valid episode with the given detectedAt", async () => {
    mockRecord.mockResolvedValue(undefined);
    const res = await POST(
      makeRequest(
        { portal: "idealista", signature: "captcha_wall", detectedAt: "2026-08-20T10:00:00.000Z" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [portal, signature, detectedAt] = mockRecord.mock.calls[0];
    expect(portal).toBe("idealista");
    expect(signature).toBe("captcha_wall");
    expect((detectedAt as Date).toISOString()).toBe("2026-08-20T10:00:00.000Z");
  });

  it("falls back to now() for a missing/invalid detectedAt rather than rejecting", async () => {
    mockRecord.mockResolvedValue(undefined);
    const res = await POST(
      makeRequest(
        { portal: "idealista", signature: "captcha_wall", detectedAt: "not-a-date" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const [, , detectedAt] = mockRecord.mock.calls[0];
    expect(Number.isNaN((detectedAt as Date).getTime())).toBe(false);
  });

  it("never accepts/stores page content or a raw URL — only portal/signature/detectedAt are read", async () => {
    mockRecord.mockResolvedValue(undefined);
    await POST(
      makeRequest(
        {
          portal: "idealista",
          signature: "captcha_wall",
          html: "<html>full page content</html>",
          url: "https://www.idealista.com/inmueble/12345/",
        },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(mockRecord).toHaveBeenCalledWith("idealista", "captcha_wall", expect.any(Date));
  });

  it("returns 500 when the DB write fails", async () => {
    mockRecord.mockRejectedValue(new Error("connection refused"));
    const res = await POST(
      makeRequest({ portal: "idealista", signature: "captcha_wall" }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(500);
  });
});
