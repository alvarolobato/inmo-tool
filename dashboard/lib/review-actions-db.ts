/**
 * Persistence for weekly_review_actions (follow-up tracking).
 */

import { getPool, sql } from "./db-write";
import type { ReviewContent } from "./review-schema";

export interface ReviewActionRow {
  id: number;
  review_id: number;
  action_key: string;
  priority: string;
  owner_role: string;
  owner_name: string;
  due_date: string;
  expected_impact: string;
  status: string;
  last_update: string;
  created_at: string;
  updated_at: string;
}

export async function replaceActionsFromReviewContent(
  reviewId: number,
  content: ReviewContent,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM weekly_review_actions WHERE review_id = $1`, [reviewId]);
    for (const a of content.action_items) {
      await client.query(
        `INSERT INTO weekly_review_actions (
           review_id, action_key, priority, owner_role, owner_name, due_date, expected_impact, status
         ) VALUES ($1, $2, $3, $4, $5, $6::date, $7, 'pendiente')`,
        [
          reviewId,
          a.action_key,
          a.priority,
          a.owner_role,
          a.owner_name ?? "",
          a.due_date,
          a.expected_impact,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures (connection may already be aborted)
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function listActionsForReview(reviewId: number): Promise<ReviewActionRow[]> {
  return sql<ReviewActionRow>(
    `SELECT
       id,
       review_id,
       action_key,
       priority,
       owner_role,
       owner_name,
       due_date::text,
       expected_impact,
       status,
       last_update,
       created_at,
       updated_at
     FROM weekly_review_actions
     WHERE review_id = $1
     ORDER BY
       CASE priority WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END,
       action_key`,
    [reviewId],
  );
}

export interface PatchReviewActionInput {
  status?: "pendiente" | "en_curso" | "hecha" | "descartada";
  owner_name?: string;
}

export async function patchReviewAction(
  reviewId: number,
  actionKey: string,
  patch: PatchReviewActionInput,
): Promise<ReviewActionRow | null> {
  const current = await sql<{ status: string; owner_name: string }>(
    `SELECT status, owner_name FROM weekly_review_actions WHERE review_id = $1 AND action_key = $2`,
    [reviewId, actionKey],
  );
  if (current.length === 0) return null;

  const nextStatus = patch.status ?? current[0].status;
  const nextOwner = patch.owner_name ?? current[0].owner_name;

  const rows = await sql<ReviewActionRow>(
    `UPDATE weekly_review_actions
     SET status = $3,
         owner_name = $4,
         last_update = NOW(),
         updated_at = NOW()
     WHERE review_id = $1 AND action_key = $2
     RETURNING
       id,
       review_id,
       action_key,
       priority,
       owner_role,
       owner_name,
       due_date::text,
       expected_impact,
       status,
       last_update,
       created_at,
       updated_at`,
    [reviewId, actionKey, nextStatus, nextOwner],
  );
  return rows[0] ?? null;
}
