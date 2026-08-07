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
import { getSystemConfig } from "@/lib/system-config/loader";
import type { RedflagTrendingCandidate, DismissedCandidate } from "@/lib/llm-context/types";

export type { RedflagTrendingCandidate, DismissedCandidate };

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
        -- #407: a slug a human dismissed on /admin/candidatos must stop
        -- resurfacing in the prompt's "recent candidates" block.
        AND NOT EXISTS (
          SELECT 1 FROM dismissed_candidate_type d
           WHERE d.slug = flag->>'candidate_type'
        )
      GROUP BY flag->>'candidate_type'
     HAVING COUNT(*) >= $1
      ORDER BY count DESC, candidate_type ASC
      LIMIT $2`,
    [minCount, limit],
  );

  return rows.map((r) => ({ candidateType: r.candidate_type, count: Number(r.count) }));
}

// ─── #407: dismissed candidate slugs (human review, rejected) ────────────────

/**
 * Every `candidate_type` slug a human explicitly dismissed on
 * `/admin/candidatos`, newest first, with the reason they gave (or null).
 *
 * Two consumers:
 *  - the assessment orchestrator (`batch.ts`), which injects them into the
 *    redflags prompt as "previously reviewed and rejected — do NOT propose
 *    these again" so the model stops re-coining a rejected concept;
 *  - the admin page, indirectly (dismissed slugs are excluded from the
 *    promotion list — see `getPromotionCandidates`).
 *
 * Returns `[]` when nothing has been dismissed — the normal initial state.
 */
export async function getDismissedCandidateTypes(): Promise<DismissedCandidate[]> {
  const rows = await sql<{ slug: string; reason: string | null }>(
    `SELECT slug, reason
       FROM dismissed_candidate_type
      ORDER BY dismissed_at DESC, slug ASC`,
  );
  return rows.map((r) => ({ slug: r.slug, reason: r.reason ?? null }));
}

/**
 * Mark a `candidate_type` slug as reviewed-and-rejected. Idempotent: dismissing
 * the same slug again updates the reason and the timestamp rather than erroring
 * on the primary key. The slug is normalized by the caller (the route) before it
 * reaches here — this is the raw persistence step.
 */
export async function dismissCandidateType(
  slug: string,
  reason: string | null,
): Promise<void> {
  await sql(
    `INSERT INTO dismissed_candidate_type (slug, reason, dismissed_at)
     VALUES ($1, $2, now())
     ON CONFLICT (slug)
     DO UPDATE SET reason = EXCLUDED.reason,
                   dismissed_at = EXCLUDED.dismissed_at`,
    [slug, reason],
  );
}

// ─── Fase 8 (#399): promotion candidates for the admin review page ───────────

/** A property where a candidate slug appeared, for the "go and check" links. */
export interface PromotionCandidateProperty {
  id: number;
  address: string | null;
  /**
   * A profile that has this property in its listing state, so the admin page
   * can deep-link to the profile-scoped property detail
   * (`/profiles/{profileId}/properties/{id}`). `null` when the property is in
   * no profile's worklist yet — the page then shows the ref without a link.
   */
  profileId: number | null;
}

/**
 * One recurring `candidate_type` surfaced for the owner to review and (manually)
 * promote — the read model behind `/admin/candidatos`.
 */
export interface PromotionCandidate {
  /** The normalized snake_case slug the model coined for an `other` flag. */
  candidateType: string;
  /** How many `other` flags across all stored redflags rows carry this slug. */
  count: number;
  /** The model's one-line definition of the slug (most recent non-empty), or null. */
  definition: string | null;
  /** Up to 3 example evidence quotes drawn from the flags that coined the slug. */
  evidence: string[];
  /** Up to 12 distinct properties where the slug appeared. */
  properties: PromotionCandidateProperty[];
}

/**
 * The promotion threshold (`redflags.candidate_promotion_threshold`, env
 * `CANDIDATE_PROMOTION_THRESHOLD`, default 5): the minimum number of times a
 * `candidate_type` must have been proposed before it is worth the owner's
 * review. Read through the central config loader (env > config.yaml > default);
 * falls back to the default if the loader is unavailable. A non-positive or
 * unparseable value degrades to the default rather than surfacing everything.
 */
export const DEFAULT_CANDIDATE_PROMOTION_THRESHOLD = 5;

export function getCandidatePromotionThreshold(): number {
  try {
    const raw = getSystemConfig()["redflags.candidate_promotion_threshold"]?.value;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_CANDIDATE_PROMOTION_THRESHOLD;
  } catch {
    return DEFAULT_CANDIDATE_PROMOTION_THRESHOLD;
  }
}

/**
 * Aggregate the `candidate_type` slugs proposed in redflags `other` flags into
 * promotion candidates seen at least `threshold` times, richest first. Unlike
 * {@link getTrendingCandidateTypes} (which anchors the prompt with just
 * slug+count), this carries the evidence the owner needs to judge each slug:
 * the model's one-line definition, up to 3 example quotes, and up to 12 of the
 * properties where it appeared (with a profile id for a deep link when known).
 *
 * Everything is aggregated in one query, params bound (no injection). Evidence
 * and property refs are built server-side as JSONB arrays so node-pg returns
 * them already parsed. Returns `[]` when nothing clears the threshold — the
 * normal cold-start state, rendered as an empty state, never an error.
 *
 * Read-only and descriptive: promotion to the closed vocabulary is always a
 * manual human PR (D-087 flow). Nothing here mutates the vocabulary or turns a
 * slug into a filter.
 */
export async function getPromotionCandidates(opts?: {
  threshold?: number;
  limit?: number;
}): Promise<PromotionCandidate[]> {
  const threshold = opts?.threshold ?? getCandidatePromotionThreshold();
  const limit = opts?.limit ?? 200;
  if (threshold <= 0 || limit <= 0) return [];

  const rows = await sql<{
    candidate_type: string;
    count: number;
    definition: string | null;
    evidence: string[] | null;
    properties: PromotionCandidateProperty[] | null;
  }>(
    `WITH exploded AS (
       SELECT
         a.property_id,
         p.address,
         pls.profile_id,
         flag->>'candidate_type'                       AS candidate_type,
         NULLIF(TRIM(flag->>'candidate_definition'), '') AS definition,
         NULLIF(TRIM(flag->>'evidence'), '')             AS evidence,
         a.generated_at
       FROM ai_assessment a
       JOIN property p ON p.id = a.property_id
       LEFT JOIN LATERAL (
         SELECT s.profile_id
           FROM profile_listing_state s
          WHERE s.property_id = a.property_id
          ORDER BY s.profile_id
          LIMIT 1
       ) pls ON TRUE
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(a.result->'flags') = 'array'
              THEN a.result->'flags'
              ELSE '[]'::jsonb END
       ) AS flag
      WHERE a.assessment_type = 'redflags'
        AND flag->>'type' = 'other'
        AND COALESCE(flag->>'candidate_type', '') <> ''
        -- #407: a slug a human dismissed on /admin/candidatos must drop out of
        -- the promotion list too, not just the prompt.
        AND NOT EXISTS (
          SELECT 1 FROM dismissed_candidate_type d
           WHERE d.slug = flag->>'candidate_type'
        )
     ),
     latest_def AS (
       SELECT DISTINCT ON (candidate_type) candidate_type, definition
         FROM exploded
        WHERE definition IS NOT NULL
        ORDER BY candidate_type, generated_at DESC
     )
     SELECT
       e.candidate_type,
       COUNT(*)::int AS count,
       ld.definition AS definition,
       to_jsonb((array_remove(array_agg(DISTINCT e.evidence), NULL))[1:3]) AS evidence,
       to_jsonb(
         (array_agg(DISTINCT jsonb_build_object(
            'id', e.property_id, 'address', e.address, 'profileId', e.profile_id
          )))[1:12]
       ) AS properties
     FROM exploded e
     LEFT JOIN latest_def ld ON ld.candidate_type = e.candidate_type
     GROUP BY e.candidate_type, ld.definition
     HAVING COUNT(*) >= $1
     ORDER BY count DESC, e.candidate_type ASC
     LIMIT $2`,
    [threshold, limit],
  );

  return rows.map((r) => ({
    candidateType: r.candidate_type,
    count: Number(r.count),
    definition: r.definition ?? null,
    evidence: r.evidence ?? [],
    properties: (r.properties ?? []).map((p) => ({
      id: Number(p.id),
      address: p.address ?? null,
      profileId: p.profileId === null || p.profileId === undefined ? null : Number(p.profileId),
    })),
  }));
}
