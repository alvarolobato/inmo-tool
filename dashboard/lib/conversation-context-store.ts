/**
 * Conversation context-log store — files on disk (Docker volume), not Postgres.
 *
 * Everything needed to *rebuild* a conversation stays in Postgres
 * (conversation_messages, conversation_turns, turn_events). The one thing that
 * lives here is the heavy "context log": an exact copy of what was sent to the
 * LLM for a turn (system prompt, tool catalog, full prior history, user message).
 *
 * Layout: one folder per conversation, one JSON file per turn —
 *   <CONTEXT_DIR>/<conversationId>/<turnId>.json
 *
 * The DB stores only the relative path (`conversation_turns.context_file`); the
 * UI loads the file lazily when the user expands "Contexto original".
 *
 * Writes are best-effort: a failure (e.g. read-only volume) must never break a
 * turn — the caller skips the pointer and the conversation still works.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** IDs are hex (conversation) / uuid (turn); reject anything else to stop traversal. */
const CONV_ID_RE = /^[a-f0-9]{6,}$/;
const TURN_ID_RE = /^[0-9a-fA-F-]{8,}$/;
/** Relative path shape stored in the DB and accepted by readTurnContext. */
const REL_PATH_RE = /^[a-f0-9]{6,}\/[0-9a-fA-F-]{8,}\.json$/;

/** Base directory for context files. Set via DASHBOARD_CONTEXT_DIR in Docker. */
export function contextBaseDir(): string {
  return (
    process.env.DASHBOARD_CONTEXT_DIR ||
    join(process.cwd(), "data", "dashboard", "conversations")
  );
}

/** Relative path stored in the DB for a turn's context file. */
export function relContextPath(conversationId: string, turnId: string): string {
  return `${conversationId}/${turnId}.json`;
}

/**
 * Write the context log for a turn. Returns the relative path to store in the DB,
 * or null when the write fails (best-effort — never throws).
 */
export async function writeTurnContext(
  conversationId: string,
  turnId: string,
  context: unknown,
): Promise<string | null> {
  if (!CONV_ID_RE.test(conversationId) || !TURN_ID_RE.test(turnId)) return null;
  const rel = relContextPath(conversationId, turnId);
  const abs = join(contextBaseDir(), rel);
  try {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, JSON.stringify(context, null, 2), "utf-8");
    return rel;
  } catch (err) {
    console.warn(`[context-store] write failed for ${rel}:`, err);
    return null;
  }
}

/**
 * Read a turn's context log by its stored relative path. Returns null when the
 * path is malformed, escapes the base dir, or the file is missing.
 */
export async function readTurnContext(relPath: string): Promise<unknown | null> {
  if (typeof relPath !== "string" || !REL_PATH_RE.test(relPath)) return null;
  const base = resolve(contextBaseDir());
  const abs = resolve(base, relPath);
  // Defence in depth: the resolved path must stay inside the base directory.
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  try {
    const raw = await readFile(abs, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    console.warn(`[context-store] read failed for ${relPath}:`, err);
    return null;
  }
}
