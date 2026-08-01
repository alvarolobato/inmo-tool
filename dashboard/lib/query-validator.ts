import { timingSafeEqual } from "node:crypto";
import {
  query,
  queryReadOnlyWithStatementTimeout,
  QueryTimeoutError,
} from "@/lib/db";

const LARGE_TABLES = new Set([
  "ps_stock_tienda",
  "ps_lineas_ventas",
  "ps_ventas",
  "ps_gc_lin_albarane",
]);

export class QueryTooExpensiveError extends Error {
  cost: number;
  limit?: number;

  constructor(cost: number, limit?: number) {
    super(
      "Esta consulta es demasiado costosa. Intente añadir un filtro de fechas o tienda."
    );
    this.name = "QueryTooExpensiveError";
    this.cost = cost;
    this.limit = limit;
  }
}

interface PlanNode {
  "Node Type": string;
  "Total Cost"?: number;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

function extractSeqScansOnLargeTables(
  node: PlanNode,
  found: string[] = []
): string[] {
  if (
    node["Node Type"] === "Seq Scan" &&
    node["Relation Name"] &&
    LARGE_TABLES.has(node["Relation Name"])
  ) {
    found.push(node["Relation Name"]);
  }
  if (node.Plans) {
    for (const child of node.Plans) {
      extractSeqScansOnLargeTables(child, found);
    }
  }
  return found;
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Replace Oracle-style `:name` bind markers (invalid in PostgreSQL) with NULL so
 * EXPLAIN can parse. Does not touch casts (`::type`).
 */
export function neutralizeNamedBindPlaceholdersForExplain(sql: string): string {
  return sql.replace(/(?<!:):(?!:)([a-zA-Z_][\w]*)\b/g, "NULL");
}

export async function validateQueryCost(
  sql: string,
  options?: {
    forceHeader?: string;
    statementTimeoutMs?: number;
    params?: unknown[];
  },
): Promise<number> {
  const secret = process.env.QUERY_COST_OVERRIDE_SECRET;
  if (secret && options?.forceHeader && safeEquals(options.forceHeader, secret)) {
    return 0;
  }

  // Guard against ANALYZE injection: "EXPLAIN (FORMAT JSON) ANALYZE SELECT ..." executes the query.
  // validateReadOnly() only checks the combined EXPLAIN+sql string, so we must validate sql itself.
  if (!/^(SELECT|WITH)\b/i.test(sql.trimStart())) {
    console.warn(
      "[query-validator] SQL does not start with SELECT or WITH, skipping cost check"
    );
    return 0;
  }

  try {
    const explainSql = `EXPLAIN (FORMAT JSON) ${neutralizeNamedBindPlaceholdersForExplain(sql)}`; // safe: sql validated to start with SELECT/WITH above; validateReadOnly() also rejects semicolons and write keywords
    const params = options?.params ?? [];
    const result =
      options?.statementTimeoutMs !== undefined
        ? await queryReadOnlyWithStatementTimeout(
            explainSql,
            params,
            options.statementTimeoutMs,
          )
        : await query(explainSql, params);
    const raw = result.rows[0][0] as unknown;
    // node-postgres returns json columns as parsed JS values; handle both string (test mocks) and object
    const plan = (typeof raw === "string"
      ? JSON.parse(raw)
      : raw) as [{ Plan: PlanNode }];
    const rootPlan = plan[0].Plan;
    const cost = rootPlan["Total Cost"] ?? 0;

    // Cost rejection is opt-in: set QUERY_COST_LIMIT to a positive integer to
    // block queries whose planner total cost exceeds that threshold. When unset
    // (or invalid / zero), we still run EXPLAIN for seq-scan warnings below but
    // never reject on cost — large default dashboards must not fail here.
    const rawLimit = process.env.QUERY_COST_LIMIT?.trim();
    let enforcedLimit: number | undefined;
    if (rawLimit !== undefined && rawLimit !== "") {
      // Strict parse: reject partial numbers like "100000foo" (parseInt would not).
      if (!/^\d+$/.test(rawLimit)) {
        console.warn(
          `[query-validator] Invalid QUERY_COST_LIMIT="${rawLimit}" — cost guard disabled`
        );
      } else {
        const parsed = parseInt(rawLimit, 10);
        if (parsed > 0) {
          enforcedLimit = parsed;
        } else {
          console.warn(
            `[query-validator] Invalid or zero QUERY_COST_LIMIT="${rawLimit}" — cost guard disabled`
          );
        }
      }
    }

    if (enforcedLimit !== undefined && cost > enforcedLimit) {
      throw new QueryTooExpensiveError(cost, enforcedLimit);
    }

    const seqScans = extractSeqScansOnLargeTables(rootPlan);
    for (const tableName of seqScans) {
      console.warn(
        `[query-validator] Seq scan on large table: ${tableName}, cost=${cost}`
      );
    }

    return cost;
  } catch (err) {
    if (err instanceof QueryTooExpensiveError) {
      throw err;
    }
    if (err instanceof QueryTimeoutError) {
      console.warn(
        "[query-validator] EXPLAIN timed out (statement_timeout), skipping cost check:",
        err
      );
      return 0;
    }
    console.warn(
      "[query-validator] EXPLAIN or plan parsing failed, skipping cost check:",
      err
    );
    return 0;
  }
}
