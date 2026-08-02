/**
 * Guards the gate-by-default API auth policy.
 *
 * Three separate unauthenticated-endpoint bugs shipped in this project (PR #87
 * extension capture, PR #106 connector config, PR #110 materialize-all), each
 * fixed individually while the underlying shape — routes open unless a
 * middleware matcher happened to list them — stayed in place. This test
 * enumerates every route file on disk and asserts each is either explicitly
 * public or gated, so adding a route cannot silently reopen the hole.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isApiPath, isPublicApiPath, PUBLIC_API_PATHS } from "@/lib/api-auth-policy";

const API_DIR = join(__dirname, "..", "app", "api");

/** Recursively collect every `route.ts` under `app/api`. */
function collectRouteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectRouteFiles(full, acc);
    } else if (entry === "route.ts") {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Map a route file path to its URL pathname, substituting a placeholder for
 * dynamic segments (`[id]` -> `1`) so the result is a realistic concrete path.
 */
function routeFileToPathname(file: string): string {
  const rel = file.slice(API_DIR.length).replace(/\/route\.ts$/, "");
  const segments = rel.split("/").filter(Boolean);
  const concrete = segments.map((s) => (s.startsWith("[") && s.endsWith("]") ? "1" : s));
  return "/api" + (concrete.length ? "/" + concrete.join("/") : "");
}

describe("API auth coverage", () => {
  const routeFiles = collectRouteFiles(API_DIR);

  it("finds the API route files (guards against a broken glob silently passing)", () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it("classifies every API route as either public or gated", () => {
    const ungated: string[] = [];
    for (const file of routeFiles) {
      const pathname = routeFileToPathname(file);
      // Every route must live under /api/ ...
      expect(isApiPath(pathname), `${pathname} is not recognised as an API path`).toBe(true);
      // ... and is gated unless explicitly allow-listed.
      const gated = isApiPath(pathname) && !isPublicApiPath(pathname);
      if (!gated && !isPublicApiPath(pathname)) ungated.push(pathname);
    }
    expect(ungated).toEqual([]);
  });

  it("keeps the public allow-list minimal and intentional", () => {
    // Deliberately strict: growing this list is a security decision that should
    // require editing this assertion, not just the policy module.
    expect([...PUBLIC_API_PATHS].sort()).toEqual(["/api/health", "/api/ready"]);
  });

  it("only allow-lists routes that actually exist on disk", () => {
    const existing = new Set(routeFiles.map(routeFileToPathname));
    for (const pub of PUBLIC_API_PATHS) {
      expect(existing.has(pub), `${pub} is allow-listed but has no route file`).toBe(true);
    }
  });

  it("treats the highest-risk routes as gated", () => {
    // Named explicitly so a future edit that accidentally allow-lists one of
    // these fails loudly. These are the routes flagged in PR #110's review:
    // arbitrary SQL execution, and state mutation.
    for (const p of [
      "/api/query",
      "/api/anomaly-check",
      "/api/profiles",
      "/api/profiles/1/materialize",
      "/api/profiles/materialize-all",
      "/api/conversations",
    ]) {
      expect(isPublicApiPath(p), `${p} must never be public`).toBe(false);
      expect(isApiPath(p) && !isPublicApiPath(p), `${p} must be gated`).toBe(true);
    }
  });

  it("does not treat a nested path under a public route as public", () => {
    // Exact-match semantics: /api/health/secret must not inherit /api/health.
    expect(isPublicApiPath("/api/health/secret")).toBe(false);
    expect(isPublicApiPath("/api/ready/x")).toBe(false);
  });
});
