/**
 * Tests for POST /api/conversations/:id/handoff-to-dashboard
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetConversation = vi.fn();
const mockMigrateConversationToDashboard = vi.fn();
const mockSql = vi.fn();

vi.mock("@/lib/conversations", () => ({
  getConversation: (...args: unknown[]) => mockGetConversation(...args),
  migrateConversationToDashboard: (...args: unknown[]) =>
    mockMigrateConversationToDashboard(...args),
}));

vi.mock("@/lib/db-write", () => ({
  sql: (...args: unknown[]) => mockSql(...args),
}));

vi.mock("@/lib/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/errors")>();
  return { ...actual, generateRequestId: () => "test-req-id" };
});

import { POST } from "../route";

const VALID_CONV_ID = "abcdef012345";
const VALID_DASHBOARD_ID = "42";

const MOCK_CONV = {
  id: VALID_CONV_ID,
  mode: "chat",
  title: null,
  first_user_prompt: "Hola",
  context_url: null,
  context_kind: "global",
  context_ref: null,
  created_at: "2026-01-01T00:00:00Z",
  last_interaction_at: "2026-01-01T00:01:00Z",
  archived_at: null,
  last_status: null,
  llm_provider: "openrouter",
  llm_driver: null,
  initial_context: null,
  created_by: null,
};

const MIGRATED_CONV = {
  ...MOCK_CONV,
  mode: "modify",
  context_kind: "dashboard",
  context_ref: VALID_DASHBOARD_ID,
  context_url: `/dashboard/${VALID_DASHBOARD_ID}`,
};

function params(id: string) {
  return { params: { id } };
}

function makeRequest(id: string, body: unknown) {
  return new NextRequest(
    `http://localhost:4000/api/conversations/${id}/handoff-to-dashboard`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  mockGetConversation.mockReset();
  mockMigrateConversationToDashboard.mockReset();
  mockSql.mockReset();
});

describe("POST /api/conversations/:id/handoff-to-dashboard", () => {
  describe("validation — conversation ID", () => {
    it("returns 400 for an invalid conversation ID", async () => {
      const req = makeRequest("not-valid-hex", { dashboard_id: VALID_DASHBOARD_ID });
      const res = await POST(req, params("not-valid-hex"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION");
      expect(mockGetConversation).not.toHaveBeenCalled();
    });

    it("returns 400 for a too-short ID", async () => {
      const req = makeRequest("abc123", { dashboard_id: VALID_DASHBOARD_ID });
      const res = await POST(req, params("abc123"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION");
    });
  });

  describe("validation — request body", () => {
    it("returns 400 when body is missing dashboard_id", async () => {
      mockGetConversation.mockResolvedValue(MOCK_CONV);
      const req = new NextRequest(
        `http://localhost:4000/api/conversations/${VALID_CONV_ID}/handoff-to-dashboard`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_BODY");
    });

    it("returns 400 when dashboard_id is not a string", async () => {
      const req = makeRequest(VALID_CONV_ID, { dashboard_id: 42 });
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_BODY");
    });

    it("returns 400 when dashboard_id is an empty string", async () => {
      const req = makeRequest(VALID_CONV_ID, { dashboard_id: "" });
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_BODY");
    });

    it("returns 400 when dashboard_id is not a positive integer", async () => {
      const req = makeRequest(VALID_CONV_ID, { dashboard_id: "not-a-number" });
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_BODY");
    });

    it("returns 400 when body is invalid JSON", async () => {
      const req = new NextRequest(
        `http://localhost:4000/api/conversations/${VALID_CONV_ID}/handoff-to-dashboard`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-json",
        },
      );
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_BODY");
    });
  });

  describe("conversation checks", () => {
    it("returns 404 when conversation does not exist", async () => {
      mockGetConversation.mockResolvedValue(null);
      const req = makeRequest(VALID_CONV_ID, { dashboard_id: VALID_DASHBOARD_ID });
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NOT_FOUND");
      expect(mockMigrateConversationToDashboard).not.toHaveBeenCalled();
    });

    it("returns 409 when conversation is archived", async () => {
      mockGetConversation.mockResolvedValue({
        ...MOCK_CONV,
        archived_at: "2026-01-02T00:00:00Z",
      });
      const req = makeRequest(VALID_CONV_ID, { dashboard_id: VALID_DASHBOARD_ID });
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("CONVERSATION_ARCHIVED");
      expect(mockMigrateConversationToDashboard).not.toHaveBeenCalled();
    });
  });

  describe("dashboard checks", () => {
    it("returns 404 when dashboard_id does not exist in the dashboards table", async () => {
      mockGetConversation.mockResolvedValue(MOCK_CONV);
      mockSql.mockResolvedValue([]); // dashboards query returns no rows

      const req = makeRequest(VALID_CONV_ID, { dashboard_id: "999" });
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NOT_FOUND");
      expect(body.details).toContain("999");
      expect(mockMigrateConversationToDashboard).not.toHaveBeenCalled();
    });
  });

  describe("happy path", () => {
    it("migrates conversation and returns ok response with redirect_url", async () => {
      mockGetConversation.mockResolvedValue(MOCK_CONV);
      mockSql.mockResolvedValue([{ id: 42 }]); // dashboard exists
      mockMigrateConversationToDashboard.mockResolvedValue(MIGRATED_CONV);

      const req = makeRequest(VALID_CONV_ID, { dashboard_id: VALID_DASHBOARD_ID });
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.redirect_url).toBe(`/dashboard/${VALID_DASHBOARD_ID}`);
      expect(body.conversation.mode).toBe("modify");
      expect(body.conversation.context_kind).toBe("dashboard");
      expect(body.conversation.context_ref).toBe(VALID_DASHBOARD_ID);
      expect(body.conversation.context_url).toBe(`/dashboard/${VALID_DASHBOARD_ID}`);
    });

    it("calls migrateConversationToDashboard with correct arguments", async () => {
      mockGetConversation.mockResolvedValue(MOCK_CONV);
      mockSql.mockResolvedValue([{ id: 42 }]);
      mockMigrateConversationToDashboard.mockResolvedValue(MIGRATED_CONV);

      const req = makeRequest(VALID_CONV_ID, { dashboard_id: VALID_DASHBOARD_ID });
      await POST(req, params(VALID_CONV_ID));

      expect(mockMigrateConversationToDashboard).toHaveBeenCalledWith(
        VALID_CONV_ID,
        VALID_DASHBOARD_ID,
      );
    });

    it("does NOT modify initial_context or messages (passes through conversation unchanged)", async () => {
      const convWithContext = {
        ...MOCK_CONV,
        initial_context: { model: "claude", provider: "openrouter" },
      };
      mockGetConversation.mockResolvedValue(convWithContext);
      mockSql.mockResolvedValue([{ id: 42 }]);
      mockMigrateConversationToDashboard.mockResolvedValue({
        ...convWithContext,
        mode: "modify",
        context_kind: "dashboard",
        context_ref: VALID_DASHBOARD_ID,
        context_url: `/dashboard/${VALID_DASHBOARD_ID}`,
      });

      const req = makeRequest(VALID_CONV_ID, { dashboard_id: VALID_DASHBOARD_ID });
      const res = await POST(req, params(VALID_CONV_ID));
      const body = await res.json();

      // initial_context must remain unchanged
      expect(body.conversation.initial_context).toEqual({
        model: "claude",
        provider: "openrouter",
      });
    });
  });

  describe("error handling", () => {
    it("returns 500 when the DB throws during migration", async () => {
      mockGetConversation.mockResolvedValue(MOCK_CONV);
      mockSql.mockResolvedValue([{ id: 42 }]);
      mockMigrateConversationToDashboard.mockRejectedValue(new Error("DB error"));

      const req = makeRequest(VALID_CONV_ID, { dashboard_id: VALID_DASHBOARD_ID });
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("DB_ERROR");
    });

    it("returns 409 when conversation is archived concurrently (TOCTOU)", async () => {
      mockGetConversation.mockResolvedValue(MOCK_CONV); // active when pre-flight checked
      mockSql.mockResolvedValue([{ id: 42 }]);
      mockMigrateConversationToDashboard.mockRejectedValue(
        new Error(`Conversation ${VALID_CONV_ID} not found or is archived.`),
      );

      const req = makeRequest(VALID_CONV_ID, { dashboard_id: VALID_DASHBOARD_ID });
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("CONVERSATION_ARCHIVED");
    });

    it("returns 500 when getConversation throws", async () => {
      mockGetConversation.mockRejectedValue(new Error("connection refused"));

      const req = makeRequest(VALID_CONV_ID, { dashboard_id: VALID_DASHBOARD_ID });
      const res = await POST(req, params(VALID_CONV_ID));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("DB_ERROR");
    });
  });
});
