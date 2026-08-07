import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockDismiss = vi.fn();

vi.mock("@/lib/db/redflag-candidates", () => ({
  dismissCandidateType: (...args: unknown[]) => mockDismiss(...args),
}));

import { POST } from "../route";

function postRequest(body: unknown, withKey = true): NextRequest {
  return new NextRequest("http://localhost:4000/api/admin/candidatos/dismiss", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withKey ? { "x-admin-key": process.env.ADMIN_API_KEY ?? "" } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/candidatos/dismiss", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", "test-admin-secret");
    mockDismiss.mockReset();
    mockDismiss.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without admin key and never persists", async () => {
    const res = await POST(postRequest({ slug: "sin_posesion" }, false));
    expect(res.status).toBe(401);
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it("persists the normalized slug + trimmed reason and returns ok", async () => {
    const res = await POST(postRequest({ slug: "Sin Posesión", reason: "  duplicado  " }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Normalized with normalizeCandidateType (accent-folded, snake_case).
    expect(body.slug).toBe("sin_posesion");
    expect(mockDismiss).toHaveBeenCalledWith("sin_posesion", "duplicado");
  });

  it("stores a null reason when none is given", async () => {
    const res = await POST(postRequest({ slug: "regimen_vpo" }));
    expect(res.status).toBe(200);
    expect(mockDismiss).toHaveBeenCalledWith("regimen_vpo", null);
  });

  it("rejects a slug that normalizes to empty (400), no persistence", async () => {
    const res = await POST(postRequest({ slug: "   " }));
    expect(res.status).toBe(400);
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it("rejects a malformed body (400)", async () => {
    const res = await POST(postRequest({ notSlug: 1 }));
    expect(res.status).toBe(400);
    expect(mockDismiss).not.toHaveBeenCalled();
  });
});
