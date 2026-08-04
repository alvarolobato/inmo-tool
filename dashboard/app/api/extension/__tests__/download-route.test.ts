// @vitest-environment node
/**
 * Unit tests for GET /api/extension/download (issue #256).
 *
 * Covers the auth gate, the happy path (streams the packaged zip with the right
 * headers), and the graceful 503 when the package was never built into the image.
 * `node:fs/promises` is mocked so the test does not depend on a real zip on disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { GET } from "../download/route";
import { readFile } from "node:fs/promises";

const mockReadFile = vi.mocked(readFile);
const ADMIN_KEY = "test-admin-key-256";

function makeRequest(opts: { headerKey?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.headerKey) headers["x-admin-key"] = opts.headerKey;
  return new NextRequest("http://localhost:4000/api/extension/download", { headers });
}

describe("GET /api/extension/download", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid admin credential (does not touch the filesystem)", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("streams the zip with attachment headers when the package exists", async () => {
    const fake = Buffer.from("PK\x03\x04 fake-zip-bytes");
    mockReadFile.mockResolvedValueOnce(fake);

    const res = await GET(makeRequest({ headerKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("inmo-tool-extension.zip");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(fake)).toBe(true);
  });

  it("returns 503 with a helpful body when the package was not built into the image", async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const res = await GET(makeRequest({ headerKey: ADMIN_KEY }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("extension_package_unavailable");
  });
});
