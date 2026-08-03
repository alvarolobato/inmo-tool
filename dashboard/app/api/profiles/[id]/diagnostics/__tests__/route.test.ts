import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError, z } from "zod";
import { NextRequest } from "next/server";

const { mockGetProfileById, mockDiagnoseZeroCandidates } = vi.hoisted(() => ({
  mockGetProfileById: vi.fn(),
  mockDiagnoseZeroCandidates: vi.fn(),
}));

vi.mock("@/lib/db/profiles", () => ({
  getProfileById: mockGetProfileById,
}));
vi.mock("@/lib/profile-diagnostics", () => ({
  diagnoseZeroCandidates: mockDiagnoseZeroCandidates,
}));

import { GET } from "../route";

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

const VALID_PROFILE = {
  id: 1,
  name: "Perfil",
  scope: { geography: { type: "radius", center: [40.4, -3.7], radius_km: 5 }, property_types: ["piso"] },
  thesis_params: {},
  archived_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
  last_materialized_at: "2026-08-01T00:00:00.000Z",
  last_viewed_at: null,
};

beforeEach(() => {
  mockGetProfileById.mockReset();
  mockDiagnoseZeroCandidates.mockReset();
});

describe("GET /api/profiles/[id]/diagnostics (issue #194)", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await GET(makeRequest("http://localhost:4000/api/profiles/x/diagnostics"), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(400);
    expect(mockGetProfileById).not.toHaveBeenCalled();
  });

  it("returns 404 when the profile does not exist", async () => {
    mockGetProfileById.mockResolvedValue(null);
    const res = await GET(makeRequest("http://localhost:4000/api/profiles/999/diagnostics"), {
      params: Promise.resolve({ id: "999" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the profile is archived", async () => {
    mockGetProfileById.mockResolvedValue({ ...VALID_PROFILE, archived_at: "2026-08-02T00:00:00.000Z" });
    const res = await GET(makeRequest("http://localhost:4000/api/profiles/1/diagnostics"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(404);
    expect(mockDiagnoseZeroCandidates).not.toHaveBeenCalled();
  });

  it("returns 404 (not 500) when getProfileById throws a ZodError (malformed scope, issue #113)", async () => {
    const zodError = new ZodError(z.object({ geography: z.string() }).safeParse({}).error!.issues);
    mockGetProfileById.mockRejectedValue(zodError);
    const res = await GET(makeRequest("http://localhost:4000/api/profiles/1/diagnostics"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(404);
    expect(mockDiagnoseZeroCandidates).not.toHaveBeenCalled();
  });

  it("returns 500 for a non-ZodError failure from getProfileById", async () => {
    mockGetProfileById.mockRejectedValue(new Error("db connection lost"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(makeRequest("http://localhost:4000/api/profiles/1/diagnostics"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(500);
    consoleErrorSpy.mockRestore();
  });

  it("returns the diagnosis verbatim for a valid, active profile", async () => {
    mockGetProfileById.mockResolvedValue(VALID_PROFILE);
    mockDiagnoseZeroCandidates.mockResolvedValue({ kind: "never_materialized" });
    const res = await GET(makeRequest("http://localhost:4000/api/profiles/1/diagnostics"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "never_materialized" });
    expect(mockDiagnoseZeroCandidates).toHaveBeenCalledWith(VALID_PROFILE);
  });

  it("returns 500 when diagnoseZeroCandidates itself throws", async () => {
    mockGetProfileById.mockResolvedValue(VALID_PROFILE);
    mockDiagnoseZeroCandidates.mockRejectedValue(new Error("boom"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(makeRequest("http://localhost:4000/api/profiles/1/diagnostics"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(500);
    consoleErrorSpy.mockRestore();
  });
});
