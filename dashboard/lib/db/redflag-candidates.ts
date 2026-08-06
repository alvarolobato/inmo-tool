/**
 * #396 (Fase 7 of #385) — trending `other`-flag candidate slugs.
 *
 * Fase 6 (#394/#395) made every `other` redflag carry a `candidate_type` slug
 * inside the `ai_assessment.result` JSON, turning the long tail of unnamed
 * problems into groupable data. This module is the read side of that data: it
 * aggregates the slugs across ALL stored redflags assessments and returns the
 * most frequent ones, so the assessment orchestrator can inject them into the
 * redflags prompt (`buildRedflagsPrompt`) as "here is what has already been
 * proposed". The model then reuses an existing candidate instead of coining a
 * synonym (`obra_sin_acabar` / `construccion_incompleta` for what is already
 * `unfinished_construction`, or three variants of the same idea).
 *
 * This is context injection, NOT detection and NOT a filter: the slugs never
 * become query predicates, and a slug does not enter the closed vocabulary
 * until a human promotes it (Fase 8). The classification stays the model's job
 * (cf. D-095's LLM-only rule) — nothing here reads the advert text.
 *
 * Server-only: imports `lib/db-write` (the `pg` client). Never import from a
 * client component.
 */

import { sql } from "@/lib/db-write";
import type { RedflagTrendingCandidate } from "@/lib/llm-context/types";

export type { RedflagTrendingCandidate };

/**
 * Config for the trending query, surfaced via env so ops can tune it without a
 * code change (mirrors `lib/llm-tools/config.ts`'s `readInt` pattern):
 *
 *  - `DASHBOARD_REDFLAGS_TRENDING_LIMIT` (default 10) — the top-N cap.
 *  - `DASHBOARD_REDFLAGS_TRENDING_MIN_COUNT` (default 2) — the minimum number of
 *    occurrences a slug needs before it appears, so a one-off proposal (which is
 *    exactly the noisy long tail we do NOT want to anchor the model on) is
 *    excluded.
 */
function readInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getRedflagsTrendingConfig(): { limit: number; minCount: number } {
  return {
    limit: readInt("DASHBOARD_REDFLAGS_TRENDING_LIMIT", 10),
    minCount: readInt("DASHBOARD_REDFLAGS_TRENDING_MIN_COUNT", 2),
  };
}

/**
 * The top-N most frequent `candidate_type` slugs across every stored redflags
 * assessment, ordered by count desc (ties broken by slug for a stable order),
 * filtered to slugs seen at least `minCount` times.
 *
 * Unnests each row's `result->'flags'` array and keeps only evidenced-`other`
 * flags that carry a non-empty `candidate_type`. The `CASE ... jsonb_typeof`
 * guard makes `jsonb_array_elements` safe against any row whose `flags` is not
 * an array (all rows written by `saveRedFlagsAssessment` store an array, but the
 * guard costs nothing and avoids a hard error on unexpected data).
 *
 * Returns `[]` when nothing qualifies — the normal cold-start state before any
 * `other` flag has been proposed twice. The caller renders that as "no
 * candidates yet"; it is never an error.
 */
export async function getTrendingCandidateTypes(opts?: {
  limit?: number;
  minCount?: number;
}): Promise<RedflagTrendingCandidate[]> {
  const cfg = getRedflagsTrendingConfig();
  const limit = opts?.limit ?? cfg.limit;
  const minCount = opts?.minCount ?? cfg.minCount;
  if (limit <= 0) return [];

  const rows = await sql<{ candidate_type: string; count: number }>(
    `SELECT flag->>'candidate_type' AS candidate_type,
            COUNT(*)::int          AS count
       FROM ai_assessment a
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(a.result->'flags') = 'array'
              THEN a.result->'flags'
              ELSE '[]'::jsonb END
       ) AS flag
      WHERE a.assessment_type = 'redflags'
        AND flag->>'type' = 'other'
        AND COALESCE(flag->>'candidate_type', '') <> ''
      GROUP BY flag->>'candidate_type'
     HAVING COUNT(*) >= $1
      ORDER BY count DESC, candidate_type ASC
      LIMIT $2`,
    [minCount, limit],
  );

  return rows.map((r) => ({ candidateType: r.candidate_type, count: Number(r.count) }));
}
