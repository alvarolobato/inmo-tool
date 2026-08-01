/**
 * Turn-events data layer — CRUD for conversation_turns and turn_events.
 */

import { sql, withTransaction } from "@/lib/db-write";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TurnRow {
  id: string;
  conversation_id: string;
  turn_index: number;
  user_message: string;
  status: "pending" | "streaming" | "complete" | "error";
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  /** Relative path to this turn's context-log file (conversation-context-store), or null. */
  context_file: string | null;
  created_at: string;
}

export interface TurnEventRow {
  id: number;
  turn_id: string;
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface TurnWithEvents {
  turn: TurnRow;
  events: TurnEventRow[];
}

// ── Queries ────────────────────────────────────────────────────────────────────

/**
 * Cutoff after which an in-flight turn is considered abandoned (e.g. the
 * container restarted mid-turn and the status row was never finalised).
 * createTurnIfIdle ignores older turns so a crashed turn can never permanently
 * block a conversation from accepting new ones.
 *
 * Set well above the worst-case legitimate turn so a long agentic run is never
 * misclassified as stale (issue #846 review): the agentic limits allow up to
 * maxToolCalls=24 × toolTimeoutMs=15s = 6 min of tool time plus several rounds
 * of model latency, so ~10 min is plausible. 30 min leaves comfortable margin
 * while still recovering a truly crashed turn within the same session.
 */
const ACTIVE_TURN_STALE_MINUTES = 30;

/**
 * Result of createTurnIfIdle: the created turn, or null when another turn is
 * already in flight for the conversation.
 */
export type CreateTurnResult =
  | { ok: true; turnId: string; turnIndex: number }
  | { ok: false; reason: "active_turn" };

/**
 * Atomically reject-or-create a turn (issue #823, hardened against the TOCTOU
 * race the review flagged).
 *
 * A naive `hasActiveTurn()` check followed by a separate `createTurn()` lets
 * two concurrent requests both pass the check before either inserts, so both
 * proceed — exactly the interleaving the guard is meant to prevent. Here the
 * check AND the insert run inside one transaction holding a per-conversation
 * advisory lock (`pg_advisory_xact_lock`, auto-released on commit/rollback),
 * so concurrent requests for the same conversation serialise: the second sees
 * the first's pending row and is rejected.
 *
 * The lock also makes the MAX(turn_index)+1 allocation race-free for same-
 * conversation inserts (no unique-violation retry needed); the unique
 * constraint remains as a backstop.
 */
export async function createTurnIfIdle(
  conversationId: string,
  userMessage: string,
): Promise<CreateTurnResult> {
  return withTransaction(async (client) => {
    // Serialise all turn creation for this conversation. hashtext → int4,
    // implicitly widened to the bigint key pg_advisory_xact_lock expects.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [conversationId]);

    const active = await client.query(
      `SELECT 1 FROM conversation_turns
        WHERE conversation_id = $1
          AND status IN ('pending', 'streaming')
          AND created_at > NOW() - ($2 || ' minutes')::interval
        LIMIT 1`,
      [conversationId, String(ACTIVE_TURN_STALE_MINUTES)],
    );
    if ((active.rowCount ?? 0) > 0) {
      return { ok: false, reason: "active_turn" } as const;
    }

    const inserted = await client.query<{ id: string; turn_index: number }>(
      `INSERT INTO conversation_turns (conversation_id, turn_index, user_message, status)
       VALUES (
         $1,
         (SELECT COALESCE(MAX(turn_index) + 1, 0)
            FROM conversation_turns
           WHERE conversation_id = $1),
         $2,
         'pending'
       )
       RETURNING id, turn_index`,
      [conversationId, userMessage],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("createTurnIfIdle: no row returned");
    return { ok: true, turnId: row.id, turnIndex: row.turn_index } as const;
  });
}

export async function updateTurnStatus(
  turnId: string,
  status: "pending" | "streaming" | "complete" | "error",
  error?: string,
): Promise<void> {
  if (status === "streaming") {
    await sql(
      `UPDATE conversation_turns SET status = $2, started_at = NOW() WHERE id = $1`,
      [turnId, status],
    );
  } else if (status === "complete") {
    await sql(
      `UPDATE conversation_turns SET status = $2, completed_at = NOW() WHERE id = $1`,
      [turnId, status],
    );
  } else if (status === "error") {
    await sql(
      `UPDATE conversation_turns
          SET status = $2, completed_at = NOW(), error = $3
        WHERE id = $1`,
      [turnId, status, error ?? null],
    );
  } else {
    await sql(
      `UPDATE conversation_turns SET status = $2 WHERE id = $1`,
      [turnId, status],
    );
  }
}

export async function insertTurnEvent(
  turnId: string,
  seq: number,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const rows = await sql<{ id: number }>(
    `INSERT INTO turn_events (turn_id, seq, event_type, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [turnId, seq, eventType, JSON.stringify(payload)],
  );
  if (!rows[0]?.id) throw new Error("insertTurnEvent: RETURNING id returned no rows");
  return rows[0].id;
}

/** Record the relative path of a turn's context-log file (see conversation-context-store). */
export async function setTurnContextFile(turnId: string, contextFile: string): Promise<void> {
  await sql(
    `UPDATE conversation_turns SET context_file = $2 WHERE id = $1`,
    [turnId, contextFile],
  );
}

/**
 * Resolve a turn's context-file path, scoped to its conversation so a caller
 * can only read context for a turn that belongs to the given conversation.
 * Returns null when the turn doesn't exist, belongs to another conversation,
 * or has no context file.
 */
export async function getTurnContextFile(
  conversationId: string,
  turnId: string,
): Promise<string | null> {
  const rows = await sql<{ context_file: string | null }>(
    `SELECT context_file FROM conversation_turns
      WHERE id = $1 AND conversation_id = $2`,
    [turnId, conversationId],
  );
  return rows[0]?.context_file ?? null;
}

/**
 * Delete the transient streaming events (`token`, `thinking`) of a finished turn.
 *
 * These events carry CUMULATIVE snapshots per delta — O(n²) storage in response
 * length — and are pure transport once the turn is complete: the final text
 * lives on the assistant message (including its `thinking`). Pruning bounds
 * turn_events growth and keeps SSE replay payloads small (issue #834).
 * Durable events (log, context_ref, spec_update, complete, error) are kept.
 */
export async function pruneStreamEvents(turnId: string): Promise<void> {
  await sql(
    `DELETE FROM turn_events
      WHERE turn_id = $1 AND event_type IN ('token', 'thinking')`,
    [turnId],
  );
}

export async function getTurnWithEvents(turnId: string): Promise<TurnWithEvents | null> {
  const turns = await sql<TurnRow>(
    `SELECT * FROM conversation_turns WHERE id = $1`,
    [turnId],
  );
  if (!turns[0]) return null;
  const events = await sql<TurnEventRow>(
    `SELECT * FROM turn_events WHERE turn_id = $1 ORDER BY seq ASC`,
    [turnId],
  );
  return { turn: turns[0], events };
}

export async function getConversationEvents(
  conversationId: string,
  sinceId?: number,
): Promise<TurnEventRow[]> {
  if (sinceId !== undefined) {
    return sql<TurnEventRow>(
      `SELECT te.*
         FROM turn_events te
         JOIN conversation_turns ct ON ct.id = te.turn_id
        WHERE ct.conversation_id = $1
          AND te.id > $2
        ORDER BY te.id ASC`,
      [conversationId, sinceId],
    );
  }
  return sql<TurnEventRow>(
    `SELECT te.*
       FROM turn_events te
       JOIN conversation_turns ct ON ct.id = te.turn_id
      WHERE ct.conversation_id = $1
      ORDER BY te.id ASC`,
    [conversationId],
  );
}
