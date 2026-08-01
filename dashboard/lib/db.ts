/**
 * PostgreSQL connection pool and query execution.
 *
 * Provides a read-only query interface against the PostgreSQL mirror.
 * All write operations (INSERT, UPDATE, DELETE, etc.) are rejected
 * before reaching the database — see AGENTS.md read-only policy.
 */

import { Pool } from "pg";
import { buildPgPoolConfig } from "./db-shared";

// ─── SQL Safety ─────────────────────────────────────────────────────────────

/**
 * Allowed SQL statement prefixes (allowlist approach).
 * Only SELECT, WITH (CTEs), and EXPLAIN are permitted.
 */
const ALLOWED_PREFIXES = /^\s*(SELECT|WITH|EXPLAIN)\b/i;

/**
 * Write keywords that must not appear in CTEs or after EXPLAIN ANALYZE.
 * Checked with word boundaries to catch data-modifying CTEs and
 * EXPLAIN ANALYZE <write statement>.
 */
const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|MERGE)\b/i;

/**
 * SELECT ... INTO creates a new table — must be rejected.
 * Matches SELECT ... INTO <word> pattern.
 */
const SELECT_INTO = /\bSELECT\b[\s\S]*?\bINTO\s+\w/i;

/**
 * Strip string literals, quoted identifiers, and comments from SQL
 * so that keyword scanning only examines real SQL tokens.
 *
 * Replaces:
 * - Single-quoted strings: 'DELETE' → ''
 * - Dollar-quoted strings: $$DELETE$$ → ''
 * - Double-quoted identifiers: "update" → ""
 * - Block comments: /* UPDATE *​/ → ' '
 * - Line comments: -- DROP TABLE → ''
 */
export function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/'(?:[^']|'')*'/g, "''") // single-quoted strings
    .replace(/\$\$[\s\S]*?\$\$/g, "''") // dollar-quoted strings
    .replace(/"(?:[^"]|"")*"/g, '""'); // double-quoted identifiers
}

/**
 * Validate that a SQL string is read-only.
 *
 * Applies multiple layers of validation:
 * 1. Must start with SELECT, WITH, or EXPLAIN (allowlist)
 * 2. Must not contain semicolons (prevents multi-statement injection)
 * 3. Must not contain write keywords in SQL tokens (strips literals/comments
 *    first to avoid false positives from strings like 'DELETE')
 * 4. Must not use SELECT ... INTO (creates new tables)
 *
 * The database role should also enforce read-only access as defense in depth.
 *
 * @throws SqlValidationError if the SQL is not a read-only statement
 */
export function validateReadOnly(sql: string): void {
  if (!sql || !sql.trim()) {
    throw new SqlValidationError("SQL query is empty");
  }

  const trimmed = sql.trim();

  // 1. Must start with an allowed keyword
  if (!ALLOWED_PREFIXES.test(trimmed)) {
    throw new SqlValidationError(
      "Only SELECT, WITH, and EXPLAIN statements are allowed. " +
        "Write operations are rejected per read-only policy."
    );
  }

  // 2. Reject multi-statement SQL (semicolons)
  if (trimmed.includes(";")) {
    throw new SqlValidationError(
      "Multi-statement SQL is not allowed. Remove semicolons."
    );
  }

  // Strip literals, quoted identifiers, and comments before keyword scanning
  const cleaned = stripLiteralsAndComments(trimmed);

  // 3. Reject write keywords in actual SQL tokens (not inside strings/comments)
  if (WRITE_KEYWORDS.test(cleaned)) {
    throw new SqlValidationError(
      "SQL contains a write keyword (INSERT, UPDATE, DELETE, DROP, ALTER, " +
        "TRUNCATE, CREATE, MERGE). Only pure read operations are allowed."
    );
  }

  // 4. Reject SELECT ... INTO (creates tables)
  if (SELECT_INTO.test(cleaned)) {
    throw new SqlValidationError(
      "SELECT INTO is not allowed — it creates a new table."
    );
  }
}

// ─── Error classes ──────────────────────────────────────────────────────────

export class SqlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlValidationError";
  }
}

export class QueryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryTimeoutError";
  }
}

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

// ─── Pool configuration ─────────────────────────────────────────────────────

const QUERY_TIMEOUT_MS = 30_000;

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool(buildPgPoolConfig({ max: 10 }));
  }
  return _pool;
}

/**
 * Reset the pool. Useful for testing or configuration changes.
 */
export async function resetPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

/**
 * Execute a read-only SQL query against the PostgreSQL mirror.
 *
 * @param sql - The SQL query to execute (must be SELECT, WITH, or EXPLAIN)
 * @param params - Optional parameterized values for $1, $2, … placeholders
 * @returns Column names and row data as arrays
 * @throws SqlValidationError if the query is not read-only
 * @throws QueryTimeoutError if the query exceeds 30 seconds
 * @throws ConnectionError if the database is unreachable
 */
export async function query(
  sql: string,
  params?: unknown[],
): Promise<QueryResult> {
  validateReadOnly(sql);

  const pool = getPool();

  try {
    const result = await pool.query({
      text: sql,
      values: params,
      rowMode: "array",
    });

    const columns = result.fields.map((f) => f.name);
    const rows = result.rows as unknown[][];

    return { columns, rows };
  } catch (err: unknown) {
    const pgErr = err as { code?: string; message?: string };

    // Statement timeout
    if (pgErr.code === "57014") {
      throw new QueryTimeoutError(
        `Query timed out after ${QUERY_TIMEOUT_MS / 1000} seconds`
      );
    }

    // Connection errors
    if (
      pgErr.code === "ECONNREFUSED" ||
      pgErr.code === "ENOTFOUND" ||
      pgErr.code === "ETIMEDOUT" ||
      pgErr.code === "57P01" // admin_shutdown
    ) {
      throw new ConnectionError(
        `Database connection failed: ${pgErr.message || "unknown error"}`
      );
    }

    throw err;
  }
}

/**
 * Run a read-only query inside a short transaction with `SET LOCAL statement_timeout`
 * so PostgreSQL cancels long-running work even if the caller only has a JS timeout.
 *
 * @param statementTimeoutMs - Upper bound in milliseconds (clamped to 1..300_000).
 */
export async function queryReadOnlyWithStatementTimeout(
  sql: string,
  params: unknown[] | undefined,
  statementTimeoutMs: number,
): Promise<QueryResult> {
  validateReadOnly(sql);

  const pool = getPool();
  const ms = Math.max(1, Math.min(Math.floor(statementTimeoutMs), 300_000));
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${ms}`);
    const result = await client.query({
      text: sql,
      values: params,
      rowMode: "array",
    });
    await client.query("COMMIT");

    const columns = result.fields.map((f) => f.name);
    const rows = result.rows as unknown[][];
    return { columns, rows };
  } catch (err: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors (e.g. connection already closed)
    }
    const pgErr = err as { code?: string; message?: string };
    if (pgErr.code === "57014") {
      throw new QueryTimeoutError(
        `Query timed out after ${Math.round(ms / 1000)} seconds (statement_timeout)`
      );
    }
    if (
      pgErr.code === "ECONNREFUSED" ||
      pgErr.code === "ENOTFOUND" ||
      pgErr.code === "ETIMEDOUT" ||
      pgErr.code === "57P01"
    ) {
      throw new ConnectionError(
        `Database connection failed: ${pgErr.message || "unknown error"}`
      );
    }
    throw err;
  } finally {
    client.release();
  }
}
