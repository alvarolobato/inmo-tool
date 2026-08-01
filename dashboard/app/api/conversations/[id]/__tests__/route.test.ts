/**
 * Tests for GET /api/conversations/:id and PATCH /api/conversations/:id
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetConversation = vi.fn();
const mockGetConversationWithMessages = vi.fn();
const mockUpdateConversationTitle = vi.fn();
const mockSetConversationArchived = vi.fn();
const mockMarkConversationRead = vi.fn();

vi.mock("@/lib/conversations", () => ({
  getConversation: (...args: unknown[]) => mockGetConversation(...args),
  getConversationWithMessages: (...args: unknown[]) =>
    mockGetConversationWithMessages(...args),
  updateConversationTitle: (...args: unknown[]) => mockUpdateConversationTitle(...args),
  setConversationArchived: (...args: unknown[]) => mockSetConversationArchived(...args),
  markConversationRead: (...args: unknown[]) => mockMarkConversationRead(...args),
}));

vi.mock("@/lib/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/errors")>();
  return { ...actual, generateRequestId: () => "test-req-id" };
});

import { GET, PATCH } from "../route";

// 12-char lowercase-hex IDs that match the route's ID_PATTERN.
const VALID_ID = "abcdef012345";
const VALID_ID_2 = "fedcba543210";

const MOCK_CONV = {
  id: VALID_ID,
  mode: "analyze",
  title: "My conversation",
  first_user_prompt: "Hello",
  context_url: "/dashboard/1",
  context_kind: "dashboard",
  context_ref: "1",
  created_at: "2026-01-01T00:00:00Z",
  last_interaction_at: "2026-01-01T00:01:00Z",
  archived_at: null,
  last_status: "ok",
  messages: [],
};

function params(id: string) {
  return { params: { id } };
}

beforeEach(() => {
  mockGetConversation.mockReset();
  mockGetConversationWithMessages.mockReset();
  mockUpdateConversationTitle.mockReset();
  mockSetConversationArchived.mockReset();
  mockMarkConversationRead.mockReset();
});

describe("GET /api/conversations/:id", () => {
  it("returns 400 for structurally invalid IDs", async () => {
    const req = new NextRequest(`http://localhost:4000/api/conversations/not-hex-12`);
    const res = await GET(req, params("not-hex-12"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
    expect(mockGetConversationWithMessages).not.toHaveBeenCalled();
  });

  it("returns 404 when conversation not found", async () => {
    mockGetConversationWithMessages.mockResolvedValue(null);
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`);
    const res = await GET(req, params(VALID_ID));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns conversation with messages when found", async () => {
    mockGetConversationWithMessages.mockResolvedValue({
      ...MOCK_CONV,
      messages: [
        {
          id: "m1",
          conversation_id: VALID_ID,
          role: "user",
          content: { text: "Hello" },
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`);
    const res = await GET(req, params(VALID_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(VALID_ID);
    expect(body.title).toBe("My conversation");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(1);
  });

  it("returns 500 when DB throws", async () => {
    mockGetConversationWithMessages.mockRejectedValue(new Error("DB error"));
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`);
    const res = await GET(req, params(VALID_ID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DB_ERROR");
  });
});

describe("PATCH /api/conversations/:id", () => {
  it("returns 400 for structurally invalid IDs", async () => {
    const req = new NextRequest(`http://localhost:4000/api/conversations/short`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New" }),
    });
    const res = await PATCH(req, params("short"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await PATCH(req, params(VALID_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_BODY");
  });

  it("returns 404 when conversation not found", async () => {
    mockGetConversation.mockResolvedValue(null);
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID_2}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Title" }),
    });
    const res = await PATCH(req, params(VALID_ID_2));
    expect(res.status).toBe(404);
  });

  it("returns 400 when title is not a string", async () => {
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: 42 }),
    });
    const res = await PATCH(req, params(VALID_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_BODY");
  });

  it("returns 400 when archived is not a boolean", async () => {
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: "yes" }),
    });
    const res = await PATCH(req, params(VALID_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_BODY");
  });

  it("updates title when title is provided", async () => {
    mockGetConversation
      .mockResolvedValueOnce(MOCK_CONV)
      .mockResolvedValueOnce({ ...MOCK_CONV, title: "New Title" });
    mockUpdateConversationTitle.mockResolvedValue(undefined);

    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Title" }),
    });
    const res = await PATCH(req, params(VALID_ID));
    expect(res.status).toBe(200);
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(VALID_ID, "New Title");
    const body = await res.json();
    expect(body.title).toBe("New Title");
  });

  it("archives conversation when archived=true", async () => {
    mockGetConversation
      .mockResolvedValueOnce(MOCK_CONV)
      .mockResolvedValueOnce({ ...MOCK_CONV, archived_at: "2026-01-02T00:00:00Z" });
    mockSetConversationArchived.mockResolvedValue(undefined);

    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    const res = await PATCH(req, params(VALID_ID));
    expect(res.status).toBe(200);
    expect(mockSetConversationArchived).toHaveBeenCalledWith(VALID_ID, true);
  });

  it("returns 400 when title is empty or whitespace-only", async () => {
    mockGetConversation.mockResolvedValueOnce(MOCK_CONV);
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    const res = await PATCH(req, params(VALID_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_BODY");
    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
  });

  it("returns 400 when title is empty string", async () => {
    mockGetConversation.mockResolvedValueOnce(MOCK_CONV);
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    const res = await PATCH(req, params(VALID_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_BODY");
  });

  it("returns 404 when conversation disappears between update and re-read", async () => {
    // First getConversation (existence check) returns the conv; second (re-read) returns null.
    mockGetConversation
      .mockResolvedValueOnce(MOCK_CONV)
      .mockResolvedValueOnce(null);
    mockUpdateConversationTitle.mockResolvedValue(undefined);

    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Title" }),
    });
    const res = await PATCH(req, params(VALID_ID));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.details).toContain(VALID_ID);
  });

  it("returns 500 when database throws", async () => {
    mockGetConversation.mockRejectedValue(new Error("DB error"));
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New" }),
    });
    const res = await PATCH(req, params(VALID_ID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DB_ERROR");
  });

  it("returns 400 when last_read_at is not \"now\"", async () => {
    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ last_read_at: "2026-01-01T00:00:00Z" }),
    });
    const res = await PATCH(req, params(VALID_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_BODY");
    expect(mockMarkConversationRead).not.toHaveBeenCalled();
  });

  it("marks conversation as read when last_read_at is \"now\"", async () => {
    const updatedConv = { ...MOCK_CONV, last_read_at: "2026-01-01T00:05:00Z" };
    mockGetConversation
      .mockResolvedValueOnce(MOCK_CONV)
      .mockResolvedValueOnce(updatedConv);
    mockMarkConversationRead.mockResolvedValue(undefined);

    const req = new NextRequest(`http://localhost:4000/api/conversations/${VALID_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ last_read_at: "now" }),
    });
    const res = await PATCH(req, params(VALID_ID));
    expect(res.status).toBe(200);
    expect(mockMarkConversationRead).toHaveBeenCalledWith(VALID_ID);
    const body = await res.json();
    expect(body.last_read_at).toBe("2026-01-01T00:05:00Z");
  });
});
