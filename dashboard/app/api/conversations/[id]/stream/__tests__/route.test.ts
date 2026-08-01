/**
 * Tests for GET /api/conversations/:id/stream (SSE endpoint).
 *
 * AC-2: Connect to stream after a completed turn → receive all historical events in order.
 * AC-3: Connect with Last-Event-ID: N → only events with id > N arrive.
 * Live event test: Connect before turn starts → receive live event via pub/sub.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock declarations ──────────────────────────────────────────────────────────

const mockGetConversation = vi.fn();
const mockGetConversationEvents = vi.fn();

// Capture the subscribe listener so tests can trigger live events.
let capturedListener: ((event: unknown) => void) | null = null;
const mockUnsubscribe = vi.fn();
const mockSubscribe = vi.fn((_conversationId: string, listener: (event: unknown) => void) => {
  capturedListener = listener;
  return mockUnsubscribe;
});

vi.mock("@/lib/conversations", () => ({
  getConversation: (...a: unknown[]) => mockGetConversation(...a),
}));

vi.mock("@/lib/turn-events", () => ({
  getConversationEvents: (...a: unknown[]) => mockGetConversationEvents(...a),
}));

vi.mock("@/lib/sse-pubsub", () => ({
  subscribe: (...a: [string, (event: unknown) => void]) => mockSubscribe(...a),
}));

vi.mock("@/lib/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/errors")>();
  return { ...actual, generateRequestId: () => "test-req-id" };
});

import { GET } from "../route";

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

const TURN_EVENTS = [
  {
    id: 1,
    turn_id: TURN_ID,
    seq: 0,
    event_type: "context",
    payload: { model: "claude-sonnet-4-6" },
    created_at: "2026-01-01T00:00:01Z",
  },
  {
    id: 2,
    turn_id: TURN_ID,
    seq: 1,
    event_type: "log",
    payload: { kind: "meta", text: "Procesando…" },
    created_at: "2026-01-01T00:00:02Z",
  },
  {
    id: 3,
    turn_id: TURN_ID,
    seq: 2,
    event_type: "complete",
    payload: { messageId: "msg-abc" },
    created_at: "2026-01-01T00:00:05Z",
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRequest(conversationId: string, lastEventId?: string): NextRequest {
  const url = `http://localhost:4000/api/conversations/${conversationId}/stream`;
  const headers: Record<string, string> = {};
  if (lastEventId !== undefined) {
    headers["Last-Event-ID"] = lastEventId;
  }
  return new NextRequest(url, { headers });
}

function makeContext(id: string) {
  return { params: { id } };
}

/** Read chunks from a ReadableStream until it closes or a predicate is satisfied. */
async function readStreamChunks(
  stream: ReadableStream<Uint8Array>,
  opts: { maxChunks?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { maxChunks = 50, timeoutMs = 1000 } = opts;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let chunks = 0;

  const deadline = Date.now() + timeoutMs;
  while (chunks < maxChunks && Date.now() < deadline) {
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), 100),
    );
    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    if (done || value === undefined) break;
    result += decoder.decode(value, { stream: true });
    chunks++;
  }
  reader.releaseLock();
  return result;
}

/** Parse SSE text into event objects. */
function parseSseText(text: string): Array<{ id: number; data: Record<string, unknown> }> {
  const events: Array<{ id: number; data: Record<string, unknown> }> = [];
  const blocks = text.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    if (block.startsWith("event: ping")) continue;
    const lines = block.split("\n");
    let id: number | undefined;
    let dataStr: string | undefined;
    for (const line of lines) {
      if (line.startsWith("id: ")) id = parseInt(line.slice(4), 10);
      if (line.startsWith("data: ")) dataStr = line.slice(6);
    }
    if (id !== undefined && dataStr) {
      events.push({ id, data: JSON.parse(dataStr) as Record<string, unknown> });
    }
  }
  return events;
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  capturedListener = null;
  // Restore default mock implementation for mockSubscribe after clearAllMocks.
  mockSubscribe.mockImplementation((_id: string, listener: (event: unknown) => void) => {
    capturedListener = listener;
    return mockUnsubscribe;
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("GET /api/conversations/:id/stream", () => {
  describe("validation", () => {
    it("returns 400 for an invalid conversation ID", async () => {
      const req = makeRequest("invalid-id");
      const res = await GET(req, makeContext("invalid-id"));
      expect(res.status).toBe(400);
    });

    it("returns 404 when conversation does not exist", async () => {
      mockGetConversation.mockResolvedValue(null);
      const req = makeRequest(CONV_ID);
      const res = await GET(req, makeContext(CONV_ID));
      expect(res.status).toBe(404);
    });

    it("returns 500 when DB lookup throws", async () => {
      mockGetConversation.mockRejectedValue(new Error("DB down"));
      const req = makeRequest(CONV_ID);
      const res = await GET(req, makeContext(CONV_ID));
      expect(res.status).toBe(500);
    });
  });

  describe("AC-2: historical event replay", () => {
    it("returns 200 with text/event-stream content type", async () => {
      mockGetConversation.mockResolvedValue(BASE_CONV);
      mockGetConversationEvents.mockResolvedValue([]);

      const req = makeRequest(CONV_ID);
      const res = await GET(req, makeContext(CONV_ID));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    });

    it("replays all historical events in seq order", async () => {
      mockGetConversation.mockResolvedValue(BASE_CONV);
      mockGetConversationEvents.mockResolvedValue(TURN_EVENTS);

      const req = makeRequest(CONV_ID);
      const res = await GET(req, makeContext(CONV_ID));
      expect(res.body).not.toBeNull();

      const text = await readStreamChunks(res.body as ReadableStream<Uint8Array>);
      const events = parseSseText(text);

      expect(events).toHaveLength(3);
      expect(events[0].id).toBe(1);
      expect(events[0].data.eventType).toBe("context");
      expect(events[1].id).toBe(2);
      expect(events[1].data.eventType).toBe("log");
      expect(events[2].id).toBe(3);
      expect(events[2].data.eventType).toBe("complete");
      // Catch-up frames on a FRESH connection are tagged so the client can
      // distinguish them from live events (no refetch / no adoption — #825/#836).
      for (const ev of events) {
        expect(ev.data.replay).toBe(true);
      }
    });

    it("does NOT tag replayed frames on a resumption connection (Last-Event-ID)", async () => {
      mockGetConversation.mockResolvedValue(BASE_CONV);
      mockGetConversationEvents.mockResolvedValue(TURN_EVENTS.slice(2));

      const req = makeRequest(CONV_ID, "2");
      const res = await GET(req, makeContext(CONV_ID));
      const text = await readStreamChunks(res.body as ReadableStream<Uint8Array>);
      const events = parseSseText(text);

      // These frames are live events the client missed while disconnected
      // (possibly a complete/error) — the client must run its normal
      // refetch/settlement logic, so no replay tag.
      expect(events.length).toBeGreaterThan(0);
      for (const ev of events) {
        expect(ev.data.replay).toBeUndefined();
      }
    });

    it("live events published after replay carry no replay tag", async () => {
      mockGetConversation.mockResolvedValue(BASE_CONV);
      mockGetConversationEvents.mockResolvedValue([]);

      const req = makeRequest(CONV_ID);
      const res = await GET(req, makeContext(CONV_ID));

      // Publish a live event once the subscription is registered.
      await vi.waitFor(() => {
        if (!capturedListener) throw new Error("not subscribed yet");
      });
      capturedListener!({
        dbEventId: 10,
        turnId: "t1",
        seq: 0,
        eventType: "token",
        payload: { text: "hola" },
      });

      const text = await readStreamChunks(res.body as ReadableStream<Uint8Array>);
      const events = parseSseText(text);
      const live = events.find((e) => e.id === 10);
      expect(live).toBeDefined();
      expect(live!.data.replay).toBeUndefined();
    });

    it("calls getConversationEvents with no sinceId when no Last-Event-ID header", async () => {
      mockGetConversation.mockResolvedValue(BASE_CONV);
      mockGetConversationEvents.mockResolvedValue([]);

      const req = makeRequest(CONV_ID);
      await GET(req, makeContext(CONV_ID));

      expect(mockGetConversationEvents).toHaveBeenCalledWith(CONV_ID, undefined);
    });

    it("includes correct SSE id field matching turn_event.id", async () => {
      mockGetConversation.mockResolvedValue(BASE_CONV);
      mockGetConversationEvents.mockResolvedValue([TURN_EVENTS[0]]);

      const req = makeRequest(CONV_ID);
      const res = await GET(req, makeContext(CONV_ID));
      const text = await readStreamChunks(res.body as ReadableStream<Uint8Array>);

      expect(text).toContain("id: 1");
      expect(text).toContain('"eventType":"context"');
    });
  });

  describe("AC-3: Last-Event-ID resumption", () => {
    it("passes sinceId to getConversationEvents when Last-Event-ID header is present", async () => {
      mockGetConversation.mockResolvedValue(BASE_CONV);
      mockGetConversationEvents.mockResolvedValue([]);

      const req = makeRequest(CONV_ID, "5");
      await GET(req, makeContext(CONV_ID));

      expect(mockGetConversationEvents).toHaveBeenCalledWith(CONV_ID, 5);
    });

    it("only sends events with id > Last-Event-ID", async () => {
      // Events 1 and 2 were already received; only event 3 should arrive.
      const laterEvents = [TURN_EVENTS[2]];
      mockGetConversation.mockResolvedValue(BASE_CONV);
      mockGetConversationEvents.mockResolvedValue(laterEvents);

      const req = makeRequest(CONV_ID, "2");
      const res = await GET(req, makeContext(CONV_ID));
      const text = await readStreamChunks(res.body as ReadableStream<Uint8Array>);
      const events = parseSseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(3);
      expect(events[0].data.eventType).toBe("complete");
    });

    it("treats Last-Event-ID: 0 as no filter (replay all)", async () => {
      mockGetConversation.mockResolvedValue(BASE_CONV);
      mockGetConversationEvents.mockResolvedValue(TURN_EVENTS);

      const req = makeRequest(CONV_ID, "0");
      await GET(req, makeContext(CONV_ID));

      // sinceId 0 is treated as undefined (replay from the start).
      expect(mockGetConversationEvents).toHaveBeenCalledWith(CONV_ID, undefined);
    });
  });

  describe("live events via pub/sub", () => {
    it("delivers live events published after the stream is open", async () => {
      mockGetConversation.mockResolvedValue(BASE_CONV);
      mockGetConversationEvents.mockResolvedValue([]);

      const req = makeRequest(CONV_ID);
      const res = await GET(req, makeContext(CONV_ID));
      expect(res.body).not.toBeNull();

      // Allow the stream start() coroutine to set up the subscriber.
      await new Promise((r) => setTimeout(r, 10));

      // Simulate a live event published by the background turn job.
      expect(capturedListener).not.toBeNull();
      capturedListener!({
        dbEventId: 42,
        turnId: TURN_ID,
        seq: 0,
        eventType: "context",
        payload: { model: "test" },
      });

      const text = await readStreamChunks(res.body as ReadableStream<Uint8Array>, {
        timeoutMs: 500,
      });
      const events = parseSseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(42);
      expect(events[0].data.turnId).toBe(TURN_ID);
      expect(events[0].data.eventType).toBe("context");
    });

    it("subscribes to the pub/sub for the correct conversation", async () => {
      mockGetConversation.mockResolvedValue(BASE_CONV);
      mockGetConversationEvents.mockResolvedValue([]);

      const req = makeRequest(CONV_ID);
      await GET(req, makeContext(CONV_ID));

      // Allow start() to run.
      await new Promise((r) => setTimeout(r, 10));

      expect(mockSubscribe).toHaveBeenCalledWith(CONV_ID, expect.any(Function));
    });
  });
});
