/**
 * Tests for GET /api/conversations/:id/context/:turnId
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetConversation = vi.fn();
const mockGetTurnContextFile = vi.fn();
const mockReadTurnContext = vi.fn();

vi.mock("@/lib/conversations", () => ({
  getConversation: (...a: unknown[]) => mockGetConversation(...a),
}));
vi.mock("@/lib/turn-events", () => ({
  getTurnContextFile: (...a: unknown[]) => mockGetTurnContextFile(...a),
}));
vi.mock("@/lib/conversation-context-store", () => ({
  readTurnContext: (...a: unknown[]) => mockReadTurnContext(...a),
}));

import { GET } from "../route";

const CONV = "abcdef012345";
const TURN = "550e8400-e29b-41d4-a716-446655440000";

function call(id: string, turnId: string) {
  const req = new NextRequest(`http://localhost/api/conversations/${id}/context/${turnId}`);
  return GET(req, { params: { id, turnId } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConversation.mockResolvedValue({ id: CONV });
  mockGetTurnContextFile.mockResolvedValue(`${CONV}/${TURN}.json`);
  mockReadTurnContext.mockResolvedValue({ system_prompt_stable: "sys", tools: [] });
});

describe("GET /api/conversations/:id/context/:turnId", () => {
  it("returns the context JSON from the file", async () => {
    const res = await call(CONV, TURN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.system_prompt_stable).toBe("sys");
    // The file path is resolved scoped to the conversation.
    expect(mockGetTurnContextFile).toHaveBeenCalledWith(CONV, TURN);
    expect(mockReadTurnContext).toHaveBeenCalledWith(`${CONV}/${TURN}.json`);
  });

  it("400 on a malformed conversation id", async () => {
    const res = await call("nope", TURN);
    expect(res.status).toBe(400);
  });

  it("404 when the conversation does not exist", async () => {
    mockGetConversation.mockResolvedValueOnce(null);
    const res = await call(CONV, TURN);
    expect(res.status).toBe(404);
  });

  it("404 when the turn has no context file", async () => {
    mockGetTurnContextFile.mockResolvedValueOnce(null);
    const res = await call(CONV, TURN);
    expect(res.status).toBe(404);
    expect(mockReadTurnContext).not.toHaveBeenCalled();
  });

  it("404 when the file is missing on disk", async () => {
    mockReadTurnContext.mockResolvedValueOnce(null);
    const res = await call(CONV, TURN);
    expect(res.status).toBe(404);
  });
});
