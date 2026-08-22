/**
 * Prospective-site capture queue persistence (issue #705) — server-only
 * (imports lib/db-write, the `pg` client). The client-safe types/validators
 * live in lib/spike-queue.ts.
 *
 * Nothing in this module touches `capture_worklist`, `extension_capture`,
 * `listing` or `property`. That separation is the point — see D-164 and the
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
    `SELECT id, url, host, site_label, note, status, matched_diagnostic_id,
            attempts, last_attempt_at, created_at, updated_at
       FROM capture_spike_request
      ORDER BY created_at DESC, id DESC
      LIMIT $1`,
    [limit],
  );
}

/**
 * The oldest still-pending requests, capped. Feeds the `spike` auto unit.
 *
 * Oldest-first and nothing else: there is no portal, so no due-rank, and
 * deliberately no interaction with `selectNextPendingUrls` — the listing
 * drain's ordering (D-156's `requeue_rank`, the due-first ranking) is
 * untouched by anything in this file.
 */
export async function listPendingSpikeRequests(
  limit: number,
): Promise<{ id: number; url: string }[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return sql<{ id: number; url: string }>(
    `SELECT id, url
       FROM capture_spike_request
      WHERE status = 'pending' AND attempts < $2
      ORDER BY created_at ASC, id ASC
      LIMIT $1`,
    [Math.floor(limit), MAX_SPIKE_ATTEMPTS],
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
): Promise<AddSpikeResult> {
  const { accepted, rejected } = validateSpikeUrls(urls);
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
      `INSERT INTO capture_spike_request (url, match_key, host, site_label, note)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (match_key) DO NOTHING
       RETURNING id`,
      [item.url, item.matchKey, item.host, label, cleanNote],
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
 * Record that the driver opened this request and no page came back. At
 * {@link MAX_SPIKE_ATTEMPTS} the row becomes `unreachable` — NOT `failed`:
 * "the owner's browser could not render this candidate site's page" is a
 * finding about the site, not a pipeline fault, and must never reach
 * data-health. Returns the row's status after the bump.
 */
export async function recordSpikeAttempt(id: number): Promise<SpikeStatus | null> {
  const rows = await sql<{ status: SpikeStatus }>(
    `UPDATE capture_spike_request
        SET attempts = attempts + 1,
            last_attempt_at = NOW(),
            status = CASE
                       WHEN status = 'pending' AND attempts + 1 >= $2 THEN 'unreachable'
                       ELSE status
                     END
      WHERE id = $1
      RETURNING status`,
    [id, MAX_SPIKE_ATTEMPTS],
  );
  return rows.length > 0 ? rows[0].status : null;
}

/**
 * Correlate an incoming diagnostic with a pending spike request, by the SAME
 * canonical `match_key` `_correlate_worklist` uses. Called from
 * POST /api/extension/diagnostic after the row is stored, which is why the
 * extension needs no extra payload field to say "this one was queued".
 *
 * Best-effort by contract: a diagnostic that matches nothing (the #675 manual
 * button, the overwhelmingly common case) is a no-op, and a failure here must
 * never fail the POST — the page is already safely stored.
 *
 * Only flips `pending` rows: a request the operator already skipped stays
 * skipped, and a second capture of the same URL doesn't re-point a `captured`
 * row at a newer diagnostic.
 */
export async function correlateSpikeDiagnostic(
  matchKey: string,
  diagnosticId: number,
): Promise<number | null> {
  if (!matchKey) return null;
  const rows = await sql<{ id: number }>(
    `UPDATE capture_spike_request
        SET status = 'captured', matched_diagnostic_id = $2
      WHERE match_key = $1 AND status = 'pending'
      RETURNING id`,
    [matchKey, diagnosticId],
  );
  return rows.length > 0 ? rows[0].id : null;
}
