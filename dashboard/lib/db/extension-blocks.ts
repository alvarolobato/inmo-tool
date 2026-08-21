/**
 * Browser-extension block/challenge episodes — server-only DB access (issue
 * #634).
 *
 * The extension can NOT inject into the dashboard origin (its manifest
 * host_permissions cover only the capture portal hosts), so — exactly like
 * the presence heartbeat (lib/db/extension-status.ts) — reporting a detected
 * block is SERVER-MEDIATED: the extension fire-and-forget POSTs
 * /api/extension/block-episode the instant it detects a CAPTCHA/WAF
 * challenge and pauses its run, and /etl/salud reads the recent history from
 * here so the owner sees it without the browser open.
 *
 * `recordBlockEpisode` uses the write pool (@/lib/db-write); never import
 * this from a client component. `getRecentBlockEpisodes` uses the read-only
 * pool (@/lib/db), same split as every other data-health reader.
 */

import { query } from "@/lib/db";
import { sql } from "@/lib/db-write";
import type { ExtensionBlockEpisode } from "@/lib/data-health";

/** How many recent episodes /etl/salud shows — enough history to spot a
 * recurring offender without an unbounded read. */
const RECENT_LIMIT = 20;

/**
 * Insert one block-episode row. Portal + signature are free-text ids the
 * extension already validated are non-empty strings (see the API route); no
 * page content, URL, or listing data is ever accepted here.
 */
export async function recordBlockEpisode(
  portal: string,
  signature: string,
  detectedAt: Date,
): Promise<void> {
  await sql(
    `INSERT INTO extension_block_episode (portal, signature, detected_at)
     VALUES ($1, $2, $3)`,
    [portal, signature, detectedAt.toISOString()],
  );
}

/** The most recent block episodes, newest first, bounded to RECENT_LIMIT. */
export async function getRecentBlockEpisodes(): Promise<ExtensionBlockEpisode[]> {
  const res = await query(
    `SELECT portal, signature, detected_at
       FROM extension_block_episode
      ORDER BY detected_at DESC
      LIMIT $1`,
    [RECENT_LIMIT],
  );
  return res.rows.map((row) => ({
    portal: String(row[0]),
    signature: String(row[1]),
    detected_at: new Date(row[2] as string).toISOString(),
  }));
}
