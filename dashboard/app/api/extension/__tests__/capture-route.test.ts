// @vitest-environment node
/**
 * Unit tests for POST /api/extension/capture — the browser-extension
 * listing-capture endpoint (issue #75). Covers the two security fixes from
 * Opus's review of PR #87: the endpoint was previously unauthenticated, and
 * accepted non-http(s) URL schemes (verified end-to-end exploitable via a
 * `javascript:` URL with a legitimate-looking hostname).
 *
 * Mocks @/lib/db-write so no real DB connection is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db-write", () => ({
  sql: vi.fn(),
}));

import { POST } from "../capture/route";
import * as dbWrite from "@/lib/db-write";

const mockSql = vi.mocked(dbWrite.sql);

const ADMIN_KEY = "test-admin-key";

function makeRequest(
  body: Record<string, unknown>,
  opts: { adminKey?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) {
    headers["x-admin-key"] = opts.adminKey;
  }
  return new NextRequest("http://localhost:4000/api/extension/capture", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/extension/capture", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid admin key", async () => {
    const res = await POST(
      makeRequest({ url: "https://www.idealista.com/inmueble/1/", html: "<html></html>" }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects a javascript: URL even with a valid admin key and legitimate-looking hostname", async () => {
    // Real payload traced end-to-end by the reviewer: a scheme mismatch
    // hostname-matches idealista.com in etl/capture.py's allowlist while
    // never being a real network request.
    const res = await POST(
      makeRequest(
        { url: "javascript://idealista.com/inmueble/1/%0aalert(1)", html: "<html></html>" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects a data: URL with a valid admin key", async () => {
    const res = await POST(
      makeRequest(
        { url: "data:text/html,<script>alert(1)</script>", html: "<html></html>" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("accepts a valid http(s) URL with a valid admin key", async () => {
    mockSql.mockResolvedValue([{ id: 42 }]);

    const res = await POST(
      makeRequest(
        { url: "https://www.idealista.com/inmueble/106387165/", html: "<html>real</html>" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.capture_id).toBe(42);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});


describe("NUL bytes in the captured payload (issue #207 — a real 500 in production)", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([{ id: 42 }]);
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores a page whose DOM carries a NUL instead of 500ing", async () => {
    // The owner's first real Hipoges capture failed with Postgres'
    // `invalid byte sequence for encoding "UTF8": 0x00`. A text column cannot
    // hold U+0000, so the INSERT threw and the capture was lost behind a
    // generic 500. Nothing Hipoges-specific — the endpoint had no guard for
    // any source, so this was latent for every portal.
    const html = `<html><body><h1>Piso\u0000 en Dos Hermanas</h1></body></html>`;
    const res = await POST(
      makeRequest(
        { url: "https://realestate.hipoges.com/es/detail/12345", html },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);

    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    // U+FFFD, not deletion: the HTML spec's tokenizer substitutes U+FFFD for
    // U+0000, so this is what the browser rendering the page saw, and it keeps
    // downstream character offsets stable.
    expect(params[1]).toBe(`<html><body><h1>Piso\uFFFD en Dos Hermanas</h1></body></html>`);
    expect(params[1]).not.toContain("\u0000");
  });

  it("sanitises the url too — a NUL anywhere in the tuple fails the same INSERT", async () => {
    const res = await POST(
      makeRequest(
        { url: "https://realestate.hipoges.com/es/detail/1\u000023", html: "<html></html>" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[0]).not.toContain("\u0000");
  });

  it("leaves a clean payload byte-identical — no cost on the common path", async () => {
    const html = "<html><body>sin nulos</body></html>";
    await POST(
      makeRequest({ url: "https://realestate.hipoges.com/es/detail/7", html }, { adminKey: ADMIN_KEY }),
    );
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe(html);
  });
});
