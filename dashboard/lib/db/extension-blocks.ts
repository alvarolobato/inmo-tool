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
 * ACTIVE_BLOCK_WINDOW_HOURS that nothing has since contradicted) and
 * Fuentes/<portal> repeats it as the state of that source; Actividad's
 * `bloqueo` rows (#706) are the episode HISTORY. Neither surface is a copy of
 * the other, and issue #711 is what happens when the STATE half forgets it:
 * the episode row is permanent, the wall it describes is not.
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
 * The capture outcomes that PROVE a portal's wall is down (issue #711, D-169).
 *
 * The test is narrow and deliberate: "did the portal serve us the page we
 * asked for", not "did anything happen". Each of these three is a page the
 * portal handed over and we read:
 *
 *   - `done`      — the advert, parsed and ingested. Unambiguous.
 *   - `withdrawn` — the portal's OWN "anuncio retirado" notice (#690/D-159),
 *                   positively identified and corroborated against the stored
 *                   listing. Nothing was ingested, but the portal served the
 *                   page and we read its content. It is evidence about the
 *                   ADVERT, not about our access, and our access is what a
 *                   block is about.
 *   - `listing`   — a search/results page whose detail links we harvested
 *                   (#292). Same proof, different page type.
 *
 * Everything else is excluded, and the exclusions are the interesting half:
 *
 *   - `blocked`        — the wall itself (#692). Obviously not.
 *   - `never_rendered` — #701, and the closest call. It looks like proof the
 *                        portal "served something", but its own schema comment
 *                        (init.sql) says the honest claim is ONLY that "we ran
 *                        out of patience" — it deliberately does NOT assert a
 *                        page arrived. A challenge page that never finishes
 *                        rendering is exactly the shape that produces it, so
 *                        letting it clear a block would let the failure mode
 *                        announce its own absence.
 *   - `failed`         — bytes arrived, the parser rejected them. That is
 *                        evidence about our parser, not about the portal's
 *                        willingness to serve us, and a challenge page that
 *                        the challenge-phrase table has stopped matching lands
 *                        here. Too ambiguous to silence an alarm with.
 *   - `pending`        — not terminal. Nothing has been observed at all.
 *
 * The asymmetry behind all of it: failing to clear leaves a stale alarm the
 * owner can see is wrong (annoying, self-evident); clearing wrongly hides a
 * real wall behind a green board (silent, and the capture queue drains into
 * nothing). Only unambiguous evidence gets to clear.
 */
const BLOCK_CLEARING_STATUSES = ["done", "withdrawn", "listing"] as const;

/**
 * The latest block episode PER PORTAL, newest portal first, each carrying the
 * derived `resolved_at` that says whether its wall is over.
 *
 * **Why DISTINCT ON.** This used to be a flat `ORDER BY detected_at DESC LIMIT
 * 20` over all episodes, which was fine while the only consumer was a history
 * table on `/etl/salud`. #642 P2 changed what it feeds: `activeBlocksByPortal`
 * derives a per-portal STATE from it (the Estado aviso chip, the
 * Fuentes/<portal> banner), and a flat top-20 makes that state silently wrong
 * — one portal challenged 20 times in an hour pushes every OTHER portal's
 * still-active block off the end, and its chip just disappears. A bad state
 * derivation that looks healthy is worse than no chip at all (PR #710 review).
 * DISTINCT ON gives the derivation exactly what it consumes — one row per
 * portal, the newest — so the answer no longer depends on episode volume. Full
 * chronology stays Actividad's own query (#706); this was never it.
 *
 * **Why the LATERAL.** Issue #711: the table is append-only, nothing ever
 * closes an episode, and for three hours the board told the owner idealista
 * was walled while the source row beside it showed idealista ingesting every
 * minute. Resolution is derived here rather than stored, because the writer
 * that would maintain a `resolved_at` COLUMN is precisely the thing that does
 * not exist — the wall clears in the owner's browser and nothing reports it
 * back. A derived answer cannot drift from the evidence; a column would be one
 * more thing to forget to write, which is the bug we are fixing. See D-169.
 *
 * **Which clock.** `GREATEST(detected_at, reported_at)`, not `detected_at`
 * alone. `detected_at` is the extension's CLIENT clock (the table says so) and
 * `created_at` on the capture side is the server's, so comparing them directly
 * is a cross-clock comparison a skewed laptop can win. Both failure modes of
 * GREATEST err toward keeping the alarm up: a slow client clock is corrected
 * by the server-stamped `reported_at`, and a retried fire-and-forget POST only
 * pushes the anchor LATER, demanding fresher evidence to clear. The displayed
 * timestamp stays `detected_at` — that is when the owner's wall appeared.
 *
 * **Cost.** One index range-scan per portal (≤ the handful of capture portals
 * that exist), against the partial index init.sql keeps for exactly this. It
 * is strictly cheaper than the full `extension_capture` GROUP BY that
 * `getDataHealth` already runs in the same `Promise.all`.
 */
export async function getRecentBlockEpisodes(): Promise<ExtensionBlockEpisode[]> {
  const res = await query(
    `SELECT l.portal, l.signature, l.detected_at, r.resolved_at
       FROM (
         SELECT DISTINCT ON (portal)
                portal, signature, detected_at,
                GREATEST(detected_at, reported_at) AS block_anchor
           FROM extension_block_episode
          ORDER BY portal, detected_at DESC
       ) l
       LEFT JOIN LATERAL (
         SELECT MIN(ec.created_at) AS resolved_at
           FROM extension_capture ec
          WHERE ec.connector_name = l.portal
            AND ec.status = ANY($1::text[])
            AND ec.created_at > l.block_anchor
       ) r ON true
      ORDER BY l.detected_at DESC
      LIMIT $2`,
    [[...BLOCK_CLEARING_STATUSES], RECENT_PORTALS],
  );
  return res.rows.map((row) => ({
    portal: String(row[0]),
    signature: String(row[1]),
    detected_at: new Date(row[2] as string).toISOString(),
    resolved_at: row[3] == null ? null : new Date(row[3] as string).toISOString(),
  }));
}
