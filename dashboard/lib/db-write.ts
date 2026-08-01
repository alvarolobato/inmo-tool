/**
 * PostgreSQL write-capable pool for dashboard persistence.
 *
 * Unlike db.ts (read-only for analytics queries), this module provides
 * parameterized query execution for the dashboard CRUD operations
 * (dashboards, dashboard_versions tables).
 */

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { buildPgPoolConfig } from "./db-shared";

// ─── llm_interactions types ─────────────────────────────────────────────────

/**
 * A structured progress line stored in `llm_interactions.lines`.
 * Uses `kind` so callers can format them by type in the UI.
 */
export interface InteractionLine {
  /** Logical line type for UI formatting. */
  kind: "meta" | "tool_call" | "tool_result" | "assistant_text" | "error" | "phase";
  /** Human-readable text (Spanish). */
  text: string;
  /** ISO timestamp when the line was emitted. */
  ts: string;
}

export type InteractionEndpoint = "generate" | "modify" | "analyze";

// ─── OTel trace context ──────────────────────────────────────────────────────

/** W3C trace-context IDs written to PG rows for click-through to Kibana APM. */
export interface TraceContext {
  traceId: string | null;
  spanId: string | null;
}

// ─── Pool configuration ─────────────────────────────────────────────────────

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool(buildPgPoolConfig({ max: 5 }));
  }
  return _pool;
}

// ─── Transaction helper ──────────────────────────────────────────────────────

/**
 * Run `fn` inside a BEGIN/COMMIT transaction on the write pool.
 * Rolls back and rethrows on any error; always releases the client.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reset the pool. Useful for testing.
 */
export async function resetPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// ─── Dashboard spec persistence (single writer, versioned) ──────────────────

/** Row shape returned by updateDashboardSpecWithVersion (matches the PUT route response). */
export interface UpdatedDashboardRow {
  id: number;
  name: string;
  description: string | null;
  spec: unknown;
  created_at: string;
  updated_at: string;
}

/**
 * Persist a new dashboard spec with version history, atomically:
 *   1. Lock the dashboards row (SELECT ... FOR UPDATE).
 *   2. Snapshot the PREVIOUS spec into dashboard_versions (with the prompt
 *      that caused the change, when available) — unless opts.skipVersion.
 *   3. Write the new spec (and optionally the name) and bump updated_at.
 *
 * This is the ONLY way a dashboard spec may be updated — both the PUT
 * /api/dashboard/:id route and the conversation-turn modify path go through
 * here so version history and updated_at stay consistent regardless of which
 * surface made the change.
 *
 * Returns the updated row, or null when the dashboard does not exist
 * (no write performed).
 *
 * `opts.name`: optional new display name. `null`, `undefined`, empty or
 * whitespace-only strings all mean "keep the current name" — same contract
 * the PUT /api/dashboard/:id route has always had (its callers pass null for
 * spec-only saves). The name column is never cleared through this helper.
 */
export async function updateDashboardSpecWithVersion(
  dashboardId: number,
  spec: unknown,
  prompt: string | null,
  opts?: { name?: string | null; skipVersion?: boolean },
): Promise<UpdatedDashboardRow | null> {
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT spec FROM dashboards WHERE id = $1 FOR UPDATE`,
      [dashboardId],
    );
    if (existing.rows.length === 0) return null;

    if (!opts?.skipVersion) {
      await client.query(
        `INSERT INTO dashboard_versions (dashboard_id, spec, prompt)
         VALUES ($1, $2, $3)`,
        [dashboardId, JSON.stringify(existing.rows[0].spec), prompt],
      );
    }

    const setClauses = ["spec = $1", "updated_at = NOW()"];
    const params: unknown[] = [JSON.stringify(spec), dashboardId];
    // Explicit normalisation of the keep-current-name contract documented above.
    const trimmedName = typeof opts?.name === "string" ? opts.name.trim() : "";
    if (trimmedName !== "") {
      setClauses.push(`name = $3`);
      params.push(trimmedName);
    }
    const res = await client.query<UpdatedDashboardRow>(
      `UPDATE dashboards
       SET ${setClauses.join(", ")}
       WHERE id = $2
       RETURNING id, name, description, spec, created_at, updated_at`,
      params,
    );
    return res.rows[0] ?? null;
  });
}

/**
 * Execute a parameterized SQL query.
 */
export async function sql<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const pool = getPool();
  const result = await pool.query<T>(text, params);
  return result.rows;
}

// ─── llm_interactions helpers ────────────────────────────────────────────────

/**
 * Insert a new `llm_interactions` row with status='running' and return its UUID.
 *
 * Fire-and-forget safe: callers should not await this in the hot path if they
 * want to avoid blocking the stream; however the returned promise can be awaited
 * to get the row id for subsequent updates.
 */
export async function createInteraction(opts: {
  requestId: string;
  endpoint: InteractionEndpoint;
  dashboardId?: number | null;
  prompt: string;
  llmProvider?: string | null;
  llmDriver?: string | null;
}): Promise<string> {
  const rows = await sql<{ id: string }>(
    `INSERT INTO llm_interactions
       (request_id, endpoint, dashboard_id, prompt, llm_provider, llm_driver, started_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'running')
     RETURNING id`,
    [
      opts.requestId,
      opts.endpoint,
      opts.dashboardId ?? null,
      opts.prompt,
      opts.llmProvider ?? null,
      opts.llmDriver ?? null,
    ],
  );
  if (!rows[0]) throw new Error("createInteraction: no row returned");
  return rows[0].id;
}

/**
 * Append a batch of lines to `llm_interactions.lines` (JSONB concatenation).
 * Throws on DB errors — callers should wrap in try/catch if they want
 * best-effort behavior (the generate route does this already).
 */
export async function appendInteractionLines(
  id: string,
  lines: InteractionLine[],
): Promise<void> {
  if (lines.length === 0) return;
  await sql(
    `UPDATE llm_interactions
        SET lines = lines || $2::jsonb
      WHERE id = $1`,
    [id, JSON.stringify(lines)],
  );
}

/**
 * Mark an interaction as completed or error.
 *
 * Throws on DB errors — callers should `.catch()` and log if they want
 * best-effort behavior (success-path callers should `await` this before
 * returning the HTTP response so status never stays 'running').
 */
export async function finishInteraction(
  id: string,
  status: "completed" | "error",
  finalOutput?: string | null,
): Promise<void> {
  await sql(
    `UPDATE llm_interactions
        SET status = $2,
            finished_at = NOW(),
            final_output = $3
      WHERE id = $1`,
    [id, status, finalOutput ?? null],
  );
}
