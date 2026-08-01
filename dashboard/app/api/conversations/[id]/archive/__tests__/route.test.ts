/**
 * Tests for POST /api/conversations/:id/archive and DELETE /api/conversations/:id/archive
 *
 * These restore coverage that was lost when lib/__tests__/conversations-api.test.ts
 * (~780 lines) was deleted as part of PR #569's rewrite.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockArchive = vi.fn();
const mockUnarchive = vi.fn();

vi.mock("@/lib/conversations", () => ({
  archiveConversation: (...a: unknown[]) => mockArchive(...a),
  unarchiveConversation: (...a: unknown[]) => mockUnarchive(...a),
}));

vi.mock("@/lib/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/errors")>();
  return { ...actual, generateRequestId: () => "test-req-id" };
});

import { POST, DELETE } from "../route";

const VALID_ID = "abcdef012345";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  mockArchive.mockReset();
  mockUnarchive.mockReset();
});

describe("POST /api/conversations/:id/archive", () => {
  it("returns 400 for invalid ID", async () => {
    const req = new NextRequest("http://localhost:4000/api/conversations/bad/archive", { method: "POST" });
    const res = await POST(req, params("bad"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION");
    expect(mockArchive).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation is not found", async () => {
    mockArchive.mockResolvedValue(null);
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}/archive`, { method: "POST" });
    const res = await POST(req, params(VALID_ID));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("returns the archived conversation on success", async () => {
    mockArchive.mockResolvedValue({ id: VALID_ID, archived_at: "2026-01-02T00:00:00Z" });
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}/archive`, { method: "POST" });
    const res = await POST(req, params(VALID_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(VALID_ID);
    expect(body.archived_at).toBe("2026-01-02T00:00:00Z");
  });

  it("returns 500 on DB error", async () => {
    mockArchive.mockRejectedValue(new Error("boom"));
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}/archive`, { method: "POST" });
    const res = await POST(req, params(VALID_ID));
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/conversations/:id/archive", () => {
  it("returns 400 for invalid ID", async () => {
    const req = new NextRequest("http://localhost:4000/api/conversations/bad/archive", { method: "DELETE" });
    const res = await DELETE(req, params("bad"));
    expect(res.status).toBe(400);
    expect(mockUnarchive).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation is not found", async () => {
    mockUnarchive.mockResolvedValue(null);
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}/archive`, { method: "DELETE" });
    const res = await DELETE(req, params(VALID_ID));
    expect(res.status).toBe(404);
  });

  it("returns the unarchived conversation on success", async () => {
    mockUnarchive.mockResolvedValue({ id: VALID_ID, archived_at: null });
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}/archive`, { method: "DELETE" });
    const res = await DELETE(req, params(VALID_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).archived_at).toBeNull();
  });
});
