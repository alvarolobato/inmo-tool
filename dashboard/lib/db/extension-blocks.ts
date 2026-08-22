/**
 * Browser-extension block/challenge episodes — server-only DB access (issue
 * #634).
 *
 * The extension can NOT inject into the dashboard origin (its manifest
 * host_permissions cover only the capture portal hosts), so — exactly like
 * the presence heartbeat (lib/db/extension-status.ts) — reporting a detected
 * block is SERVER-MEDIATED: the extension fire-and-forget POSTs
 * /api/extension/block-episode the instant it detects a CAPTCHA/WAF
 * challenge and pauses its run, and the dashboard reads the recent history from
 * here so the owner sees it without the browser open.
 *
 * Two consumers since #642 P2 deleted /etl/salud, and the split is deliberate:
 * Estado's Avisos band shows the ACTIVE block (an episode inside
 * ACTIVE_BLOCK_WINDOW_HOURS) and Fuentes/<portal> repeats it as the state of
 * that source; Actividad's `bloqueo` rows (#706) are the episode HISTORY.
 * Neither surface is a copy of the other.
 *
 * `recordBlockEpisode` uses the write pool (@/lib/db-write); never import
 * this from a client component. `getRecentBlockEpisodes` uses the read-only
 * pool (@/lib/db), same split as every other data-health reader — and returns
 * one row PER PORTAL, not a flat recent list; see its own docstring.
 */

import { query } from "@/lib/db";
import { sql } from "@/lib/db-write";
import type { ExtensionBlockEpisode } from "@/lib/data-health";

/** How many PORTALS this returns a latest-episode row for — a bound on the
 * read, not on history. See the DISTINCT ON in getRecentBlockEpisodes for why
 * this is a portal count and not an episode count. */
const RECENT_PORTALS = 20;

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

/**
 * The latest block episode PER PORTAL, newest portal first.
 *
 * This used to be a flat `ORDER BY detected_at DESC LIMIT 20` over all
 * episodes, which was fine while the only consumer was a history table on
 * `/etl/salud`. #642 P2 changed what it feeds: `activeBlocksByPortal` derives
 * a per-portal STATE from it (the Estado aviso chip, the Fuentes/<portal>
 * banner), and a flat top-20 makes that state silently wrong — one portal
 * challenged 20 times in an hour pushes every OTHER portal's still-active
 * block off the end, and its chip just disappears. A bad state derivation
 * that looks healthy is worse than no chip at all (PR #710 review).
 *
 * DISTINCT ON gives the derivation exactly what it consumes — one row per
 * portal, the newest — so the answer no longer depends on episode volume. The
 * bound is now on the number of portals, which is small and bounded by how
 * many capture sources exist. Full chronology stays Actividad's own query
 * (#706); this was never it.
 */
export async function getRecentBlockEpisodes(): Promise<ExtensionBlockEpisode[]> {
  const res = await query(
    `SELECT portal, signature, detected_at
       FROM (
         SELECT DISTINCT ON (portal) portal, signature, detected_at
           FROM extension_block_episode
          ORDER BY portal, detected_at DESC
       ) latest
      ORDER BY detected_at DESC
      LIMIT $1`,
    [RECENT_PORTALS],
  );
  return res.rows.map((row) => ({
    portal: String(row[0]),
    signature: String(row[1]),
    detected_at: new Date(row[2] as string).toISOString(),
  }));
}
