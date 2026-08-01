/**
 * Tests for GET and POST /api/conversations
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockCreateConversation = vi.fn();
const mockListConversations = vi.fn();

vi.mock("@/lib/conversations", () => ({
  createConversation: (...args: unknown[]) => mockCreateConversation(...args),
  listConversations: (...args: unknown[]) => mockListConversations(...args),
}));

vi.mock("@/lib/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/errors")>();
  return { ...actual, generateRequestId: () => "test-req-id" };
});

import { GET, POST } from "../route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4000/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockCreateConversation.mockReset();
  mockListConversations.mockReset();
  mockListConversations.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── GET tests ─────────────────────────────────────────────────────────────────

function makeGetRequest(qs: string): NextRequest {
  return new NextRequest(`http://localhost:4000/api/conversations${qs ? `?${qs}` : ""}`, {
    method: "GET",
  });
}

describe("GET /api/conversations", () => {
  it("passes multiple mode params as modes array to listConversations", async () => {
    const req = makeGetRequest("mode=generate&mode=modify");
    await GET(req);
    expect(mockListConversations).toHaveBeenCalledWith(
      expect.objectContaining({ modes: ["generate", "modify"] })
    );
  });

  it("passes single mode param as a 1-element modes array", async () => {
    const req = makeGetRequest("mode=analyze");
    await GET(req);
    expect(mockListConversations).toHaveBeenCalledWith(
      expect.objectContaining({ modes: ["analyze"] })
    );
  });

  it("passes undefined modes when no mode param given", async () => {
    const req = makeGetRequest("");
    await GET(req);
    const opts = mockListConversations.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.modes).toBeUndefined();
  });

  it("passes only_archived=true when only_archived param is 'true'", async () => {
    const req = makeGetRequest("only_archived=true");
    await GET(req);
    expect(mockListConversations).toHaveBeenCalledWith(
      expect.objectContaining({ only_archived: true })
    );
  });

  it("passes only_archived=false by default", async () => {
    const req = makeGetRequest("");
    await GET(req);
    expect(mockListConversations).toHaveBeenCalledWith(
      expect.objectContaining({ only_archived: false })
    );
  });

  it("preserves include_archived=true for backward compat", async () => {
    const req = makeGetRequest("include_archived=true");
    await GET(req);
    expect(mockListConversations).toHaveBeenCalledWith(
      expect.objectContaining({ include_archived: true })
    );
  });

  it("passes multiple context_kind params as context_kinds array", async () => {
    const req = makeGetRequest("context_kind=dashboard&context_kind=home");
    await GET(req);
    expect(mockListConversations).toHaveBeenCalledWith(
      expect.objectContaining({ context_kinds: ["dashboard", "home"] })
    );
  });

  it("passes single context_kind param as a 1-element context_kinds array", async () => {
    const req = makeGetRequest("context_kind=dashboard");
    await GET(req);
    expect(mockListConversations).toHaveBeenCalledWith(
      expect.objectContaining({ context_kinds: ["dashboard"] })
    );
  });

  it("passes undefined context_kinds when no context_kind param given", async () => {
    const req = makeGetRequest("");
    await GET(req);
    const opts = mockListConversations.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.context_kinds).toBeUndefined();
  });

  it("returns 200 with array response", async () => {
    const fakeRows = [{ id: "abc", mode: "generate" }];
    mockListConversations.mockResolvedValue(fakeRows);
    const req = makeGetRequest("");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(fakeRows);
  });

  it("returns 400 for invalid since date", async () => {
    const req = makeGetRequest("since=not-a-date");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 500 when listConversations throws", async () => {
    mockListConversations.mockRejectedValue(new Error("DB down"));
    const req = makeGetRequest("");
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DB_ERROR");
  });
});

// ── POST tests ────────────────────────────────────────────────────────────────

describe("POST /api/conversations", () => {
  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost:4000/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_BODY");
  });

  it("returns 400 when mode is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_MODE");
  });

  it("returns 400 when mode is empty string", async () => {
    const res = await POST(makeRequest({ mode: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_MODE");
  });

  it("returns 400 for invalid mode value", async () => {
    const res = await POST(makeRequest({ mode: "unknown_mode" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_MODE");
  });

  it("creates conversation and returns 201 with URLs", async () => {
    mockCreateConversation.mockResolvedValue({
      id: "conv-123",
      c_url: "/c/conv-123",
      k_url: "/k/conv-123",
    });
    const res = await POST(makeRequest({ mode: "analyze", context_kind: "dashboard", context_ref: "42" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("conv-123");
    expect(body.c_url).toBe("/c/conv-123");
    expect(body.k_url).toBe("/k/conv-123");
  });

  it("passes first_user_prompt and context fields to createConversation", async () => {
    mockCreateConversation.mockResolvedValue({ id: "x", c_url: "/c/x", k_url: "/k/x" });
    await POST(makeRequest({
      mode: "chat",
      first_user_prompt: "World",
      context_url: "/dashboard/1",
    }));
    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ first_user_prompt: "World", context_url: "/dashboard/1" }),
    );
    // seed_prompt is not part of the route contract — must not be forwarded.
    expect(mockCreateConversation.mock.calls[0][0]).not.toHaveProperty("seed_prompt");
  });

  it("returns 500 when createConversation throws", async () => {
    mockCreateConversation.mockRejectedValue(new Error("DB error"));
    const res = await POST(makeRequest({ mode: "generate" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DB_ERROR");
  });
});
