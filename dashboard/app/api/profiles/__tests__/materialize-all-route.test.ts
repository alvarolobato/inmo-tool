// @vitest-environment node
/**
 * Unit tests for POST /api/profiles/materialize-all (issue #94).
 *
 * This endpoint became a real network-facing, cross-container write trigger
 * when the Python connector orchestrator started calling it after every run,
 * so it gained the same admin-key gate `/api/admin/*` and the extension
 * capture route use. Before that it was completely unauthenticated —
 * `middleware.ts`'s matcher covers `/api/admin/*` and `/api/etl/*` but not
 * `/api/profiles/*`, so nothing else would have caught it.
 *
 * Mocks the filtering layer so no real DB connection is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/filtering/materialize", () => ({
  materializeAllProfiles: vi.fn(),
}));

import { POST } from "../materialize-all/route";
import * as materialize from "@/lib/filtering/materialize";

const mockMaterializeAll = vi.mocked(materialize.materializeAllProfiles);

const ADMIN_KEY = "test-admin-key";

function makeRequest(opts: { adminKey?: string; bearer?: string; cookie?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers["cookie"] = `ps_admin=${opts.cookie}`;
  return new NextRequest("http://localhost:4000/api/profiles/materialize-all", {
    method: "POST",
    headers,
    body: JSON.stringify({ trigger: "test" }),
  });
}

describe("POST /api/profiles/materialize-all", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
    mockMaterializeAll.mockResolvedValue([]);
  });

  it("rejects a request with no credentials", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    // The load-bearing assertion: an unauthenticated caller must not be able
    // to trigger a full re-materialize + rescore of every profile.
    expect(mockMaterializeAll).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong admin key", async () => {
    const res = await POST(makeRequest({ adminKey: "not-the-key" }));
    expect(res.status).toBe(401);
    expect(mockMaterializeAll).not.toHaveBeenCalled();
  });

  it("accepts the x-admin-key header (how the ETL container calls it)", async () => {
    const res = await POST(makeRequest({ adminKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    expect(mockMaterializeAll).toHaveBeenCalledTimes(1);
  });

  it("accepts Authorization: Bearer", async () => {
    const res = await POST(makeRequest({ bearer: ADMIN_KEY }));
    expect(res.status).toBe(200);
    expect(mockMaterializeAll).toHaveBeenCalledTimes(1);
  });

  it("accepts the ps_admin session cookie (same-origin operator call)", async () => {
    const res = await POST(makeRequest({ cookie: ADMIN_KEY }));
    expect(res.status).toBe(200);
    expect(mockMaterializeAll).toHaveBeenCalledTimes(1);
  });

  it("fails closed when ADMIN_API_KEY is unset", async () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    const res = await POST(makeRequest({ adminKey: "anything" }));
    expect(res.status).toBe(401);
    expect(mockMaterializeAll).not.toHaveBeenCalled();
  });

  it("returns per-profile results on success", async () => {
    mockMaterializeAll.mockResolvedValue([
      { status: "ok", profileId: 1, matchedCount: 3, unmatchedCount: 0 },
    ]);
    const res = await POST(makeRequest({ adminKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      profiles: [{ status: "ok", profileId: 1, matchedCount: 3, unmatchedCount: 0 }],
    });
  });

  it("returns 500 with a sanitized error when materialization throws", async () => {
    mockMaterializeAll.mockRejectedValue(new Error("boom"));
    const res = await POST(makeRequest({ adminKey: ADMIN_KEY }));
    expect(res.status).toBe(500);
  });
});
