// @vitest-environment node
/**
 * Unit tests for POST /api/etl/worklist/seed — worklist sitemap seeding
 * trigger (issue #260).
 *
 * Mocks the DB helper (@/lib/db/worklist-seed) so no real Postgres is needed —
 * the "does a real trigger get claimed and run" half lives in
 * etl/tests/test_worklist_seed.py and the e2e spec. This suite pins the HTTP
 * contract: admin gating, portal validation, the single-pending 409, and the
 * default-portal path.
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
const mockPending = vi.mocked(seed.getPendingWorklistSeedTrigger);

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

  it("defaults to cimenta2 when no portal is given", async () => {
    mockCreate.mockResolvedValue(7);
    const res = await POST(postReq(undefined, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ trigger_id: 7, status: "pending", portal: "cimenta2" });
    expect(mockCreate).toHaveBeenCalledWith("cimenta2");
  });

  it("queues a seed for an explicit seedable portal", async () => {
    mockCreate.mockResolvedValue(42);
    const res = await POST(postReq({ portal: "cimenta2" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trigger_id).toBe(42);
    expect(mockCreate).toHaveBeenCalledWith("cimenta2");
  });

  it("rejects a portal with no sitemap seeder (400)", async () => {
    const res = await POST(postReq({ portal: "aliseda" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-string portal (400)", async () => {
    const res = await POST(postReq({ portal: 123 }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("reports the already-pending seed on a unique-violation (409)", async () => {
    mockCreate.mockRejectedValue({ code: "23505" });
    mockPending.mockResolvedValue({
      id: 5,
      source_portal: "cimenta2",
      status: "pending",
      added_count: null,
      error_msg: null,
      triggered_by: "dashboard",
      requested_at: new Date().toISOString(),
      picked_up_at: null,
      finished_at: null,
    });
    const res = await POST(postReq({ portal: "cimenta2" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.pending_trigger_id).toBe(5);
  });
});
