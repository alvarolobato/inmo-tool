/**
 * Tests for POST /api/conversations/:id/turns and GET /api/conversations/:id/turns/:turnId
 *
 * Follows the existing mock pattern (vi.mock) since tests run without a live DB.
 * AC-1: turn lifecycle (pending → streaming → complete) and error paths.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock declarations ──────────────────────────────────────────────────────────

const mockGetConversation = vi.fn();
const mockCreateTurn = vi.fn();
const mockGetTurnWithEvents = vi.fn();
const mockRunTurnBackground = vi.fn();

vi.mock("@/lib/conversations", () => ({
  getConversation: (...a: unknown[]) => mockGetConversation(...a),
}));

vi.mock("@/lib/turn-events", () => ({
  createTurnIfIdle: (...a: unknown[]) => mockCreateTurn(...a),
  getTurnWithEvents: (...a: unknown[]) => mockGetTurnWithEvents(...a),
}));

vi.mock("@/lib/turn-background", () => ({
  runTurnBackground: (...a: unknown[]) => mockRunTurnBackground(...a),
}));

vi.mock("@/lib/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/errors")>();
  return { ...actual, generateRequestId: () => "test-req-id" };
});

// Import routes after mocks are set up.
import { POST } from "../route";
import { GET } from "../[turnId]/route";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const CONV_ID = "abcdef012345";
const TURN_ID = "550e8400-e29b-41d4-a716-446655440000";

const BASE_CONV = {
  id: CONV_ID,
  mode: "chat",
  title: "Test conversation",
  first_user_prompt: "Hello",
  context_url: null,
  context_kind: "global",
  context_ref: null,
  created_at: "2026-01-01T00:00:00Z",
  last_interaction_at: "2026-01-01T00:01:00Z",
  archived_at: null,
  last_status: "ok",
  llm_provider: "openrouter",
  llm_driver: null,
  initial_context: null,
  created_by: null,
  last_read_at: null,
};

const TURN_ROW = {
  id: TURN_ID,
  conversation_id: CONV_ID,
  turn_index: 0,
  user_message: "Hello world",
  status: "complete" as const,
  started_at: "2026-01-01T00:00:01Z",
  completed_at: "2026-01-01T00:00:05Z",
  error: null,
  created_at: "2026-01-01T00:00:00Z",
};

const TURN_EVENTS = [
  {
    id: 1,
    turn_id: TURN_ID,
    seq: 0,
    event_type: "context",
    payload: { model: "claude-sonnet-4-6", provider: "openrouter" },
    created_at: "2026-01-01T00:00:01Z",
  },
  {
    id: 2,
    turn_id: TURN_ID,
    seq: 1,
    event_type: "complete",
    payload: { messageId: "msg-001" },
    created_at: "2026-01-01T00:00:05Z",
  },
];

function makePostRequest(
  id: string,
  body: unknown,
): [NextRequest, { params: { id: string } }] {
  return [
    new NextRequest(`http://localhost:4000/api/conversations/${id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: { id } },
  ];
}

function makeGetRequest(
  id: string,
  turnId: string,
): [NextRequest, { params: { id: string; turnId: string } }] {
  return [
    new NextRequest(`http://localhost:4000/api/conversations/${id}/turns/${turnId}`),
    { params: { id, turnId } },
  ];
}

// ── POST /api/conversations/:id/turns ─────────────────────────────────────────

describe("POST /api/conversations/:id/turns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunTurnBackground.mockResolvedValue(undefined);
    mockCreateTurn.mockResolvedValue({ ok: true, turnId: TURN_ID, turnIndex: 0 });
  });

  it("returns 409 TURN_IN_PROGRESS when another turn is in flight (#823)", async () => {
    mockGetConversation.mockResolvedValue(BASE_CONV);
    mockCreateTurn.mockResolvedValue({ ok: false, reason: "active_turn" });

    const [req, ctx] = makePostRequest(CONV_ID, { content: "segunda pregunta" });
    const res = await POST(req, ctx);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("TURN_IN_PROGRESS");
    expect(mockRunTurnBackground).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid conversation ID", async () => {
    const [req, ctx] = makePostRequest("not-valid!", { content: "hello" });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 400 for missing content", async () => {
    mockGetConversation.mockResolvedValue(BASE_CONV);
    const [req, ctx] = makePostRequest(CONV_ID, {});
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_CONTENT");
  });

  it("returns 400 for empty content string", async () => {
    mockGetConversation.mockResolvedValue(BASE_CONV);
    const [req, ctx] = makePostRequest(CONV_ID, { content: "   " });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_CONTENT");
  });

  it("returns 400 when content exceeds max length", async () => {
    mockGetConversation.mockResolvedValue(BASE_CONV);
    const [req, ctx] = makePostRequest(CONV_ID, { content: "x".repeat(10_001) });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("CONTENT_TOO_LONG");
  });

  it("returns 404 when conversation does not exist", async () => {
    mockGetConversation.mockResolvedValue(null);
    const [req, ctx] = makePostRequest(CONV_ID, { content: "hello" });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 when getConversation throws (DB error)", async () => {
    mockGetConversation.mockRejectedValue(new Error("DB connection failed"));
    const [req, ctx] = makePostRequest(CONV_ID, { content: "hello" });
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DB_ERROR");
  });

  it("returns 409 for archived conversation", async () => {
    mockGetConversation.mockResolvedValue({
      ...BASE_CONV,
      archived_at: "2026-01-01T00:00:00Z",
    });
    const [req, ctx] = makePostRequest(CONV_ID, { content: "hello" });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONVERSATION_ARCHIVED");
  });

  it("returns 202 with turnId and fires background job (AC-1 pending row)", async () => {
    mockGetConversation.mockResolvedValue(BASE_CONV);
    mockCreateTurn.mockResolvedValue({ ok: true, turnId: TURN_ID, turnIndex: 0 });

    const [req, ctx] = makePostRequest(CONV_ID, { content: "Hello world" });
    const res = await POST(req, ctx);

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.turnId).toBe(TURN_ID);

    // createTurn called with correct args
    expect(mockCreateTurn).toHaveBeenCalledWith(CONV_ID, "Hello world");

    // Background job fired (fire-and-forget)
    expect(mockRunTurnBackground).toHaveBeenCalledWith(TURN_ID, BASE_CONV, "Hello world");
  });

  it("returns 500 when createTurn throws", async () => {
    mockGetConversation.mockResolvedValue(BASE_CONV);
    mockCreateTurn.mockRejectedValue(new Error("DB error"));

    const [req, ctx] = makePostRequest(CONV_ID, { content: "hello" });
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DB_ERROR");
  });
});

// ── GET /api/conversations/:id/turns/:turnId ───────────────────────────────────

describe("GET /api/conversations/:id/turns/:turnId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for invalid conversation ID", async () => {
    const [req, ctx] = makeGetRequest("bad!", TURN_ID);
    const res = await GET(req, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid turn ID", async () => {
    const [req, ctx] = makeGetRequest(CONV_ID, "not-a-uuid");
    const res = await GET(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 404 when turn does not exist", async () => {
    mockGetTurnWithEvents.mockResolvedValue(null);
    const [req, ctx] = makeGetRequest(CONV_ID, TURN_ID);
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 404 when turn belongs to a different conversation", async () => {
    mockGetTurnWithEvents.mockResolvedValue({
      turn: { ...TURN_ROW, conversation_id: "different0000" },
      events: TURN_EVENTS,
    });
    const [req, ctx] = makeGetRequest(CONV_ID, TURN_ID);
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 200 with turn and events for a valid request", async () => {
    mockGetTurnWithEvents.mockResolvedValue({
      turn: TURN_ROW,
      events: TURN_EVENTS,
    });
    const [req, ctx] = makeGetRequest(CONV_ID, TURN_ID);
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turn.id).toBe(TURN_ID);
    expect(body.events).toHaveLength(2);
    expect(body.events[0].event_type).toBe("context");
    expect(body.events[1].event_type).toBe("complete");
  });

  it("returns 500 when DB throws", async () => {
    mockGetTurnWithEvents.mockRejectedValue(new Error("DB error"));
    const [req, ctx] = makeGetRequest(CONV_ID, TURN_ID);
    const res = await GET(req, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DB_ERROR");
  });
});

