import { describe, it, expect } from "vitest";
import {
  handleExecuteQuery,
  handleValidateQuery,
  handleExplainQuery,
  handleDescribePsTable,
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

  it("describe_ps_table returns INVALID_ARGS for malformed JSON", async () => {
    const out = await handleDescribePsTable("not-json", ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("INVALID_ARGS");
    }
  });

  it("describe_ps_table rejects non-ps_* table names via the schema regex", async () => {
    const out = await handleDescribePsTable(
      JSON.stringify({ table: "users" }),
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("INVALID_ARGS");
    }
  });
});
