/**
 * Prospective-site capture queue persistence (issue #705) — server-only
 * (imports lib/db-write, the `pg` client). The client-safe types/validators
 * live in lib/spike-queue.ts.
 *
 * Nothing in this module touches `capture_worklist`, `extension_capture`,
 * `listing` or `property`. That separation is the point — see D-167 and the
 * `capture_spike_request` comment in etl/schema/init.sql.
 */

import { sql } from "@/lib/db-write";
import {
  MAX_PENDING_SPIKE_REQUESTS,
  MAX_SPIKE_ATTEMPTS,
  validateSpikeUrls,
  type SpikeRequestRow,
  type SpikeStatus,
} from "@/lib/spike-queue";

export interface AddSpikeResult {
  added: number;
  duplicate: number;
  invalid: { url: string; reason: string }[];
  /** Set when the pending cap refused part (or all) of the batch. */
  capped?: number;
}

/** Every request, newest first. The queue is small by construction (capped). */
export async function listSpikeRequests(limit = 500): Promise<SpikeRequestRow[]> {
  return sql<SpikeRequestRow>(
    `SELECT id, url, host, origin, site_label, note, status, matched_diagnostic_id,
            attempts, last_attempt_at, created_at, updated_at
       FROM capture_spike_request
      ORDER BY created_at DESC, id DESC
      LIMIT $1`,
    [limit],
  );
}

/**
 * Hand the oldest still-pending requests to the driver — and CHARGE them for it
 * in the same statement. Feeds the `spike` auto unit.
 *
 * This is the queue's only forward gear, and it is deliberately a server-side
 * fact: `attempts` is incremented by the statement that delivers the row, not
 * by anything the extension chooses to report afterwards. A driver that dies
 * mid-unit, loses its admin key, gets a 500 on every write, or simply never
 * calls back therefore cannot pin a row at `attempts = 0` and — because a
 * `spike` unit preempts harvest and drain — silently starve the owner's real
 * ~1,700-row listing drain forever. Worst case is now arithmetic, not trust:
 * every delivery permanently consumes one of MAX_SPIKE_ATTEMPTS.
 *
 * `grantedOrigins` is what the driver reports it already holds a Chrome host
 * permission for. Rows outside that set are NOT delivered and NOT charged:
 * they stay `pending`, the popup keeps offering the grant, and "the operator
 * hadn't clicked yet" can never masquerade as `unreachable`, which is supposed
 * to be a finding about the candidate site. An empty set delivers nothing, so
 * a driver that can't enumerate its permissions falls straight through to the
 * listing drain instead of blocking it.
 *
 * Oldest-first and nothing else: there is no portal, so no due-rank, and
 * deliberately no interaction with `selectNextPendingUrls` — the listing
 * drain's ordering (D-156's `requeue_rank`, the due-first ranking) is
 * untouched by anything in this file.
 */
export async function claimSpikeRequestsForDelivery(
  limit: number,
  grantedOrigins: readonly string[],
): Promise<{ id: number; url: string }[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const origins = [...new Set(grantedOrigins.filter(Boolean))];
  if (origins.length === 0) return [];
  return sql<{ id: number; url: string }>(
    `WITH claimed AS (
       SELECT id
         FROM capture_spike_request
        WHERE status = 'pending'
          AND attempts < $2
          AND origin = ANY($3::text[])
        ORDER BY created_at ASC, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE capture_spike_request AS r
        SET attempts = r.attempts + 1,
            last_attempt_at = NOW(),
            status = CASE WHEN r.attempts + 1 >= $2 THEN 'unreachable' ELSE r.status END
       FROM claimed c
      WHERE r.id = c.id
      RETURNING r.id, r.url`,
    [Math.floor(limit), MAX_SPIKE_ATTEMPTS, origins],
  );
}

/** How many requests are currently pending (for the cap check + the UI). */
export async function countPendingSpikeRequests(): Promise<number> {
  const rows = await sql<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM capture_spike_request WHERE status = 'pending'`,
  );
  return rows.length > 0 ? Number(rows[0].n) : 0;
}

/**
 * Queue a batch of prospective-site URLs under one operator-given site label.
 *
 * Validation is `validateSpikeUrls` — which refuses any host that already has
 * a capture connector, the mirror of `addWorklistUrls` refusing any host that
 * doesn't. Re-adding is idempotent (ON CONFLICT (match_key) DO NOTHING) and
 * reported as a duplicate.
 */
export async function addSpikeRequests(
  urls: string[],
  siteLabel: string,
  note?: string | null,
  deniedHosts: readonly string[] = [],
): Promise<AddSpikeResult> {
  const { accepted, rejected } = validateSpikeUrls(urls, { deniedHosts });
  const result: AddSpikeResult = {
    added: 0,
    duplicate: 0,
    invalid: rejected,
  };
  if (accepted.length === 0) return result;

  // Cap check up front, then again implicitly by only inserting `room` rows.
  // A racing second batch can overshoot slightly; the cap is a guard against
  // an accidental 5,000-URL paste, not a hard quota needing serialisation.
  const pending = await countPendingSpikeRequests();
  const room = Math.max(0, MAX_PENDING_SPIKE_REQUESTS - pending);
  const toInsert = accepted.slice(0, room);
  if (toInsert.length < accepted.length) {
    result.capped = accepted.length - toInsert.length;
  }

  const label = siteLabel.trim();
  const cleanNote = note && note.trim() ? note.trim() : null;

  for (const item of toInsert) {
    const inserted = await sql<{ id: number }>(
      `INSERT INTO capture_spike_request (url, match_key, host, origin, site_label, note)
         VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (match_key) DO NOTHING
       RETURNING id`,
      [item.url, item.matchKey, item.host, item.origin, label, cleanNote],
    );
    if (inserted.length > 0) result.added += 1;
    else result.duplicate += 1;
  }
  return result;
}

/** Set one request's status by hand (the operator's skip / re-queue buttons). */
export async function setSpikeStatus(
  id: number,
  status: SpikeStatus,
): Promise<boolean> {
  // Re-queueing also clears the attempt counter — otherwise a row given up on
  // as `unreachable` would be handed straight back at MAX_ATTEMPTS and never
  // actually retried.
  const rows = await sql<{ id: number }>(
    `UPDATE capture_spike_request
        SET status = $2,
            attempts = CASE WHEN $2 = 'pending' THEN 0 ELSE attempts END
      WHERE id = $1
      RETURNING id`,
    [id, status],
  );
  return rows.length > 0;
}

/** Drop one request outright. */
export async function deleteSpikeRequest(id: number): Promise<boolean> {
  const rows = await sql<{ id: number }>(
    `DELETE FROM capture_spike_request WHERE id = $1 RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/**
 * Close a spike request BY ID, because the driver delivered the page it was
 * handed. This is the path that survives a redirect.
 *
 * Correlating by `match_key` alone (below) silently fails the moment the
 * candidate site moves the URL: `content-script.js` reports
 * `window.location.href`, i.e. the URL AFTER redirects, and the key is
 * host+path — so a locale prefix, a canonical slug, a consent-wall bounce, a
 * host change or an SPA `pushState` all produce a key that matches no row.
 * Redirect-heavy servicer portals are precisely the population this feature
 * targets, so that is the likely case, not an edge case. The request id is
 * carried on the POST instead: the server handed it out, the server matches
 * it back, and where the page ended up is irrelevant.
 *
 * Accepts `unreachable` as well as `pending`: the last of MAX_SPIKE_ATTEMPTS
 * deliveries marks the row `unreachable` up front (the counter is charged at
 * delivery), so a page that lands on that very attempt must still be allowed
 * to close it. `skipped` is left alone — the operator dropped it on purpose.
 */
export async function markSpikeCaptured(
  id: number,
  diagnosticId: number,
): Promise<number | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await sql<{ id: number }>(
    `UPDATE capture_spike_request
        SET status = 'captured', matched_diagnostic_id = $2
      WHERE id = $1 AND status IN ('pending', 'unreachable')
      RETURNING id`,
    [id, diagnosticId],
  );
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * Correlate an incoming diagnostic with a spike request by the SAME canonical
 * `match_key` `_correlate_worklist` uses. Called from
 * POST /api/extension/diagnostic ONLY when the payload carries no request id —
 * i.e. the #675 manual "Forzar captura + diagnóstico" button, where the
 * operator may well have opened a page they had queued by hand.
 *
 * Best-effort by contract: a diagnostic that matches nothing (the common case)
 * is a no-op, and a failure here must never fail the POST — the page is
 * already safely stored. Never the primary mechanism: see
 * {@link markSpikeCaptured} for why a URL-derived key cannot be trusted to
 * advance a queue.
 */
export async function correlateSpikeDiagnostic(
  matchKey: string,
  diagnosticId: number,
): Promise<number | null> {
  if (!matchKey) return null;
  const rows = await sql<{ id: number }>(
    `UPDATE capture_spike_request
        SET status = 'captured', matched_diagnostic_id = $2
      WHERE match_key = $1 AND status IN ('pending', 'unreachable')
      RETURNING id`,
    [matchKey, diagnosticId],
  );
  return rows.length > 0 ? rows[0].id : null;
}
