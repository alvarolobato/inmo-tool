/**
 * Query helpers for `feedback_event` (task 1.2's schema, task 3.1's API/UI,
 * issue #20). Append-only: every call inserts a new row, never updates one —
 * see docs/architecture/data-model.md for why feedback is keyed on
 * `property_id`, not `listing_id`.
 *
 * Server-only: imports lib/db-write (the `pg` client) — never import this
 * from a client component (see lib/listing-status-labels.ts's docstring for
 * the bundle-break this guards against).
 */

import { sql, withTransaction } from "@/lib/db-write";

/** The subset of feedback_type values that participate in the derived "current state" toggle. */
export const STATE_FEEDBACK_TYPES = ["accept", "reject", "star"] as const;
export type StateFeedbackType = (typeof STATE_FEEDBACK_TYPES)[number];

export const FEEDBACK_TYPES = [...STATE_FEEDBACK_TYPES, "note", "correction"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export interface FeedbackEventRow {
  id: number;
  profile_id: number;
  property_id: number;
  listing_id: number | null;
  feedback_type: FeedbackType;
  value: unknown | null;
  note: string | null;
  created_at: string;
}

// id/profile_id/property_id/listing_id (all bigint) arrive as real JS
// numbers via the driver-level int8 type parser (db-shared.ts, #155), so
// rows read as FeedbackEventRow directly — no separate "raw string row ->
// coerced row" mapping step needed anymore.

/**
 * True when `listingId` is a real listing belonging to `propertyId` — a
 * defensive check before storing it as a "which listing was on screen"
 * audit detail, so a client bug can't silently record feedback tagged with
 * an unrelated listing.
 */
export async function listingBelongsToProperty(listingId: number, propertyId: number): Promise<boolean> {
  const rows = await sql<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM listing WHERE id = $1 AND property_id = $2) AS exists`,
    [listingId, propertyId],
  );
  return rows[0]?.exists ?? false;
}

/**
 * Insert a new feedback_event row. Always an INSERT — this table is
 * append-only by design (task 1.2), so a repeated "accept" is a real second
 * event, not an upsert. Callers decide whether re-recording an already-
 * active state is worth doing (the API route no-ops instead, see route.ts).
 */
export async function recordFeedback(opts: {
  profileId: number;
  propertyId: number;
  listingId?: number | null;
  feedbackType: FeedbackType;
  note?: string | null;
  value?: unknown;
}): Promise<FeedbackEventRow> {
  const rows = await sql<FeedbackEventRow>(
    `INSERT INTO feedback_event (profile_id, property_id, listing_id, feedback_type, note, value)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, profile_id, property_id, listing_id, feedback_type, value, note, created_at`,
    [
      opts.profileId,
      opts.propertyId,
      opts.listingId ?? null,
      opts.feedbackType,
      opts.note ?? null,
      opts.value !== undefined ? JSON.stringify(opts.value) : null,
    ],
  );
  return rows[0];
}

/**
 * Atomically record a state-toggle event (accept/reject/star), no-opping if
 * the current state already matches. Uses a Postgres advisory transaction
 * lock keyed on (profileId, propertyId) rather than a plain check-then-insert
 * in application code — a real double-click was verified (PR #89 review) to
 * insert two rows for the same feedback_type ~1.7ms apart under the
 * non-atomic version, which would double-weight that one user action once
 * Phase 3's scoring model consumes these events. The lock serializes any two
 * concurrent requests for the same candidate so the "is this a real change"
 * check and the insert can't interleave, and it's released automatically at
 * transaction end regardless of commit or rollback.
 */
export async function recordStateFeedbackIfChanged(opts: {
  profileId: number;
  propertyId: number;
  listingId?: number | null;
  feedbackType: StateFeedbackType;
}): Promise<{ event: FeedbackEventRow | null; currentState: StateFeedbackType | null; noop: boolean }> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `feedback:${opts.profileId}:${opts.propertyId}`,
    ]);

    const currentResult = await client.query<{ feedback_type: StateFeedbackType }>(
      `SELECT feedback_type
         FROM feedback_event
        WHERE profile_id = $1 AND property_id = $2
          AND feedback_type = ANY($3::text[])
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [opts.profileId, opts.propertyId, STATE_FEEDBACK_TYPES],
    );
    const current = currentResult.rows[0]?.feedback_type ?? null;
    if (current === opts.feedbackType) {
      return { event: null, currentState: current, noop: true };
    }

    const insertResult = await client.query<FeedbackEventRow>(
      `INSERT INTO feedback_event (profile_id, property_id, listing_id, feedback_type, note, value)
       VALUES ($1, $2, $3, $4, NULL, NULL)
       RETURNING id, profile_id, property_id, listing_id, feedback_type, value, note, created_at`,
      [opts.profileId, opts.propertyId, opts.listingId ?? null, opts.feedbackType],
    );
    const event = insertResult.rows[0];
    return { event, currentState: opts.feedbackType, noop: false };
  });
}

/**
 * Full feedback history for one (profile, property) pair, newest first —
 * every event stays individually visible (append-only), unlike the derived
 * "current state" below which only reflects the latest accept/reject/star.
 */
export async function getFeedbackHistory(profileId: number, propertyId: number): Promise<FeedbackEventRow[]> {
  const rows = await sql<FeedbackEventRow>(
    `SELECT id, profile_id, property_id, listing_id, feedback_type, value, note, created_at
       FROM feedback_event
      WHERE profile_id = $1 AND property_id = $2
      ORDER BY created_at DESC, id DESC`,
    [profileId, propertyId],
  );
  return rows;
}

/**
 * The single active toggle state (accept/reject/star), derived as the
 * feedback_type of the most recent event *among those three types* — note
 * and correction events never change this (EC-2). accept/reject/star share
 * one derived state rather than three independent booleans: starring a
 * previously-accepted candidate replaces "accepted" with "starred" as the
 * highlighted button, matching the single-active-toggle UI design.
 */
export async function getCurrentState(profileId: number, propertyId: number): Promise<StateFeedbackType | null> {
  const rows = await sql<{ feedback_type: StateFeedbackType }>(
    `SELECT feedback_type
       FROM feedback_event
      WHERE profile_id = $1 AND property_id = $2
        AND feedback_type = ANY($3::text[])
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [profileId, propertyId, STATE_FEEDBACK_TYPES],
  );
  return rows[0]?.feedback_type ?? null;
}
