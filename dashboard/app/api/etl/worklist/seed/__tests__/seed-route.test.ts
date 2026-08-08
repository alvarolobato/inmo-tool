// @vitest-environment node
/**
 * Unit tests for POST /api/etl/worklist/seed — worklist sitemap seeding
 * trigger (issue #260, gated by issue #454).
 *
 * Mocks the DB helper (@/lib/db/worklist-seed) so no real Postgres is needed —
 * the "does a real trigger get claimed and run" half lives in
 * etl/tests/test_worklist_seed.py and the e2e spec. This suite pins the HTTP
 * contract: admin gating and portal validation.
 *
 * Since #454, SITEMAP_SEEDABLE_PORTALS is gated to extension-capturable portals
 * and cimenta2 (fetched over HTTP by the ETL) is filtered out — so today NO
 * portal is seedable and every seed request is a 400. The 200/409 happy paths
 * are dormant until a future extension portal ships a usable sitemap; they stay
 * covered at the DB layer (lib/db/__tests__/worklist-seed.test.ts) and in the
 * ETL poll-path test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/worklist-seed", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/worklist-seed")>(
    "@/lib/db/worklist-seed",
  );
  return {
    ...actual,
    createWorklistSeedTrigger: vi.fn(),
    getPendingWorklistSeedTrigger: vi.fn(),
  };
});

import { POST } from "../route";
import * as seed from "@/lib/db/worklist-seed";

const mockCreate = vi.mocked(seed.createWorklistSeedTrigger);

const ADMIN_KEY = "test-admin-key";

function postReq(body?: unknown, opts: { adminKey?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest("http://localhost:4000/api/etl/worklist/seed", {
    method: "POST",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("POST /api/etl/worklist/seed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  it("rejects a request with no admin credential (401)", async () => {
    const res = await POST(postReq({ portal: "cimenta2" }));
    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects cimenta2 — it is fetched by the ETL, not the extension (400, #454)", async () => {
    const res = await POST(postReq({ portal: "cimenta2" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a bodyless request — no portal is seedable today (400, #454)", async () => {
    const res = await POST(postReq(undefined, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects an extension portal with no sitemap seeder (400)", async () => {
    const res = await POST(postReq({ portal: "aliseda" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-string portal (400)", async () => {
    const res = await POST(postReq({ portal: 123 }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
