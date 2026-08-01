/**
 * Unit tests for the turn-events data layer.
 * Mocks @/lib/db-write so no live DB is needed.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
// withTransaction runs the callback with a fake client whose .query is mockQuery.
const mockQuery = vi.fn();
const fakeClient = { query: (...a: unknown[]) => mockQuery(...a) };

vi.mock("@/lib/db-write", () => ({
  sql: (...a: unknown[]) => mockSql(...a),
  withTransaction: (fn: (c: unknown) => unknown) => fn(fakeClient),
}));

import {
  createTurnIfIdle,
  updateTurnStatus,
  insertTurnEvent,
  getTurnWithEvents,
  getConversationEvents,
} from "@/lib/turn-events";

const CONV_ID = "abcdef012345";
const TURN_ID = "550e8400-e29b-41d4-a716-446655440000";

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
    payload: { model: "claude-sonnet-4-6" },
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createTurnIfIdle", () => {
  beforeEach(() => mockQuery.mockReset());

  it("takes the advisory lock, finds no active turn, and inserts (#823)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // pg_advisory_xact_lock
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // active-turn check
      .mockResolvedValueOnce({ rows: [{ id: TURN_ID, turn_index: 3 }] }); // insert

    const result = await createTurnIfIdle(CONV_ID, "test message");

    expect(result).toEqual({ ok: true, turnId: TURN_ID, turnIndex: 3 });
    // The lock is acquired before the check, all in one transaction.
    expect(mockQuery.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
  });

  it("rejects without inserting when an active turn already exists", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // lock
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ "?column?": 1 }] }); // active turn found

    const result = await createTurnIfIdle(CONV_ID, "second");

    expect(result).toEqual({ ok: false, reason: "active_turn" });
    // Only the lock + the check ran — no INSERT.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("scopes the staleness cutoff so a crashed turn doesn't block forever", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: TURN_ID, turn_index: 0 }] });

    await createTurnIfIdle(CONV_ID, "x");

    const checkQuery = mockQuery.mock.calls[1][0] as string;
    expect(checkQuery).toContain("status IN ('pending', 'streaming')");
    expect(checkQuery).toContain("created_at >");
  });

  it("throws when the INSERT returns no row", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(createTurnIfIdle(CONV_ID, "x")).rejects.toThrow(
      "createTurnIfIdle: no row returned",
    );
  });
});

describe("updateTurnStatus", () => {
  it("sets started_at when status=streaming", async () => {
    mockSql.mockResolvedValueOnce([]);
    await updateTurnStatus(TURN_ID, "streaming");
    const [query] = mockSql.mock.calls[0] as [string];
    expect(query).toContain("started_at");
    expect(query).not.toContain("completed_at");
  });

  it("sets completed_at when status=complete", async () => {
    mockSql.mockResolvedValueOnce([]);
    await updateTurnStatus(TURN_ID, "complete");
    const [query] = mockSql.mock.calls[0] as [string];
    expect(query).toContain("completed_at");
    expect(query).not.toContain("started_at");
  });

  it("sets error column when status=error", async () => {
    mockSql.mockResolvedValueOnce([]);
    await updateTurnStatus(TURN_ID, "error", "something failed");
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("error");
    expect(params).toContain("something failed");
  });

  it("sets only status when status=pending", async () => {
    mockSql.mockResolvedValueOnce([]);
    await updateTurnStatus(TURN_ID, "pending");
    const [query] = mockSql.mock.calls[0] as [string];
    expect(query).not.toContain("started_at");
    expect(query).not.toContain("completed_at");
  });
});

describe("insertTurnEvent", () => {
  it("writes correct params to DB", async () => {
    mockSql.mockResolvedValueOnce([{ id: 42 }]);
    await insertTurnEvent(TURN_ID, 5, "log", { kind: "meta", text: "Procesando…" });
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(TURN_ID);
    expect(params[1]).toBe(5);
    expect(params[2]).toBe("log");
    const payload = JSON.parse(params[3] as string);
    expect(payload.kind).toBe("meta");
  });
});

describe("getTurnWithEvents", () => {
  it("returns null when turn not found", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getTurnWithEvents(TURN_ID);
    expect(result).toBeNull();
  });

  it("returns turn with events when found", async () => {
    mockSql.mockResolvedValueOnce([TURN_ROW]).mockResolvedValueOnce(TURN_EVENTS);
    const result = await getTurnWithEvents(TURN_ID);
    expect(result?.turn.id).toBe(TURN_ID);
    expect(result?.events).toHaveLength(2);
  });
});

describe("getConversationEvents", () => {
  it("returns all events when sinceId is not provided", async () => {
    mockSql.mockResolvedValueOnce(TURN_EVENTS);
    const events = await getConversationEvents(CONV_ID);
    expect(events).toHaveLength(2);
    const [query] = mockSql.mock.calls[0] as [string];
    expect(query).not.toContain("te.id >");
  });

  it("filters events by id when sinceId is provided", async () => {
    mockSql.mockResolvedValueOnce([TURN_EVENTS[1]]);
    const events = await getConversationEvents(CONV_ID, 1);
    expect(events).toHaveLength(1);
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("te.id >");
    expect(params[1]).toBe(1);
  });
});
