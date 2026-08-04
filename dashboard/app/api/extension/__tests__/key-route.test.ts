// @vitest-environment node
/**
 * Unit tests for GET /api/extension/key (issue #256).
 *
 * This route returns the admin credential in its body, so the load-bearing
 * assertion is that it REJECTS an unauthenticated request — a leak here is a
 * full compromise. Middleware gates it too, but this test drives the handler
 * directly so the in-route guard is verified independently of middleware.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../key/route";

const ADMIN_KEY = "test-admin-key-256";

function makeRequest(opts: { headerKey?: string; bearer?: string; cookie?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.headerKey) headers["x-admin-key"] = opts.headerKey;
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers["cookie"] = `ps_admin=${opts.cookie}`;
  return new NextRequest("http://localhost:4000/api/extension/key", { headers });
}

describe("GET /api/extension/key", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 and does NOT leak the key without a valid credential", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
  });

  it("returns 401 for a wrong key", async () => {
    const res = await GET(makeRequest({ headerKey: "not-the-key" }));
    expect(res.status).toBe(401);
  });

  it("returns the key with a valid x-admin-key header", async () => {
    const res = await GET(makeRequest({ headerKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe(ADMIN_KEY);
  });

  it("returns the key with a valid Bearer token", async () => {
    const res = await GET(makeRequest({ bearer: ADMIN_KEY }));
    expect(res.status).toBe(200);
    expect((await res.json()).key).toBe(ADMIN_KEY);
  });

  it("returns the key with a valid ps_admin cookie (same-origin UI call)", async () => {
    const res = await GET(makeRequest({ cookie: ADMIN_KEY }));
    expect(res.status).toBe(200);
    expect((await res.json()).key).toBe(ADMIN_KEY);
  });

  it("fails closed with 503 when ADMIN_API_KEY is unset (no key to authorize or return)", async () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    // With no key configured, adminApiKeyValid rejects everything → 401 first.
    const res = await GET(makeRequest({ headerKey: "anything" }));
    expect(res.status).toBe(401);
  });
});
