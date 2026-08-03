/**
 * Shared caching/invalidation layer for property-level assessment flows (#30).
 *
 * #25/#26/#27 shipped with NO cache check at all: every `POST
 * /api/properties/[id]/assessments/*` unconditionally called the LLM, even
 * when re-invoked for a property whose evidence had not changed since the
 * last verdict. This module is the wrapper `assessProperty*()` in
 * occupancy.ts/condition.ts/redflags.ts/extract.ts goes through instead, so
 * the skip-if-unchanged decision is made once, here, rather than reimplemented
 * per flow.
 *
 * ## What invalidates an assessment (the design question issue #30 asks)
 *
 * Every property-level flow's real input is "every live listing's
 * description, read together" (loadPropertyListings, shared.ts). So the right
 * invalidation signal is a hash of exactly that: `(listing_id, description)`
 * pairs for every currently-active listing of the property, order-independent
 * (sorted by id before hashing).
 *
 * That one hash, recomputed fresh from the DB on every read, transparently
 * covers every trigger the issue lists, with NO event hook anywhere:
 *
 *   - a listing's description changing        → its pair changes  → miss
 *   - a new listing joining the property       → the SET changes  → miss
 *     (this is what a dedup merge IS, mechanically: previously-separate
 *     listings start resolving to the same `property_id`, so the very next
 *     `loadPropertyListings()` for that property returns a bigger set than
 *     the hash on file was computed over)
 *   - a listing leaving (withdrawn, re-split)  → the SET changes  → miss
 *   - a price change, a `last_seen_at` bump, a status flip between two
 *     non-`active` states, a photo added        → NOT in the hash → HIT
 *     (deliberately: none of these are read by occupancy/condition/redflags/
 *     extract's prompts, so recomputing on them would only burn budget)
 *
 * This is why there is no hook into `etl/orchestrator.py` here (and #30's own
 * "eager vs. lazy" question is answered as **lazy**, per the issue's own
 * recommendation): recomputation happens the next time something calls
 * `getOrCompute` for that property (i.e. the next POST), not the moment a
 * connector sync writes a new description. The orchestrator and connectors
 * are explicitly another workstream's surface for this change; a
 * content-hash comparison computed on read sidesteps needing to touch them
 * at all, which is a feature of this design, not a limitation of it.
 *
 * ## `prompt_version` (the versioning question)
 *
 * A prompt/schema change bumps the flow's `*_PROMPT_VERSION` constant, which
 * is part of `ai_assessment`'s UNIQUE key (property_id, assessment_type,
 * prompt_version) — a bump therefore always produces a cache MISS (a
 * differently-versioned row never satisfies `getOrCompute`'s "matches
 * CURRENT version" check) and a fresh INSERT, never a collision with the row
 * the old prompt produced. The old row is left in place, not deleted — see
 * `getLatestAssessment`'s doc for what "stays visible, but marked stale" means
 * for a row nobody has refreshed since a version bump.
 */

import { sql } from "@/lib/db-write";
import { createHash } from "node:crypto";
import type { ListingSnapshot } from "@/lib/llm-context";

/** Every property-level assessment_type this cache wrapper understands. */
export type AssessmentType = "occupancy" | "condition" | "redflags" | "extract";

/**
 * Deterministic content hash over exactly the fields occupancy/condition/
 * redflags/extract's prompts actually read: each live listing's id (so the
 * SET of listings is part of the hash, not just their text) and description.
 *
 * Deliberately excludes price, status transitions between non-active states,
 * photo_urls, and every other listing/property column — none of those are
 * shown to the model by `propertyVolatile()` (system-prompt.ts), so including
 * them would invalidate on changes the flows never actually see (issue #30
 * EC-3's explicit "a connector update that only changes `current_price` does
 * NOT invalidate" requirement).
 *
 * Sorted by listing id before hashing so the hash is independent of the
 * (newest-first) order `loadPropertyListings` returns rows in — that order
 * matters to the model (recency as a tie-break signal) but must NOT matter to
 * whether two reads of the same underlying set hash identically.
 */
export function computeAssessmentContentHash(listings: ListingSnapshot[]): string {
  const material = listings
    .map((l) => ({ id: l.listingId ?? null, d: (l.description ?? "").trim() }))
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/** Raw row shape as `ai_assessment` actually stores it. */
interface RawAssessmentRow<T> {
  result: T;
  model: string | null;
  generated_at: string | null;
  prompt_version: string | null;
  content_hash: string | null;
}

export interface CachedAssessment<T> {
  result: T;
  model: string | null;
  generated_at: string | null;
  prompt_version: string | null;
  content_hash: string | null;
  /**
   * True when this row's `prompt_version` is not the flow's CURRENT version.
   *
   * This is the fix for the skew the issue calls out: "the UI shows the
   * latest row per axis [lib/candidates.ts's `loadFlags`, DISTINCT ON
   * (property_id, assessment_type) with no prompt_version filter] while the
   * API filters by *current* version [the old getXAssessment, which did
   * `AND prompt_version = $CURRENT`], so a bump makes a card show a v1 badge
   * while the endpoint 404s." `getLatestAssessment` below now selects latest-
   * per-axis exactly like `loadFlags` does — no version filter — so GET never
   * 404s just because a prompt version moved on. `stale` carries the
   * information the old 404 used to (silently) throw away: "this verdict was
   * generated under a prompt version that is no longer current," so a
   * consumer can render it distinctly (e.g. a "verdict may be outdated"
   * badge) instead of passing it off as fresh.
   */
  stale: boolean;
}

/**
 * Latest row for (property_id, assessment_type), regardless of prompt
 * version — mirrors `lib/candidates.ts`'s `loadFlags` query shape exactly
 * (`DISTINCT ON (property_id, assessment_type) ... ORDER BY generated_at DESC,
 * id DESC`, hard-won rule from #156's review: without it, a prompt-version
 * bump renders old and new verdicts side by side instead of one winner).
 */
export async function getLatestAssessment<T>(
  propertyId: number,
  assessmentType: AssessmentType,
  currentPromptVersion: string,
): Promise<CachedAssessment<T> | null> {
  const rows = await sql<RawAssessmentRow<T>>(
    `SELECT DISTINCT ON (property_id, assessment_type)
            result, model, generated_at, prompt_version, content_hash
       FROM ai_assessment
      WHERE property_id = $1 AND assessment_type = $2
      ORDER BY property_id, assessment_type, generated_at DESC NULLS LAST, id DESC`,
    [propertyId, assessmentType],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, stale: row.prompt_version !== currentPromptVersion };
}

/**
 * The #30 wrapper: check cache, call the LLM only on a genuine miss.
 *
 * A HIT requires ALL of:
 *   - a row exists for (property_id, assessment_type);
 *   - its `prompt_version` equals `promptVersion` (a version bump is always a
 *     miss — EC-2);
 *   - its `content_hash` is non-null AND equals the hash of `listings` as
 *     passed in (a row written before this migration has `content_hash IS
 *     NULL` and is therefore always a miss once — recomputing once for
 *     pre-existing rows is the correct, conservative behaviour: we cannot
 *     know what they were computed from).
 *
 * On a miss, `computeFn` runs (the real LLM call), then `save` persists the
 * result together with the freshly computed hash — so the NEXT call for the
 * same unchanged property is a hit.
 */
export async function getOrCompute<T>(
  propertyId: number,
  assessmentType: AssessmentType,
  promptVersion: string,
  listings: ListingSnapshot[],
  computeFn: () => Promise<{ result: T; model: string | null }>,
  save: (
    propertyId: number,
    result: T,
    model: string | null,
    contentHash: string,
  ) => Promise<void>,
): Promise<{ result: T; model: string | null; fromCache: boolean }> {
  const contentHash = computeAssessmentContentHash(listings);
  const cached = await getLatestAssessment<T>(propertyId, assessmentType, promptVersion);

  if (
    cached &&
    !cached.stale &&
    cached.content_hash !== null &&
    cached.content_hash === contentHash
  ) {
    return { result: cached.result, model: cached.model, fromCache: true };
  }

  const { result, model } = await computeFn();
  await save(propertyId, result, model, contentHash);
  return { result, model, fromCache: false };
}
