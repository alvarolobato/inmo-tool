/**
 * PostgreSQL write-capable pool for dashboard persistence.
 *
 * Unlike db.ts (read-only for analytics queries), this module provides
 * parameterized query execution for the dashboard CRUD operations
 * (dashboards, dashboard_versions tables).
 */

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { buildPgPoolConfig } from "./db-shared";

// ─── Progress-line shape ─────────────────────────────────────────────────────

/**
 * A structured progress line, in the shape `llm_interactions.lines` used to
 * store before that table (and its write/read helpers, and the admin viewer
 * at `/admin/interactions`) were deleted in #653 — `llm_interactions` had 0
 * rows ever in production, and nothing wrote to it. This type survives
 * because `DashboardGenerateProgressDialog` still formats its own in-memory
 * progress lines by `kind`, independent of that table.
 */
export interface InteractionLine {
  /** Logical line type for UI formatting. */
  kind: "meta" | "tool_call" | "tool_result" | "assistant_text" | "error" | "phase";
  /** Human-readable text (Spanish). */
  text: string;
  /** ISO timestamp when the line was emitted. */
  ts: string;
}

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
    // #666/D-149: an EARLIER version of this comment raised `max` here to 12
    // reasoning that `cache.ts`'s advisory-lock-holding connection (the #30
    // stampede guard, held for the ENTIRE duration of an assessment call
    // including the LLM round trip) needed headroom on THIS pool. That was
    // wrong in a way a live-Postgres review reproduction caught: sharing one
    // pool between lock-holding and ordinary short queries meant up to 8
    // concurrent assessment workers could starve every OTHER db-write
    // consumer (dashboard CRUD, materialize, dedup, scoring, every API
    // route) for as long as the slowest in-flight LLM call took — up to and
    // including the assessment workers' OWN nested queries losing to their
    // own held connections. The fix: `cache.ts`'s `getLockPool()` is now a
    // SEPARATE, dedicated pool for advisory-lock-holding connections only —
    // this pool never holds a connection across an LLM call. `max: 10` here
    // is headroom for the (now purely transient/short) nested queries up to
    // `dashboard.assessment_concurrency` workers can issue near-simultaneously
    // (`getLatestAssessment`/failure-ledger reads/`save()`), plus this pool's
    // many other ordinary callers — not for anything held long-term.
    _pool = new Pool(buildPgPoolConfig({ max: 10 }));
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
