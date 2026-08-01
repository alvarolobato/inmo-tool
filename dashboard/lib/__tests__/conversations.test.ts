import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockSql, mockLlmComplete, mockAssembleRequest } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockLlmComplete: vi.fn(),
  mockAssembleRequest: vi.fn(),
}));

vi.mock("@/lib/db-write", () => ({
  sql: mockSql,
}));

vi.mock("@/lib/llm-client", () => ({
  llmComplete: mockLlmComplete,
}));

vi.mock("@/lib/llm-context", () => ({
  assembleRequest: mockAssembleRequest,
}));

// Mock crypto to produce deterministic ids in tests
vi.mock("crypto", () => ({
  default: {
    randomBytes: (n: number) => ({
      toString: () => "a".repeat(n * 2),
    }),
  },
  randomBytes: (n: number) => ({
    toString: () => "a".repeat(n * 2),
  }),
}));

import {
  generateConversationId,
  createConversation,
  getConversation,
  getConversationWithMessages,
  listConversations,
  updateConversationTitle,
  setConversationTitleOnce,
  setConversationArchived,
  archiveConversation,
  unarchiveConversation,
  updateTitle,
  updateLastStatus,
  appendMessage,
  countMessages,
  maybeGenerateTitle,
  migrateConversationToDashboard,
  markConversationRead,
} from "../conversations";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createConversation", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it("inserts a row and returns id + viewer URLs", async () => {
    mockSql.mockResolvedValue([]);
    const result = await createConversation({ mode: "analyze" });

    expect(result.id).toHaveLength(12);
    expect(result.c_url).toBe(`/c/${result.id}`);
    expect(result.k_url).toBe(`/k/${result.id}`);

    expect(mockSql).toHaveBeenCalledOnce();
    const [sql, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO conversations");
    expect(params[0]).toBe(result.id);
    expect(params[1]).toBe("analyze");
  });

  it("stores context fields when provided", async () => {
    mockSql.mockResolvedValue([]);
    await createConversation({
      mode: "analyze",
      context_kind: "dashboard",
      context_ref: "42",
      context_url: "/dashboard/42",
    });
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe("/dashboard/42");
    expect(params[3]).toBe("dashboard");
    expect(params[4]).toBe("42");
  });
});

describe("getConversation", () => {
  beforeEach(() => mockSql.mockReset());

  it("returns the first row when found", async () => {
    const conv = { id: "abc123", mode: "analyze", title: null };
    mockSql.mockResolvedValue([conv]);
    const result = await getConversation("abc123");
    expect(result).toEqual(conv);
  });

  it("returns null when not found", async () => {
    mockSql.mockResolvedValue([]);
    const result = await getConversation("notexist");
    expect(result).toBeNull();
  });
});

describe("updateConversationTitle", () => {
  beforeEach(() => mockSql.mockReset());

  it("executes an UPDATE with the correct params", async () => {
    mockSql.mockResolvedValue([]);
    await updateConversationTitle("abc123", "Mi análisis");
    const [sql, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE conversations");
    expect(sql).toContain("title");
    expect(params).toEqual(["abc123", "Mi análisis"]);
  });
});

describe("setConversationTitleOnce", () => {
  beforeEach(() => mockSql.mockReset());

  it("executes an UPDATE with AND title IS NULL guard", async () => {
    mockSql.mockResolvedValue([]);
    await setConversationTitleOnce("abc123", "Ventas semanales");
    const [sql, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE conversations");
    expect(sql).toContain("title IS NULL");
    expect(params).toEqual(["abc123", "Ventas semanales"]);
  });
});

describe("setConversationArchived", () => {
  beforeEach(() => mockSql.mockReset());

  it("sets archived_at to a non-null value when archiving", async () => {
    mockSql.mockResolvedValue([]);
    await setConversationArchived("abc123", true);
    const [sql, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("archived_at");
    expect(params[1]).not.toBeNull(); // application timestamp
  });

  it("sets archived_at to null when unarchiving", async () => {
    mockSql.mockResolvedValue([]);
    await setConversationArchived("abc123", false);
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBeNull();
  });
});

describe("appendMessage", () => {
  beforeEach(() => mockSql.mockReset());

  it("inserts with the correct role and serialized content", async () => {
    mockSql.mockResolvedValue([]);
    await appendMessage("conv1", { role: "user", content: { text: "Hola" } });
    const [sql, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO conversation_messages");
    expect(params[0]).toBe("conv1");
    expect(params[1]).toBe("user");
    expect(params[2]).toBe('{"text":"Hola"}');
  });
});

describe("countMessages", () => {
  beforeEach(() => mockSql.mockReset());

  it("returns the parsed count from the DB", async () => {
    mockSql.mockResolvedValue([{ n: "7" }]);
    const n = await countMessages("conv1");
    expect(n).toBe(7);
  });

  it("returns 0 when no rows returned", async () => {
    mockSql.mockResolvedValue([]);
    const n = await countMessages("conv1");
    expect(n).toBe(0);
  });
});

describe("maybeGenerateTitle", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockLlmComplete.mockReset();
    mockAssembleRequest.mockReset();
  });

  const messages = [
    { role: "user" as const, content: "¿Cuánto vendimos ayer?" },
    { role: "assistant" as const, content: "Vendimos 12.345 € en total ayer." },
  ];

  it("calls assembleRequest and updates title when conversation has no title", async () => {
    // getConversation returns a conv with title=null
    mockSql.mockResolvedValueOnce([{ id: "conv1", title: null }]);
    mockAssembleRequest.mockResolvedValue({ text: "Ventas de ayer análisis", usage: {}, model: "test" });
    // updateConversationTitle INSERT
    mockSql.mockResolvedValueOnce([]);

    await maybeGenerateTitle("conv1", messages);

    expect(mockAssembleRequest).toHaveBeenCalledOnce();
    const [flow, , , , opts] = mockAssembleRequest.mock.calls[0] as [string, unknown, unknown, string, { maxOutputTokens: number }];
    expect(flow).toBe("title");
    expect(opts.maxOutputTokens).toBe(30);

    // Should have called conditional UPDATE (WHERE title IS NULL) to persist the title
    expect(mockSql).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = mockSql.mock.calls[1] as [string, unknown[]];
    expect(updateSql).toContain("UPDATE conversations");
    expect(updateSql).toContain("title IS NULL");
    expect(updateParams[1]).toBe("Ventas de ayer análisis");
  });

  it("skips title generation when title is already set", async () => {
    mockSql.mockResolvedValueOnce([{ id: "conv1", title: "Existing title" }]);
    await maybeGenerateTitle("conv1", messages);
    expect(mockAssembleRequest).not.toHaveBeenCalled();
  });

  it("skips when conversation not found", async () => {
    mockSql.mockResolvedValueOnce([]);
    await maybeGenerateTitle("conv1", messages);
    expect(mockAssembleRequest).not.toHaveBeenCalled();
  });

  it("skips when messages lack both user and assistant", async () => {
    await maybeGenerateTitle("conv1", []);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockAssembleRequest).not.toHaveBeenCalled();
  });

  it("strips surrounding quotes from generated title", async () => {
    mockSql.mockResolvedValueOnce([{ id: "conv1", title: null }]);
    mockAssembleRequest.mockResolvedValue({ text: '"Ventas ayer"', usage: {}, model: "test" });
    mockSql.mockResolvedValueOnce([]);

    await maybeGenerateTitle("conv1", messages);

    const [updateSql, updateParams] = mockSql.mock.calls[1] as [string, unknown[]];
    expect(updateSql).toContain("title IS NULL");
    expect(updateParams[1]).toBe("Ventas ayer");
  });

  it("swallows errors silently — non-blocking", async () => {
    mockSql.mockResolvedValueOnce([{ id: "conv1", title: null }]);
    mockAssembleRequest.mockRejectedValue(new Error("LLM is down"));
    // Should not throw
    await expect(maybeGenerateTitle("conv1", messages)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateConversationId
// ---------------------------------------------------------------------------

describe("generateConversationId", () => {
  it("returns 12 hex characters", () => {
    const id = generateConversationId();
    expect(id).toMatch(/^[a-f0-9]{12}$/);
  });
});

// ---------------------------------------------------------------------------
// getConversationWithMessages
// ---------------------------------------------------------------------------

describe("getConversationWithMessages", () => {
  beforeEach(() => mockSql.mockReset());

  it("returns conversation with messages array", async () => {
    const conv = { id: "abc123", mode: "modify", title: null };
    const msg = { id: "msg-1", conversation_id: "abc123", role: "user", content: { text: "Hola" }, created_at: "2026-01-01" };
    mockSql
      .mockResolvedValueOnce([conv])  // getConversation
      .mockResolvedValueOnce([msg])   // messages query
      .mockResolvedValueOnce([]);     // activeTurns query

    const result = await getConversationWithMessages("abc123");
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0].role).toBe("user");
  });

  it("returns null when conversation not found", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getConversationWithMessages("notexist");
    expect(result).toBeNull();
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// listConversations
// ---------------------------------------------------------------------------

describe("listConversations", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
  });

  it("defaults to hiding archived (WHERE archived_at IS NULL)", async () => {
    await listConversations();
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("archived_at IS NULL");
  });

  it("includes archived rows when include_archived=true", async () => {
    await listConversations({ include_archived: true });
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).not.toContain("archived_at IS NULL");
  });

  it("filters by context_kind and context_ref", async () => {
    await listConversations({ context_kind: "dashboard", context_ref: "42" });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("context_kind");
    expect(query).toContain("context_ref");
    expect(params).toContain("dashboard");
    expect(params).toContain("42");
  });

  it("filters by context_kinds array (multi-select) using ANY", async () => {
    await listConversations({ context_kinds: ["dashboard", "home"] });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("ANY(");
    expect(params.some((p) => Array.isArray(p) && p.includes("dashboard") && p.includes("home"))).toBe(true);
  });

  it("context_kinds with single item uses equality, not ANY", async () => {
    await listConversations({ context_kinds: ["dashboard"] });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("c.context_kind = ");
    expect(query).not.toContain("ANY(");
    expect(params).toContain("dashboard");
  });

  it("context_kinds takes precedence over context_kind", async () => {
    await listConversations({ context_kind: "global", context_kinds: ["dashboard", "home"] });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("ANY(");
    expect(params.some((p) => Array.isArray(p) && p.includes("dashboard"))).toBe(true);
    expect(params).not.toContain("global");
  });

  it("filters by mode (single)", async () => {
    await listConversations({ mode: "modify" });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("c.mode = ");
    expect(params).toContain("modify");
  });

  it("filters by modes array (multi-select) using ANY", async () => {
    await listConversations({ modes: ["generate", "modify"] });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("ANY(");
    expect(params.some((p) => Array.isArray(p) && p.includes("generate") && p.includes("modify"))).toBe(true);
  });

  it("modes array with single item uses equality, not ANY", async () => {
    await listConversations({ modes: ["analyze"] });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("c.mode = ");
    expect(query).not.toContain("ANY(");
    expect(params).toContain("analyze");
  });

  it("modes array takes precedence over mode string", async () => {
    await listConversations({ mode: "title", modes: ["generate", "modify"] });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("ANY(");
    expect(params.some((p) => Array.isArray(p) && p.includes("generate"))).toBe(true);
    // "title" should not appear as a standalone param
    expect(params).not.toContain("title");
  });

  it("shows only archived rows when only_archived=true", async () => {
    await listConversations({ only_archived: true });
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("archived_at IS NOT NULL");
    expect(query).not.toContain("archived_at IS NULL");
  });

  it("only_archived overrides include_archived", async () => {
    await listConversations({ only_archived: true, include_archived: true });
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("archived_at IS NOT NULL");
    expect(query).not.toContain("archived_at IS NULL");
  });

  it("filters by q (search) with ILIKE and escaped wildcards", async () => {
    await listConversations({ q: "100%" });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("ILIKE");
    expect(params.some((p) => typeof p === "string" && p.includes("100\\%"))).toBe(true);
  });

  it("ignores empty q", async () => {
    await listConversations({ q: "   " });
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).not.toContain("ILIKE");
  });

  it("passes limit as a SQL parameter", async () => {
    await listConversations({ limit: 5 });
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("LIMIT $");
    expect(params).toContain(5);
  });

  it("includes LEFT JOIN to dashboards and selects context_dashboard_name", async () => {
    const fixture = {
      id: "conv1", mode: "modify", title: null, first_user_prompt: null,
      context_url: "/dashboard/42", context_kind: "dashboard", context_ref: "42",
      created_at: "2026-05-01", last_interaction_at: "2026-05-01", archived_at: null,
      last_status: null, llm_provider: null, llm_driver: null, initial_context: null,
      created_by: null, message_count: 0, tool_calls_count: 0, rounds_count: 0,
      duration_seconds: 0, last_message_preview: null, token_total: 0,
      context_dashboard_name: "Mi panel de ventas",
    };
    mockSql.mockResolvedValue([fixture]);
    const rows = await listConversations({ context_kind: "dashboard" });

    expect(rows[0].context_dashboard_name).toBe("Mi panel de ventas");
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("LEFT JOIN dashboards");
    expect(query).toContain("context_dashboard_name");
  });

  it("returns null context_dashboard_name for non-dashboard conversations", async () => {
    const fixture = {
      id: "conv2", mode: "chat", title: null, first_user_prompt: null,
      context_url: null, context_kind: "global", context_ref: null,
      created_at: "2026-05-01", last_interaction_at: "2026-05-01", archived_at: null,
      last_status: null, llm_provider: null, llm_driver: null, initial_context: null,
      created_by: null, message_count: 0, tool_calls_count: 0, rounds_count: 0,
      duration_seconds: 0, last_message_preview: null, token_total: 0,
      context_dashboard_name: null,
    };
    mockSql.mockResolvedValue([fixture]);
    const rows = await listConversations({ context_kind: "global" });

    expect(rows[0].context_dashboard_name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// archiveConversation / unarchiveConversation
// ---------------------------------------------------------------------------

describe("archiveConversation", () => {
  beforeEach(() => mockSql.mockReset());

  it("delegates to setConversationArchived(true) — sets archived_at to non-null", async () => {
    mockSql.mockResolvedValue([]);
    await archiveConversation("abc123");
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("abc123");
    expect(params[1]).not.toBeNull();
  });
});

describe("unarchiveConversation", () => {
  beforeEach(() => mockSql.mockReset());

  it("delegates to setConversationArchived(false) — clears archived_at", async () => {
    mockSql.mockResolvedValue([]);
    await unarchiveConversation("abc123");
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("abc123");
    expect(params[1]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateTitle / updateLastStatus
// ---------------------------------------------------------------------------

describe("updateTitle", () => {
  beforeEach(() => mockSql.mockReset());

  it("updates the title column", async () => {
    mockSql.mockResolvedValue([]);
    await updateTitle("abc123", "Nuevo título");
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("title");
    expect(params[0]).toBe("abc123");
    expect(params[1]).toBe("Nuevo título");
  });
});

describe("updateLastStatus", () => {
  beforeEach(() => mockSql.mockReset());

  it("updates last_interaction_at and last_status", async () => {
    mockSql.mockResolvedValue([]);
    await updateLastStatus("abc123", "ok");
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("last_interaction_at");
    expect(params[0]).toBe("abc123");
    expect(params[1]).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// markConversationRead
// ---------------------------------------------------------------------------

describe("markConversationRead", () => {
  beforeEach(() => mockSql.mockReset());

  it("executes UPDATE SET last_read_at = NOW() for the given id", async () => {
    mockSql.mockResolvedValue([]);
    await markConversationRead("abc123def456");
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("UPDATE conversations");
    expect(query).toContain("last_read_at");
    expect(query).toContain("NOW()");
    expect(params[0]).toBe("abc123def456");
  });
});

// ---------------------------------------------------------------------------
// listConversations — is_unread computed field
// ---------------------------------------------------------------------------

describe("listConversations — is_unread and last_read_at fields", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
  });

  it("SELECT includes last_read_at and is_unread", async () => {
    await listConversations();
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("last_read_at");
    expect(query).toContain("is_unread");
  });

  it("is_unread expression covers null last_read_at case", async () => {
    await listConversations();
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("last_read_at IS NULL");
    expect(query).toContain("last_interaction_at > c.created_at");
  });

  it("is_unread expression covers non-null last_read_at case", async () => {
    await listConversations();
    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("last_read_at IS NOT NULL");
    expect(query).toContain("last_interaction_at > c.last_read_at");
  });

  it("returns is_unread and last_read_at values from the row", async () => {
    const fixture = {
      id: "conv1", mode: "chat", title: null, first_user_prompt: null,
      context_url: null, context_kind: "global", context_ref: null,
      created_at: "2026-05-01T10:00:00Z", last_interaction_at: "2026-05-01T11:00:00Z",
      archived_at: null, last_status: null, llm_provider: null, llm_driver: null,
      initial_context: null, created_by: null, last_read_at: null,
      message_count: 3, tool_calls_count: 0, rounds_count: 0,
      duration_seconds: 3600, last_message_preview: "Hola", token_total: 100,
      context_dashboard_name: null, is_unread: true,
    };
    mockSql.mockResolvedValue([fixture]);
    const rows = await listConversations();
    expect(rows[0].is_unread).toBe(true);
    expect(rows[0].last_read_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// migrateConversationToDashboard
// ---------------------------------------------------------------------------

describe("migrateConversationToDashboard", () => {
  beforeEach(() => mockSql.mockReset());

  it("issues UPDATE with mode/context_kind/context_ref/context_url and archived_at guard", async () => {
    const conv = {
      id: "abc123def456",
      mode: "modify",
      context_kind: "dashboard",
      context_ref: "42",
      context_url: "/dashboard/42",
      archived_at: null,
      title: null,
    };
    mockSql
      .mockResolvedValueOnce([{ id: "abc123def456" }]) // UPDATE … RETURNING id
      .mockResolvedValueOnce([conv]);                  // getConversation

    const result = await migrateConversationToDashboard("abc123def456", "42");

    const [updateSql, updateParams] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(updateSql).toContain("UPDATE conversations");
    expect(updateSql).toContain("mode");
    expect(updateSql).toContain("context_kind");
    expect(updateSql).toContain("context_ref");
    expect(updateSql).toContain("context_url");
    expect(updateSql).toContain("archived_at IS NULL");
    expect(updateParams[0]).toBe("abc123def456");
    expect(updateParams[1]).toBe("42");

    expect(result.mode).toBe("modify");
    expect(result.context_kind).toBe("dashboard");
    expect(result.context_ref).toBe("42");
    expect(result.context_url).toBe("/dashboard/42");
  });

  it("throws when conversation not found or archived (UPDATE returns 0 rows)", async () => {
    mockSql.mockResolvedValueOnce([]); // UPDATE RETURNING → zero rows
    await expect(migrateConversationToDashboard("abc123def456", "42")).rejects.toThrow(
      /not found or is archived/i,
    );
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Structural contract: no delete from conversations
// ---------------------------------------------------------------------------

describe("no-delete contract", () => {
  it("conversations module does not contain DELETE FROM conversations", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(
      __dirname,
      "..",
      "conversations.ts",
    );
    const src = fs.readFileSync(filePath, "utf-8");
    expect(src).not.toMatch(/DELETE\s+FROM\s+conversations/i);
  });

  it("does not export deleteConversation", async () => {
    const mod = await import("../conversations");
    expect("deleteConversation" in mod).toBe(false);
  });
});
