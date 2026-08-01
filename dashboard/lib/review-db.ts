/**
 * Database helpers for weekly_reviews (versioned) and related reads.
 */

import { sql } from "./db-write";
import type { ReviewContent } from "./review-schema";

export interface ReviewRow {
  id: number;
  week_start: string;
  revision: number;
  generation_mode: string;
  supersedes_review_id: number | null;
  window_start: string;
  window_end: string;
  content: ReviewContent;
  created_at: string;
}

export interface ReviewWeekSummaryRow {
  week_start: string;
  latest_id: number;
  latest_revision: number;
  revision_count: number;
  executive_summary: string;
  created_at: string;
}

export interface ReviewRevisionMeta {
  id: number;
  week_start: string;
  revision: number;
  generation_mode: string;
  created_at: string;
  preview: string;
}

export interface SaveReviewParams {
  weekStart: string;
  windowStart: string;
  windowEnd: string;
  revision: number;
  generationMode: "initial" | "refresh_data" | "alternate_angle";
  supersedesReviewId: number | null;
  content: ReviewContent;
}

export async function saveReview(params: SaveReviewParams): Promise<number> {
  const rows = await sql<{ id: number }>(
    `INSERT INTO weekly_reviews (
       week_start, window_start, window_end, revision, generation_mode, supersedes_review_id, content
     )
     VALUES ($1::date, $2::date, $3::date, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [
      params.weekStart,
      params.windowStart,
      params.windowEnd,
      params.revision,
      params.generationMode,
      params.supersedesReviewId,
      JSON.stringify(params.content),
    ],
  );

  const id = rows[0]?.id;
  if (id == null) {
    throw new Error("INSERT into weekly_reviews did not return an id");
  }
  return id;
}

export async function getMaxRevisionForWeek(weekStart: string): Promise<number> {
  const rows = await sql<{ m: number | null }>(
    `SELECT MAX(revision)::int AS m FROM weekly_reviews WHERE week_start = $1::date`,
    [weekStart],
  );
  return rows[0]?.m ?? 0;
}

export async function getLatestReviewIdForWeek(weekStart: string): Promise<number | null> {
  const rows = await sql<{ id: number }>(
    `SELECT id
     FROM weekly_reviews
     WHERE week_start = $1::date
     ORDER BY revision DESC, id DESC
     LIMIT 1`,
    [weekStart],
  );
  return rows[0]?.id ?? null;
}

export async function getReviewWeekSummaries(): Promise<ReviewWeekSummaryRow[]> {
  const rows = await sql<{
    week_start: string;
    latest_id: number;
    latest_revision: number;
    revision_count: number;
    executive_summary: string | null;
    created_at: string;
  }>(
    `WITH agg AS (
       SELECT week_start,
              MAX(revision)::int AS latest_revision,
              COUNT(*)::int AS revision_count
       FROM weekly_reviews
       GROUP BY week_start
     )
     SELECT
       r.week_start::text,
       r.id AS latest_id,
       r.revision AS latest_revision,
       a.revision_count,
       CASE
         WHEN jsonb_typeof(r.content->'executive_summary') = 'array'
           THEN COALESCE(r.content->'executive_summary'->>0, '')
         ELSE COALESCE(SUBSTRING(r.content->>'executive_summary' FROM 1 FOR 220), '')
       END AS executive_summary,
       r.created_at
     FROM agg a
     JOIN weekly_reviews r
       ON r.week_start = a.week_start AND r.revision = a.latest_revision
     ORDER BY r.week_start DESC
     LIMIT 50`,
  );

  return rows.map((r) => ({
    week_start: r.week_start,
    latest_id: r.latest_id,
    latest_revision: r.latest_revision,
    revision_count: r.revision_count,
    executive_summary: r.executive_summary ?? "",
    created_at: r.created_at,
  }));
}

export async function getRevisionsForWeek(weekStart: string): Promise<ReviewRevisionMeta[]> {
  const rows = await sql<{
    id: number;
    week_start: string;
    revision: number;
    generation_mode: string;
    created_at: string;
    preview: string | null;
  }>(
    `SELECT
       id,
       week_start::text,
       revision,
       generation_mode,
       created_at,
       CASE
         WHEN jsonb_typeof(content->'executive_summary') = 'array'
           THEN COALESCE(SUBSTRING(content->'executive_summary'->>0 FROM 1 FOR 160), '')
         ELSE COALESCE(SUBSTRING(content->>'executive_summary' FROM 1 FOR 160), '')
       END AS preview
     FROM weekly_reviews
     WHERE week_start = $1::date
     ORDER BY revision DESC, id DESC`,
    [weekStart],
  );
  return rows.map((r) => ({
    id: r.id,
    week_start: r.week_start,
    revision: r.revision,
    generation_mode: r.generation_mode,
    created_at: r.created_at,
    preview: r.preview ?? "",
  }));
}

export async function getReviewById(id: number): Promise<ReviewRow | null> {
  const rows = await sql<{
    id: number;
    week_start: string;
    revision: number;
    generation_mode: string;
    supersedes_review_id: number | null;
    window_start: string;
    window_end: string;
    content: ReviewContent;
    created_at: string;
  }>(
    `SELECT
       id,
       week_start::text,
       revision,
       generation_mode,
       supersedes_review_id,
       window_start::text,
       window_end::text,
       content,
       created_at
     FROM weekly_reviews
     WHERE id = $1`,
    [id],
  );

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    week_start: r.week_start,
    revision: r.revision,
    generation_mode: r.generation_mode,
    supersedes_review_id: r.supersedes_review_id,
    window_start: r.window_start,
    window_end: r.window_end,
    content: r.content,
    created_at: r.created_at,
  };
}

export async function getReviewByIdForDiff(
  id: number,
): Promise<{ executive_summary: string[]; action_keys: string[] } | null> {
  const row = await getReviewById(id);
  if (!row) return null;
  const c = row.content;
  const exec =
    Array.isArray(c.executive_summary) && c.executive_summary.length
      ? c.executive_summary
      : [String(c.executive_summary ?? "")];
  const keys = c.action_items.map((a) => a.action_key);
  return { executive_summary: exec, action_keys: keys };
}
