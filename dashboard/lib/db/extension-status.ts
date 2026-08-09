/**
 * Browser-extension presence heartbeat — server-only DB access (issue #509).
 *
 * Imports lib/db-write (the `pg` client), so never import this from a client
 * component; the client-safe types + the linked-window math live in
 * lib/extension-status.ts.
 *
 * A single row (id pinned to 1) holds the last time the extension pinged and
 * the version it reported. The POST upserts it; the status read derives
 * `linked` from how recent that timestamp is (see {@link isLinked}).
 */

import { sql } from "@/lib/db-write";
import { isLinked, type ExtensionStatus } from "@/lib/extension-status";

/**
 * Record an extension heartbeat (fire-and-forget from the extension). Upserts
 * the single row, stamping `last_seen_at = NOW()` and the reported version.
 */
export async function recordExtensionHeartbeat(version: string | null): Promise<void> {
  await sql(
    `INSERT INTO extension_heartbeat (id, last_seen_at, version)
       VALUES (1, NOW(), $1)
     ON CONFLICT (id)
       DO UPDATE SET last_seen_at = NOW(), version = EXCLUDED.version`,
    [version],
  );
}

/**
 * The current extension status: `linked` (a heartbeat within the recency
 * window), the last-seen timestamp, and the last reported version. A missing
 * row (never pinged) reads as not linked — never throws for the empty case.
 */
export async function getExtensionStatus(): Promise<ExtensionStatus> {
  const rows = await sql<{ last_seen_at: string | null; version: string | null }>(
    `SELECT last_seen_at, version FROM extension_heartbeat WHERE id = 1`,
  );
  const row = rows[0];
  const lastSeenAt = row?.last_seen_at ?? null;
  return {
    linked: isLinked(lastSeenAt),
    lastSeenAt,
    version: row?.version ?? null,
  };
}
