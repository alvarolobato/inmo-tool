import { describe, it, expect } from "vitest";
import {
  handleExecuteQuery,
  handleValidateQuery,
  handleExplainQuery,
  handleDescribeTable,
} from "@/lib/llm-tools/handlers/sql";

const ctx = { requestId: "req_sql_test", endpoint: "test" };

describe("SQL tool handlers", () => {
  it("validate_query returns INVALID_ARGS for malformed JSON", async () => {
    const out = await handleValidateQuery("not-json", ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("INVALID_ARGS");
    }
  });

  it("validate_query returns INVALID_ARGS when sql is missing", async () => {
    const out = await handleValidateQuery("{}", ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("INVALID_ARGS");
    }
  });

  it("validate_query rejects bare EXPLAIN before touching the database", async () => {
    const out = await handleValidateQuery(
      JSON.stringify({ sql: "EXPLAIN SELECT 1" }),
      ctx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.valid).toBe(false);
      expect(out.data.reason).toMatch(/SELECT or WITH/i);
    }
  });

  it("validate_query rejects DML (UPDATE) before touching the database", async () => {
    const out = await handleValidateQuery(
      JSON.stringify({ sql: "UPDATE ps_ventas SET total_si = 0" }),
      ctx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      // Either pre-empted by the SELECT/WITH check or by validateReadOnly.
      expect(out.data.valid).toBe(false);
      expect(typeof out.data.reason).toBe("string");
    }
  });

  it("execute_query rejects bare EXPLAIN before touching the database", async () => {
    const out = await handleExecuteQuery(
      JSON.stringify({ sql: "EXPLAIN ANALYZE SELECT 1" }),
      ctx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.error).toMatch(/SELECT or WITH/i);
    }
  });

  it("execute_query returns INVALID_ARGS for malformed JSON", async () => {
    const out = await handleExecuteQuery("not-json", ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("INVALID_ARGS");
    }
  });

  it("explain_query returns INVALID_ARGS for malformed JSON", async () => {
    const out = await handleExplainQuery("not-json", ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("INVALID_ARGS");
    }
  });

  it("explain_query rejects DDL via validateReadOnly", async () => {
    const out = await handleExplainQuery(
      JSON.stringify({ sql: "DROP TABLE ps_ventas" }),
      ctx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.explain).toBeNull();
      expect(typeof out.data.error).toBe("string");
    }
  });

  it("explain_query rejects bare EXPLAIN ANALYZE", async () => {
    // validateReadOnly may accept "EXPLAIN ANALYZE SELECT" but the agentic
    // gate rejects anything that isn't SELECT/WITH at the top.
    const out = await handleExplainQuery(
      JSON.stringify({ sql: "EXPLAIN ANALYZE SELECT 1" }),
      ctx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.explain).toBeNull();
      expect(out.data.error).toMatch(/SELECT|WITH|EXPLAIN/i);
    }
  });

  it("describe_table returns INVALID_ARGS for malformed JSON", async () => {
    const out = await handleDescribeTable("not-json", ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("INVALID_ARGS");
    }
  });

  // #24 widened this from a `ps_*` prefix rule to a plain-identifier rule: this
  // schema names its tables plainly (property, listing, …). The regex is still
  // the guard that keeps anything non-identifier-shaped out of the query.
  it("describe_table rejects table names that are not plain identifiers", async () => {
    for (const bad of ["users; DROP TABLE listing", "public.listing", "líst-ing", ""]) {
      const out = await handleDescribeTable(JSON.stringify({ table: bad }), ctx);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe("INVALID_ARGS");
    }
  });
});

// ── Table allowlist (#24 review) ─────────────────────────────────────────────
//
// `public` holds the app's own operational tables alongside the domain ones:
// conversations/conversation_messages/turn_events (the chat's own transcripts),
// llm_errors/llm_usage (prompt text and spend), connector_config,
// extension_capture. None is ever a legitimate answer to a question about
// properties, and the chat could otherwise read its own history back to a user.
// The pre-port code excluded them incidentally via a `^ps_` prefix filter; this
// schema names tables plainly, so the restriction has to be explicit.
describe("SQL tool table allowlist", () => {
  it("describe_table refuses a table outside the allowlist", async () => {
    const out = await handleDescribeTable(
      JSON.stringify({ table: "conversation_messages" }),
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("INVALID_ARGS");
      expect(out.message).toContain("not available");
    }
  });

  it("describe_table refuses the llm_errors table (prompt text + spend)", async () => {
    const out = await handleDescribeTable(JSON.stringify({ table: "llm_errors" }), ctx);
    expect(out.ok).toBe(false);
  });

  it("execute_query refuses a SELECT against conversation_messages", async () => {
    const out = await handleExecuteQuery(
      JSON.stringify({ sql: "SELECT content FROM conversation_messages" }),
      ctx,
    );
    // toolOk with an error payload: the model sees a usable refusal, not a crash.
    expect(out.ok).toBe(true);
    if (out.ok) {
      const body = out.data as { error?: string; rows?: unknown[] };
      expect(body.error).toContain("not available");
      expect(body.rows).toEqual([]);
    }
  });

  it("execute_query refuses a non-visible table reached through a JOIN", async () => {
    const out = await handleExecuteQuery(
      JSON.stringify({
        sql: "SELECT p.id FROM property p JOIN conversations c ON c.id = p.id",
      }),
      ctx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const body = out.data as { error?: string };
      expect(body.error).toContain("conversations");
    }
  });

  it("validate_query reports a non-visible table as invalid rather than valid", async () => {
    const out = await handleValidateQuery(
      JSON.stringify({ sql: "SELECT * FROM turn_events" }),
      ctx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const body = out.data as { valid?: boolean; reason?: string };
      expect(body.valid).toBe(false);
      expect(body.reason).toContain("not available");
    }
  });

  it("explain_query refuses a non-visible table", async () => {
    const out = await handleExplainQuery(
      JSON.stringify({ sql: "SELECT * FROM connector_config" }),
      ctx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const body = out.data as { error?: string };
      expect(body.error).toContain("not available");
    }
  });

  it("allows the domain tables the assistant is meant to answer from", async () => {
    for (const table of ["property", "listing", "search_profile", "ai_assessment"]) {
      const out = await handleDescribeTable(JSON.stringify({ table }), ctx);
      // Either it describes the table, or it fails on the DB connection in a
      // unit-test environment — what it must NOT do is refuse on the allowlist.
      if (!out.ok) {
        expect(out.code).not.toBe("INVALID_ARGS");
      }
    }
  });
});
