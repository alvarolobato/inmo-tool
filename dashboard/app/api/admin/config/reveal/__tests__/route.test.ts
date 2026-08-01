/**
 * Tests for GET /api/admin/config/reveal
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetSystemConfig = vi.fn();

vi.mock("@/lib/system-config/loader", () => ({
  getSystemConfig: (...args: unknown[]) => mockGetSystemConfig(...args),
  resetConfigCache: vi.fn(),
}));

import { GET } from "../route";

function adminRequest(key?: string): NextRequest {
  const url = key
    ? `http://localhost:4000/api/admin/config/reveal?key=${encodeURIComponent(key)}`
    : "http://localhost:4000/api/admin/config/reveal";
  return new NextRequest(url, {
    headers: { "x-admin-key": "test-admin-secret" },
  });
}

beforeEach(() => {
  vi.stubEnv("ADMIN_API_KEY", "test-admin-secret");
  mockGetSystemConfig.mockReturnValue({
    "openrouter.api_key": {
      key: "openrouter.api_key",
      value: "sk-real-secret",
      source: "env",
      sensitive: true,
      env: "OPENROUTER_API_KEY",
      section: "OpenRouter",
      description: "API key",
      requires_restart: [],
      type: "string",
      default: null,
    },
    "fourd.host": {
      key: "fourd.host",
      value: "10.0.1.35",
      source: "file",
      sensitive: false,
      env: "P4D_HOST",
      section: "4D",
      description: "Host",
      requires_restart: [],
      type: "string",
      default: null,
    },
    "dashboard.admin_api_key": {
      key: "dashboard.admin_api_key",
      value: "super-secret-admin-key",
      source: "env",
      sensitive: true,
      env: "ADMIN_API_KEY",
      section: "Dashboard App",
      description: "Admin key",
      requires_restart: [],
      type: "string",
      default: null,
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/admin/config/reveal", () => {
  it("returns 401 without admin key", async () => {
    const req = new NextRequest("http://localhost:4000/api/admin/config/reveal?key=openrouter.api_key");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when key param missing", async () => {
    const res = await GET(adminRequest());
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown key", async () => {
    const res = await GET(adminRequest("nonexistent.key"));
    expect(res.status).toBe(404);
  });

  it("returns 400 for non-sensitive key", async () => {
    const res = await GET(adminRequest("fourd.host"));
    expect(res.status).toBe(400);
  });

  it("returns real value for sensitive key", async () => {
    const res = await GET(adminRequest("openrouter.api_key"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value).toBe("sk-real-secret");
    expect(body.key).toBe("openrouter.api_key");
    expect(body.source).toBe("env");
  });

  it("returns 403 when trying to reveal dashboard.admin_api_key", async () => {
    const res = await GET(adminRequest("dashboard.admin_api_key"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/cannot be revealed/);
  });
});
