// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

const ADMIN_KEY = "test-admin-key";

beforeEach(() => {
  vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeRequest(
  pathname: string,
  opts: {
    cookie?: string;
    search?: string;
    method?: string;
    headerKey?: string;
    bearer?: string;
  } = {},
): NextRequest {
  const url = `http://localhost:4000${pathname}${opts.search ?? ""}`;
  const headers: Record<string, string> = {};
  if (opts.cookie) {
    headers["cookie"] = `ps_admin=${opts.cookie}`;
  }
  if (opts.headerKey) {
    headers["x-admin-key"] = opts.headerKey;
  }
  if (opts.bearer) {
    headers["authorization"] = `Bearer ${opts.bearer}`;
  }
  return new NextRequest(url, { headers, method: opts.method });
}

describe("middleware — admin UI gating", () => {
  describe("when ADMIN_API_KEY is set", () => {
    it("redirects unauthenticated /admin/slow-queries to login with redirect param", () => {
      const res = middleware(makeRequest("/admin/slow-queries"));
      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("/admin/login");
      expect(location).toContain("redirect=%2Fadmin%2Fslow-queries");
    });

    it("redirects unauthenticated /etl to login with redirect=%2Fetl", () => {
      const res = middleware(makeRequest("/etl"));
      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("/admin/login");
      expect(location).toContain("redirect=%2Fetl");
    });

    it("redirects unauthenticated /etl/42 to login with redirect=%2Fetl%2F42", () => {
      const res = middleware(makeRequest("/etl/42"));
      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("redirect=%2Fetl%2F42");
    });

    it("preserves the original query string in the redirect param", () => {
      const res = middleware(makeRequest("/admin/usage", { search: "?period=7d" }));
      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      // "/admin/usage?period=7d" percent-encoded.
      expect(location).toContain("redirect=%2Fadmin%2Fusage%3Fperiod%3D7d");
    });

    it("allows authenticated requests to /etl to pass through", () => {
      const res = middleware(makeRequest("/etl", { cookie: ADMIN_KEY }));
      // NextResponse.next() returns status 200 and no location header.
      expect(res.headers.get("location")).toBeNull();
    });

    it("allows authenticated requests to /admin/slow-queries to pass through", () => {
      const res = middleware(makeRequest("/admin/slow-queries", { cookie: ADMIN_KEY }));
      expect(res.headers.get("location")).toBeNull();
    });

    it("redirects authenticated /etl request with wrong cookie back to login", () => {
      const res = middleware(makeRequest("/etl", { cookie: "stale" }));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/admin/login");
    });

    it("lets /admin/login through without requiring auth", () => {
      const res = middleware(makeRequest("/admin/login"));
      expect(res.headers.get("location")).toBeNull();
    });

    it("returns 401 JSON for /api/admin/* without a valid header", async () => {
      const res = middleware(makeRequest("/api/admin/usage"));
      expect(res.status).toBe(401);
    });

    it("returns 401 JSON for /api/etl/runs without cookie or header", async () => {
      const res = middleware(makeRequest("/api/etl/runs"));
      expect(res.status).toBe(401);
    });

    it("returns 401 JSON for /api/etl/run POST without cookie or header", async () => {
      const res = middleware(makeRequest("/api/etl/run", { method: "POST" }));
      expect(res.status).toBe(401);
    });

    it("returns 401 JSON for /api/etl/* with wrong cookie", async () => {
      const res = middleware(makeRequest("/api/etl/stats", { cookie: "stale" }));
      expect(res.status).toBe(401);
    });

    it("allows /api/etl/* with valid ps_admin cookie", async () => {
      const res = middleware(makeRequest("/api/etl/runs", { cookie: ADMIN_KEY }));
      expect(res.status).not.toBe(401);
      expect(res.headers.get("location")).toBeNull();
    });

    it("allows /api/etl/* with valid x-admin-key header", async () => {
      const res = middleware(
        makeRequest("/api/etl/stats", { headerKey: ADMIN_KEY }),
      );
      expect(res.status).not.toBe(401);
    });

    it("allows /api/etl/* with valid Bearer token", async () => {
      const res = middleware(
        makeRequest("/api/etl/stats", { bearer: ADMIN_KEY }),
      );
      expect(res.status).not.toBe(401);
    });

    it("returns 401 JSON for /api/etl/* with wrong header key", async () => {
      const res = middleware(
        makeRequest("/api/etl/stats", { headerKey: "wrong" }),
      );
      expect(res.status).toBe(401);
    });

    it("allows /api/etl/* when Bearer is valid even if x-admin-key is wrong (OR logic)", async () => {
      // Both headers present; x-admin-key is wrong but Bearer is correct.
      const req = makeRequest("/api/etl/stats", { bearer: ADMIN_KEY });
      // Manually add the bad x-admin-key header on top of the Bearer one.
      const headers = new Headers(req.headers);
      headers.set("x-admin-key", "wrong-key");
      const res = middleware(new NextRequest(req.url, { headers, method: req.method }));
      expect(res.status).not.toBe(401);
    });

    it("returns 401 for /api/admin/* when both headers are wrong", async () => {
      const req = makeRequest("/api/admin/usage", { bearer: "wrong" });
      const headers = new Headers(req.headers);
      headers.set("x-admin-key", "also-wrong");
      const res = middleware(new NextRequest(req.url, { headers, method: req.method }));
      expect(res.status).toBe(401);
    });

    it("allows /api/admin/* when x-admin-key is valid even if Bearer is wrong (OR logic)", async () => {
      const req = makeRequest("/api/admin/usage", { headerKey: ADMIN_KEY });
      const headers = new Headers(req.headers);
      headers.set("authorization", "Bearer wrong-token");
      const res = middleware(new NextRequest(req.url, { headers, method: req.method }));
      expect(res.status).not.toBe(401);
    });
  });

  describe("when ADMIN_API_KEY is missing", () => {
    beforeEach(() => {
      // Override the ADMIN_KEY stub from the outer beforeEach with an empty
      // value so the middleware treats it as unconfigured (falsy after trim).
      vi.stubEnv("ADMIN_API_KEY", "");
    });

    it("returns 503 JSON for /api/admin/*", async () => {
      const res = middleware(makeRequest("/api/admin/usage"));
      expect(res.status).toBe(503);
    });

    it("returns 503 JSON for /api/etl/*", async () => {
      const res = middleware(makeRequest("/api/etl/runs"));
      expect(res.status).toBe(503);
    });

    it("redirects /admin/slow-queries to login with error=2 and redirect param", () => {
      const res = middleware(makeRequest("/admin/slow-queries"));
      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("error=2");
      expect(location).toContain("redirect=%2Fadmin%2Fslow-queries");
    });

    it("redirects /etl to login with error=2 and redirect=%2Fetl", () => {
      const res = middleware(makeRequest("/etl"));
      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("error=2");
      expect(location).toContain("redirect=%2Fetl");
    });

    it("does not interfere with non-admin paths", () => {
      const res = middleware(makeRequest("/"));
      expect(res.headers.get("location")).toBeNull();
    });
  });
});
