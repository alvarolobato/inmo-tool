/**
 * Tests for GET /api/admin/config and PUT /api/admin/config
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// We mock the system-config loader to control what the API sees
// ---------------------------------------------------------------------------

const mockGetSystemConfig = vi.fn();
const mockWriteConfig = vi.fn();
const mockResetConfigCache = vi.fn();

vi.mock("@/lib/system-config/loader", () => ({
  getSystemConfig: (...args: unknown[]) => mockGetSystemConfig(...args),
  writeConfig: (...args: unknown[]) => mockWriteConfig(...args),
  resetConfigCache: (...args: unknown[]) => mockResetConfigCache(...args),
  importEnvToConfig: vi.fn().mockReturnValue(["some.key"]),
  bootstrapConfigIfMissing: vi.fn().mockReturnValue(false),
}));

import { GET, PUT } from "../route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, Partial<{
  value: string | number | boolean | null;
  source: "env" | "file" | "default";
  sensitive: boolean;
  key: string;
  env: string;
  section: string;
  description: string;
  requires_restart: string[];
  type: "string" | "int" | "bool" | "enum";
  enum_values?: string[];
  default: string | number | boolean | null;
}>> = {}) {
  const base = {
    "fourd.host": {
      key: "fourd.host",
      env: "P4D_HOST",
      section: "4D",
      description: "Host",
      type: "string" as const,
      sensitive: false,
      source: "env" as const,
      value: "10.0.1.35",
      requires_restart: ["etl"],
      default: null,
    },
    "openrouter.api_key": {
      key: "openrouter.api_key",
      env: "OPENROUTER_API_KEY",
      section: "OpenRouter",
      description: "API key",
      type: "string" as const,
      sensitive: true,
      source: "env" as const,
      value: "sk-or-secret-12345",
      requires_restart: [],
      default: null,
    },
    "dashboard.admin_api_key": {
      key: "dashboard.admin_api_key",
      env: "ADMIN_API_KEY",
      section: "Dashboard App",
      description: "Admin key",
      type: "string" as const,
      sensitive: true,
      source: "env" as const,
      value: "admin-secret",
      requires_restart: [],
      default: null,
    },
    "dashboard.agentic_tools_enabled": {
      key: "dashboard.agentic_tools_enabled",
      env: "DASHBOARD_AGENTIC_TOOLS_ENABLED",
      section: "Dashboard App",
      description: "Enable agentic tools",
      type: "bool" as const,
      sensitive: false,
      source: "default" as const,
      value: true,
      requires_restart: [],
      default: true,
    },
  };
  return { ...base, ...overrides };
}

function adminRequest(method = "GET", body?: unknown): NextRequest {
  return new NextRequest("http://localhost:4000/api/admin/config", {
    method,
    headers: {
      "x-admin-key": "test-admin-secret",
      "content-type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function unauthRequest(method = "GET"): NextRequest {
  return new NextRequest("http://localhost:4000/api/admin/config", { method });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv("ADMIN_API_KEY", "test-admin-secret");
  mockGetSystemConfig.mockReturnValue(makeConfig());
  mockWriteConfig.mockReset();
  mockResetConfigCache.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// -----------

describe("GET /api/admin/config", () => {
  it("returns 401 without admin key", async () => {
    const res = await GET(unauthRequest());
    expect(res.status).toBe(401);
  });

  it("returns 200 with sections and values", async () => {
    const res = await GET(adminRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sections).toBeDefined();
    expect(body.values).toBeDefined();
    expect(body.values.length).toBeGreaterThan(0);
  });

  it("masks sensitive values", async () => {
    const res = await GET(adminRequest());
    const body = await res.json();
    const apiKey = body.values.find((v: { key: string }) => v.key === "openrouter.api_key");
    expect(apiKey).toBeDefined();
    // Sensitive value should be masked, not the real value
    expect(apiKey.value_display).not.toBe("sk-or-secret-12345");
    expect(apiKey.value_display).toMatch(/^••••/);
  });

  it("exposes non-sensitive values", async () => {
    const res = await GET(adminRequest());
    const body = await res.json();
    const host = body.values.find((v: { key: string }) => v.key === "fourd.host");
    expect(host).toBeDefined();
    expect(host.value_display).toBe("10.0.1.35");
  });

  it("marks admin_api_key as not editable", async () => {
    const res = await GET(adminRequest());
    const body = await res.json();
    const adminKey = body.values.find((v: { key: string }) => v.key === "dashboard.admin_api_key");
    expect(adminKey).toBeDefined();
    expect(adminKey.editable).toBe(false);
  });

  it("groups keys by section", async () => {
    const res = await GET(adminRequest());
    const body = await res.json();
    const sectionNames = body.sections.map((s: { name: string }) => s.name);
    expect(sectionNames).toContain("4D");
  });
});

// -----------

describe("PUT /api/admin/config", () => {
  it("returns 401 without admin key", async () => {
    const req = new NextRequest("http://localhost:4000/api/admin/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: { "fourd.host": "new_host" } }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("http://localhost:4000/api/admin/config", {
      method: "PUT",
      headers: { "x-admin-key": "test-admin-secret", "content-type": "application/json" },
      body: "not json{{{",
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid body shape", async () => {
    const res = await PUT(adminRequest("PUT", { wrong_field: "x" }));
    expect(res.status).toBe(400);
  });

  it("returns 403 when trying to update ADMIN_API_KEY", async () => {
    const res = await PUT(
      adminRequest("PUT", { updates: { "dashboard.admin_api_key": "new-key" } }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on unknown config key", async () => {
    const res = await PUT(
      adminRequest("PUT", { updates: { "nonexistent.key": "value" } }),
    );
    expect(res.status).toBe(400);
  });

  it("calls writeConfig and returns ok on valid update", async () => {
    const res = await PUT(
      adminRequest("PUT", { updates: { "fourd.host": "192.168.1.1" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.updated).toContain("fourd.host");
    expect(mockWriteConfig).toHaveBeenCalledOnce();
    const [firstArg] = mockWriteConfig.mock.calls[0];
    expect(firstArg["fourd.host"]).toBe("192.168.1.1");
  });

  it("returns 500 when writeConfig throws", async () => {
    mockWriteConfig.mockImplementation(() => {
      throw new Error("disk full");
    });
    const res = await PUT(
      adminRequest("PUT", { updates: { "fourd.host": "host" } }),
    );
    expect(res.status).toBe(500);
  });

  it("accepts valid bool values for bool keys", async () => {
    for (const v of [true, false, "true", "false", "1", "0", "yes", "no", "on", "off"]) {
      const res = await PUT(
        adminRequest("PUT", { updates: { "dashboard.agentic_tools_enabled": v } }),
      );
      expect(res.status).toBe(200);
    }
  });

  it("returns 400 for invalid bool value", async () => {
    const res = await PUT(
      adminRequest("PUT", { updates: { "dashboard.agentic_tools_enabled": "maybe" } }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Type validation failed/);
  });
});
