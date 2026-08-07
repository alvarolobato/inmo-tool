/**
 * Digest scheduling DB layer (issue #35, Phase 5.5 v1).
 *
 * Two responsibilities the scheduler needs from Postgres:
 *   - `listDigestProfiles`: every ACTIVE profile with its cadence, recipient
 *     override, and last `digest_run.sent_at` — one round trip, so the
 *     scheduler can decide who is due in memory (via the pure `isDigestDue`).
 *   - `recordDigestRun`: append a `digest_run` row after a cycle, whether or
 *     not an email went out. This IS the "since last digest" watermark and the
 *     idempotency key (one row per profile per assembled day).
 *
 * Server-only: imports `lib/db-write`.
 */

import { sql } from "@/lib/db-write";

export type DigestCadence = "daily" | "weekly" | "off";

/**
 * The two independent watermark series in `digest_run.kind` (#428): the
 * cadenced daily/weekly digest, and the per-hour "En seguimiento" watchlist
 * pass. Each reads/advances only its own series, so a tracked-property drop
 * alerts at most once per channel.
 */
export type DigestRunKind = "digest" | "seguimiento";

export interface DigestProfile {
  id: number;
  name: string;
  cadence: DigestCadence;
  /** Per-profile recipient override; null falls back to the global config recipient. */
  email: string | null;
  /** Most recent `digest_run.sent_at` for kind='digest', or null if never. */
  lastSentAt: string | null;
  /** Most recent `digest_run.sent_at` for kind='seguimiento', or null if never (#428). */
  lastSeguimientoAt: string | null;
}

interface RawDigestProfileRow {
  id: number;
  name: string;
  digest_cadence: DigestCadence;
  digest_email: string | null;
  last_sent_at: string | null;
  last_seguimiento_at: string | null;
}

/**
 * Every active (non-archived) profile with its digest config and last-run
 * watermark. Includes `off` profiles too — the caller filters them via
 * `isDigestDue`, keeping the "is it due" rule in one pure, tested place rather
 * than split between SQL and TypeScript.
 */
export async function listDigestProfiles(): Promise<DigestProfile[]> {
  const rows = await sql<RawDigestProfileRow>(
    `SELECT sp.id, sp.name, sp.digest_cadence, sp.digest_email,
            (SELECT dr.sent_at FROM digest_run dr
              WHERE dr.profile_id = sp.id AND dr.kind = 'digest'
              ORDER BY dr.sent_at DESC
              LIMIT 1) AS last_sent_at,
            (SELECT dr.sent_at FROM digest_run dr
              WHERE dr.profile_id = sp.id AND dr.kind = 'seguimiento'
              ORDER BY dr.sent_at DESC
              LIMIT 1) AS last_seguimiento_at
       FROM search_profile sp
      WHERE sp.archived_at IS NULL
      ORDER BY sp.id`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    cadence: r.digest_cadence,
    email: r.digest_email,
    lastSentAt: r.last_sent_at,
    lastSeguimientoAt: r.last_seguimiento_at,
  }));
}

/**
 * Append a `digest_run` row for a completed cycle. `candidateCount` is the
 * total item count across all sections; `sent` records whether an email
 * actually went out (false for an empty digest or an unconfigured-SMTP no-op).
 * Returns the row's `sent_at` (the new watermark).
 */
export async function recordDigestRun(
  profileId: number,
  candidateCount: number,
  sent: boolean,
  kind: DigestRunKind = "digest",
): Promise<string> {
  const rows = await sql<{ sent_at: string }>(
    `INSERT INTO digest_run (profile_id, candidate_count, sent, kind)
     VALUES ($1, $2, $3, $4)
     RETURNING sent_at`,
    [profileId, candidateCount, sent, kind],
  );
  return rows[0].sent_at;
}
