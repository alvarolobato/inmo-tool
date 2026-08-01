/**
 * Tests for POST /api/admin/config/import-env
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockImportEnvToConfig = vi.fn();

vi.mock("@/lib/system-config/loader", () => ({
  importEnvToConfig: (...args: unknown[]) => mockImportEnvToConfig(...args),
  getSystemConfig: vi.fn().mockReturnValue({}),
  resetConfigCache: vi.fn(),
}));

import { POST } from "../route";

function adminRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/admin/config/import-env", {
    method: "POST",
    headers: { "x-admin-key": "test-admin-secret" },
  });
}

beforeEach(() => {
  vi.stubEnv("ADMIN_API_KEY", "test-admin-secret");
  mockImportEnvToConfig.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/admin/config/import-env", () => {
  it("returns 401 without admin key", async () => {
    const req = new NextRequest("http://localhost:4000/api/admin/config/import-env", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns ok with imported keys", async () => {
    mockImportEnvToConfig.mockReturnValue(["fourd.host", "openrouter.api_key"]);
    const res = await POST(adminRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    expect(body.imported).toContain("fourd.host");
  });

  it("returns ok with count 0 when nothing to import", async () => {
    mockImportEnvToConfig.mockReturnValue([]);
    const res = await POST(adminRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.ok).toBe(true);
  });

  it("returns 500 when importEnvToConfig throws", async () => {
    mockImportEnvToConfig.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const res = await POST(adminRequest());
    expect(res.status).toBe(500);
  });
});
