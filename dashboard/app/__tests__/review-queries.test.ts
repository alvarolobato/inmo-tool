import { describe, it, expect, vi } from "vitest";
import {
  REVIEW_QUERIES,
  executeReviewQueries,
  formatQueryResultAsText,
  formatAllResults,
  type ReviewQuery,
} from "@/lib/review-queries";
import { validateReadOnly } from "@/lib/db";

// ─── REVIEW_QUERIES structure ─────────────────────────────────────────────────

describe("REVIEW_QUERIES", () => {
  it("has at least 14 queries", () => {
    expect(REVIEW_QUERIES.length).toBeGreaterThanOrEqual(14);
  });

  it("every query has name, sql, and domain fields", () => {
    for (const q of REVIEW_QUERIES) {
      expect(typeof q.name).toBe("string");
      expect(q.name.length).toBeGreaterThan(0);
      expect(typeof q.sql).toBe("string");
      expect(q.sql.length).toBeGreaterThan(0);
      expect(["ventas_retail", "canal_mayorista", "stock", "compras"]).toContain(q.domain);
    }
  });

  it("every SQL query passes validateReadOnly()", () => {
    for (const q of REVIEW_QUERIES) {
      expect(() => validateReadOnly(q.sql), `Query ${q.name} failed validateReadOnly`).not.toThrow();
    }
  });

  it("covers all 4 domains", () => {
    const domains = new Set(REVIEW_QUERIES.map((q) => q.domain));
    expect(domains.has("ventas_retail")).toBe(true);
    expect(domains.has("canal_mayorista")).toBe(true);
    expect(domains.has("stock")).toBe(true);
    expect(domains.has("compras")).toBe(true);
  });

  it("has 6 ventas_retail queries", () => {
    const count = REVIEW_QUERIES.filter((q) => q.domain === "ventas_retail").length;
    expect(count).toBe(6);
  });

  it("has 3 canal_mayorista queries", () => {
    const count = REVIEW_QUERIES.filter((q) => q.domain === "canal_mayorista").length;
    expect(count).toBe(3);
  });

  it("has 3 stock queries", () => {
    const count = REVIEW_QUERIES.filter((q) => q.domain === "stock").length;
    expect(count).toBe(3);
  });

  it("has 4 compras queries", () => {
    const count = REVIEW_QUERIES.filter((q) => q.domain === "compras").length;
    expect(count).toBe(4);
  });
});

// ─── executeReviewQueries ─────────────────────────────────────────────────────

const SAMPLE_WEEK_START = "2026-04-06";
const SAMPLE_WEEK_END_EXCL = "2026-04-13";

describe("executeReviewQueries", () => {
  it("returns results for all queries when all succeed", async () => {
    const mockQueryFn = vi.fn().mockResolvedValue({
      columns: ["col1", "col2"],
      rows: [[1, "test"]],
    });

    const results = await executeReviewQueries(
      mockQueryFn,
      SAMPLE_WEEK_START,
      SAMPLE_WEEK_END_EXCL,
    );

    expect(results).toHaveLength(REVIEW_QUERIES.length);
    expect(mockQueryFn).toHaveBeenCalledTimes(REVIEW_QUERIES.length);

    for (const r of results) {
      expect(r.query).toBeDefined();
      expect(r.result).toBeDefined();
      expect(r.error).toBeUndefined();
    }
  });

  it("captures error for failing queries but continues with others", async () => {
    let callCount = 0;
    const mockQueryFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        return Promise.reject(new Error("Query timeout"));
      }
      return Promise.resolve({ columns: ["value"], rows: [[42]] });
    });

    const results = await executeReviewQueries(
      mockQueryFn,
      SAMPLE_WEEK_START,
      SAMPLE_WEEK_END_EXCL,
    );

    // All queries attempted
    expect(results).toHaveLength(REVIEW_QUERIES.length);
    expect(mockQueryFn).toHaveBeenCalledTimes(REVIEW_QUERIES.length);

    // Second query has an error
    expect(results[1].error).toBe("Query timeout");
    expect(results[1].result).toBeUndefined();

    // Other queries succeeded
    const successCount = results.filter((r) => r.result !== undefined).length;
    expect(successCount).toBe(REVIEW_QUERIES.length - 1);
  });

  it("returns correct query metadata for each result", async () => {
    const mockQueryFn = vi.fn().mockResolvedValue({ columns: [], rows: [] });
    const results = await executeReviewQueries(
      mockQueryFn,
      SAMPLE_WEEK_START,
      SAMPLE_WEEK_END_EXCL,
    );

    // Each result references the correct query
    for (let i = 0; i < REVIEW_QUERIES.length; i++) {
      expect(results[i].query.name).toBe(REVIEW_QUERIES[i].name);
      expect(results[i].query.domain).toBe(REVIEW_QUERIES[i].domain);
    }
  });

  it("calls the query function with the SQL of each query and exactly the placeholders it uses", async () => {
    const mockQueryFn = vi.fn().mockResolvedValue({ columns: [], rows: [] });
    await executeReviewQueries(mockQueryFn, SAMPLE_WEEK_START, SAMPLE_WEEK_END_EXCL);

    // PostgreSQL rejects extra parameters: a query referencing only $1 must
    // not be called with [start, end]. The runner slices weekParams to the
    // highest $N actually present in the SQL (and passes undefined for $0).
    for (const q of REVIEW_QUERIES) {
      const usesEnd = /\$2\b/.test(q.sql);
      const usesStart = /\$1\b/.test(q.sql);
      const expectedParams = usesEnd
        ? [SAMPLE_WEEK_START, SAMPLE_WEEK_END_EXCL]
        : usesStart
          ? [SAMPLE_WEEK_START]
          : undefined;
      expect(mockQueryFn).toHaveBeenCalledWith(q.sql, expectedParams);
    }
  });
});

// ─── formatQueryResultAsText ──────────────────────────────────────────────────

describe("formatQueryResultAsText", () => {
  it("produces a readable text table with name header", () => {
    const result = formatQueryResultAsText(
      "ventas_semana_cerrada",
      ["ventas_netas", "num_tickets"],
      [[12345.67, 100]]
    );
    expect(result).toContain("ventas_semana_cerrada");
    expect(result).toContain("ventas_netas");
    expect(result).toContain("num_tickets");
  });

  it("returns '(sin datos)' when rows are empty", () => {
    const result = formatQueryResultAsText("test_query", ["col1"], []);
    expect(result).toContain("(sin datos)");
  });

  it("formats null values as em dash", () => {
    const result = formatQueryResultAsText("test", ["col"], [[null]]);
    expect(result).toContain("—");
  });
});

// ─── formatAllResults ─────────────────────────────────────────────────────────

describe("formatAllResults", () => {
  it("includes results for all queries", () => {
    const mockResults = REVIEW_QUERIES.slice(0, 3).map((q: ReviewQuery) => ({
      query: q,
      result: { columns: ["value"], rows: [[100]] },
    }));

    const text = formatAllResults(mockResults);
    for (const r of mockResults) {
      expect(text).toContain(r.query.name);
    }
  });

  it("indicates errors for failed queries (sanitized message)", () => {
    const errorResult = {
      query: REVIEW_QUERIES[0],
      error: "Connection refused",
    };

    const text = formatAllResults([errorResult]);
    // Error is sanitized — raw error message is not leaked to LLM context
    expect(text).toContain("error:");
    // The sanitized message for connection errors
    expect(text).toContain("fallo de conexión a la base de datos");
  });
});
