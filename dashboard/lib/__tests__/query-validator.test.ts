import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateQueryCost,
  QueryTooExpensiveError,
  neutralizeNamedBindPlaceholdersForExplain,
} from "../query-validator";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const shared = vi.fn();
  return {
    ...actual,
    query: shared,
    queryReadOnlyWithStatementTimeout: shared,
  };
});

import { query, QueryTimeoutError } from "@/lib/db";
const mockQuery = vi.mocked(query);

function makePlan(
  totalCost: number,
  nodeType = "Hash Join",
  relationName?: string
): string {
  const node: Record<string, unknown> = {
    "Node Type": nodeType,
    "Total Cost": totalCost,
  };
  if (relationName) {
    node["Relation Name"] = relationName;
  }
  return JSON.stringify([{ Plan: node }]);
}

function makeParsedPlan(
  totalCost: number,
  nodeType = "Hash Join"
): [{ Plan: Record<string, unknown> }] {
  return [{ Plan: { "Node Type": nodeType, "Total Cost": totalCost } }];
}

function makeSeqScanPlan(totalCost: number, tableName: string): string {
  return JSON.stringify([
    {
      Plan: {
        "Node Type": "Nested Loop",
        "Total Cost": totalCost,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Total Cost": totalCost,
            "Relation Name": tableName,
          },
        ],
      },
    },
  ]);
}

describe("neutralizeNamedBindPlaceholdersForExplain", () => {
  it("replaces Oracle-style :bind with NULL but keeps :: casts", () => {
    const sql =
      "SELECT * FROM ps_ventas WHERE fecha >= :from_date AND x::date = CURRENT_DATE";
    const out = neutralizeNamedBindPlaceholdersForExplain(sql);
    expect(out).toContain("NULL");
    expect(out).toContain("::date");
    expect(out).not.toMatch(/:from_date\b/);
  });
});

describe("validateQueryCost", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.QUERY_COST_LIMIT;
    delete process.env.QUERY_COST_OVERRIDE_SECRET;
  });

  afterEach(() => {
    delete process.env.QUERY_COST_LIMIT;
    delete process.env.QUERY_COST_OVERRIDE_SECRET;
  });

  it("returns cost for a low-cost query", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(500)]],
    });
    const cost = await validateQueryCost("SELECT 1");
    expect(cost).toBe(500);
  });

  it("runs EXPLAIN via queryReadOnlyWithStatementTimeout when statementTimeoutMs is set", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(77)]],
    });
    const cost = await validateQueryCost("SELECT 1", { statementTimeoutMs: 5000 });
    expect(cost).toBe(77);
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][0]).toContain("EXPLAIN (FORMAT JSON) SELECT 1");
    expect(mockQuery.mock.calls[0][2]).toBe(5000);
  });

  it("returns 0 when EXPLAIN hits statement timeout (fail-open)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockQuery.mockRejectedValueOnce(new QueryTimeoutError("timed out"));
    const cost = await validateQueryCost("SELECT 1", { statementTimeoutMs: 100 });
    expect(cost).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("EXPLAIN timed out"),
      expect.any(QueryTimeoutError),
    );
    warnSpy.mockRestore();
  });

  it("forwards bind params to EXPLAIN query", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(12)]],
    });
    await validateQueryCost("SELECT * FROM ps_ventas WHERE id = $1", { params: [1] });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [text, values] = mockQuery.mock.calls[0] as [string, unknown[] | undefined];
    expect(text).toContain("EXPLAIN (FORMAT JSON)");
    expect(text).toContain("SELECT * FROM ps_ventas WHERE id = $1");
    expect(values).toEqual([1]);
  });

  it("neutralizes :named binds in EXPLAIN so PostgreSQL accepts the plan query", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(50)]],
    });
    await validateQueryCost(
      "SELECT 1 FROM ps_ventas WHERE reg_ventas > :min_id AND created::text IS NOT NULL",
    );
    const [text] = mockQuery.mock.calls[0] as [string];
    expect(text).toContain("NULL");
    expect(text).not.toContain(":min_id");
    expect(text).toContain("::text");
  });

  it("does not throw when QUERY_COST_LIMIT is unset even for very high planner cost", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(9_000_000)]],
    });
    const cost = await validateQueryCost("SELECT * FROM ps_stock_tienda");
    expect(cost).toBe(9_000_000);
  });

  it("QueryTooExpensiveError has cost, limit properties and fixed Spanish message when limit is enforced", async () => {
    process.env.QUERY_COST_LIMIT = "100000";
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(150000)]],
    });
    try {
      await validateQueryCost("SELECT * FROM ps_ventas");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryTooExpensiveError);
      const e = err as QueryTooExpensiveError;
      expect(e.cost).toBe(150000);
      expect(e.limit).toBe(100000);
      expect(e.message).toBe(
        "Esta consulta es demasiado costosa. Intente añadir un filtro de fechas o tienda."
      );
    }
  });

  it("respects QUERY_COST_LIMIT env var override", async () => {
    process.env.QUERY_COST_LIMIT = "50000";
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(60000)]],
    });
    await expect(validateQueryCost("SELECT * FROM ps_ventas")).rejects.toThrow(
      QueryTooExpensiveError
    );
  });

  it("does not throw when cost is exactly at the limit", async () => {
    process.env.QUERY_COST_LIMIT = "50000";
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(50000)]],
    });
    const cost = await validateQueryCost("SELECT 1");
    expect(cost).toBe(50000);
  });

  it("disables cost guard and warns when QUERY_COST_LIMIT is non-numeric", async () => {
    process.env.QUERY_COST_LIMIT = "notanumber";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(50000)]],
    });
    const cost = await validateQueryCost("SELECT 1");
    expect(cost).toBe(50000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid QUERY_COST_LIMIT")
    );
    warnSpy.mockRestore();
  });

  it("disables cost guard for partially numeric strings (no silent parseInt truncation)", async () => {
    process.env.QUERY_COST_LIMIT = "100000foo";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(500_000)]],
    });
    const cost = await validateQueryCost("SELECT 1");
    expect(cost).toBe(500_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid QUERY_COST_LIMIT")
    );
    warnSpy.mockRestore();
  });

  it("disables cost guard and warns when QUERY_COST_LIMIT is zero", async () => {
    process.env.QUERY_COST_LIMIT = "0";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(150000)]],
    });
    const cost = await validateQueryCost("SELECT * FROM ps_ventas");
    expect(cost).toBe(150000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid or zero QUERY_COST_LIMIT")
    );
    warnSpy.mockRestore();
  });

  it("bypasses check when force header matches secret", async () => {
    process.env.QUERY_COST_OVERRIDE_SECRET = "supersecret";
    const cost = await validateQueryCost("SELECT * FROM ps_stock_tienda", {
      forceHeader: "supersecret",
    });
    expect(cost).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("does not bypass when force header is wrong secret", async () => {
    process.env.QUERY_COST_OVERRIDE_SECRET = "supersecret";
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(500)]],
    });
    const cost = await validateQueryCost("SELECT 1", { forceHeader: "wrong" });
    expect(cost).toBe(500);
  });

  it("does not bypass when QUERY_COST_OVERRIDE_SECRET is unset", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(500)]],
    });
    const cost = await validateQueryCost("SELECT 1", {
      forceHeader: "anyvalue",
    });
    expect(cost).toBe(500);
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("does not bypass when QUERY_COST_OVERRIDE_SECRET is empty string", async () => {
    process.env.QUERY_COST_OVERRIDE_SECRET = "";
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(500)]],
    });
    const cost = await validateQueryCost("SELECT 1", {
      forceHeader: "",
    });
    expect(cost).toBe(500);
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("warns on seq scan on large table but does not throw", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makeSeqScanPlan(5000, "ps_stock_tienda")]],
    });
    const cost = await validateQueryCost("SELECT * FROM ps_stock_tienda");
    expect(cost).toBe(5000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ps_stock_tienda")
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Seq scan"));
    warnSpy.mockRestore();
  });

  it("does not warn for seq scan on small (non-listed) table", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makePlan(1000, "Seq Scan", "ps_small_table")]],
    });
    await validateQueryCost("SELECT * FROM ps_small_table");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns 0 and does not throw when EXPLAIN query fails (fail-open)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockQuery.mockRejectedValueOnce(new Error("DB connection error"));
    const cost = await validateQueryCost("SELECT 1");
    expect(cost).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("EXPLAIN or plan parsing failed"),
      expect.any(Error)
    );
    warnSpy.mockRestore();
  });

  it("returns 0 and does not throw when EXPLAIN returns malformed JSON", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [["not valid json {{{"]],
    });
    const cost = await validateQueryCost("SELECT 1");
    expect(cost).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("handles pre-parsed plan object from node-postgres (rows[0][0] is already an array)", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makeParsedPlan(500)]],
    });
    const cost = await validateQueryCost("SELECT 1");
    expect(cost).toBe(500);
  });

  it("throws QueryTooExpensiveError with pre-parsed plan when cost exceeds enforced limit", async () => {
    process.env.QUERY_COST_LIMIT = "100000";
    mockQuery.mockResolvedValueOnce({
      columns: ["QUERY PLAN"],
      rows: [[makeParsedPlan(200000)]],
    });
    await expect(validateQueryCost("SELECT * FROM ps_stock_tienda")).rejects.toThrow(
      QueryTooExpensiveError
    );
  });

  it("returns 0 and warns when sql starts with ANALYZE (injection guard)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cost = await validateQueryCost("ANALYZE SELECT * FROM ps_ventas");
    expect(cost).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("does not start with SELECT or WITH")
    );
    warnSpy.mockRestore();
  });

  it("returns 0 and warns when sql starts with an arbitrary non-SELECT statement", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cost = await validateQueryCost("UPDATE ps_ventas SET x=1");
    expect(cost).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("does not start with SELECT or WITH")
    );
    warnSpy.mockRestore();
  });
});
