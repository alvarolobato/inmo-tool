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
 * ## Corrected: what the model is actually shown (#30 review, must-fix 1)
 *
 * An earlier version of this doc justified excluding price/m²/rooms/baths/
 * floor/photo-count from the hash by claiming "none of those are shown to
 * the model by `propertyVolatile()`". **That was false** — `formatListing`
 * (`llm-context/system-prompt.ts`) emitted every one of them, so a price cut,
 * a photo added, or a connector filling in `rooms` changed what the model
 * read while leaving the hash — and therefore the cached verdict — untouched.
 * For occupancy/redflags that meant a stale verdict surviving a price change
 * that is itself a canonical red-flag signal; for extract it meant an
 * extraction the flow will now never refresh, because the very fields it
 * exists to fill are the ones silently excluded from invalidation.
 *
 * Issue #30's EC-3 is explicit and binding: "a connector update that only
 * changes `current_price` does NOT invalidate" — so the *hash exclusion* is
 * issue-sanctioned, not a bug. The bug was that the code showed the model an
 * input the invalidation key ignores. Two resolutions were available: (a)
 * stop showing the model the excluded fields, or (b) extend the hash to
 * cover them. (b) is foreclosed by EC-3 for price specifically (a real test,
 * `cache.test.ts`'s `"content-hash invalidation is field-scoped"`, pins price
 * to NOT invalidate) — so this fix takes (a): `formatListing` now takes a
 * `hashCoveredOnly` flag, and every property-level (cached) flow's
 * `propertyVolatile()` passes it. With it set, only fields whose changes
 * `computeAssessmentContentHash` actually tracks — listing id, portal,
 * operation, property type, description, plus static location/build fields
 * that were already visible to `loadPropertyListings` and are not flagged as
 * connector-mutable — are rendered; price, m² built/useful, rooms,
 * bathrooms, floor, and photo count are omitted outright. The model
 * genuinely cannot read what the hash cannot see, so "the hash ignores X" and
 * "the prompt doesn't show X" are now the same fact instead of one being a
 * claim about the other. `buildComparePrompt` (#38, never cached) keeps
 * calling `formatListing` without the flag — full fields, as before — since
 * nothing there is gated by this cache.
 *
 * Occupancy's prompt used to name price explicitly as an occupancy signal
 * ("precio muy por debajo de mercado sin explicación") — removed from
 * `buildOccupancyPrompt` for the same reason: instructing the model to weigh
 * a field it is no longer shown would be actively misleading.
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
 *
 * ## Stampede guard (#30 review, "also fix")
 *
 * Confirmed empirically: two concurrent `getOrCompute` calls for the same
 * `(propertyId, assessmentType)` both missed and both called the LLM — a
 * plain read-then-write with no lock in between has no way to notice the
 * other request is already mid-flight. `getOrCompute` now serializes on a
 * Postgres session-level advisory lock keyed on exactly that pair (see
 * `withAdvisoryLock`), held for the FULL duration of the check-compute-save
 * cycle, so a second caller blocks until the first has both computed AND
 * persisted, then takes the fast cache-hit path instead of also calling the
 * LLM. A double-click no longer doubles spend.
 */

import { sql, getPool } from "@/lib/db-write";
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
 * photo_urls, and every other listing/property column — issue #30 EC-3
 * requires it for price specifically ("a connector update that only changes
 * `current_price` does NOT invalidate"), generalised here to every field in
 * that category. This is now true BY CONSTRUCTION, not by claim:
 * `system-prompt.ts`'s `formatListing(..., { hashCoveredOnly: true })` —
 * what every cached flow's `propertyVolatile()` renders — omits precisely
 * these fields, so there is no field left that the model can see and this
 * hash can't. See this file's module doc, "Corrected: what the model is
 * actually shown", for the full history of why that wasn't true before.
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
 * Serializes concurrent `getOrCompute` calls for the same `key` on a
 * Postgres session-level advisory lock (#30 review, stampede fix).
 *
 * Deliberately `pg_advisory_lock`/`pg_advisory_unlock` on a DEDICATED client
 * held for the full duration of `fn` — not `pg_advisory_xact_lock` inside a
 * `BEGIN`/`COMMIT` — because `fn` here spans an LLM network call that can run
 * many seconds, and holding a transaction open (idle-in-transaction) for
 * that long risks table/index bloat on `ai_assessment` for every concurrent
 * caller, which is worse than one held connection doing nothing but holding
 * a lock. `hashtext()` folds the string key to a 32-bit int; cast to bigint
 * for the single-argument overload of `pg_advisory_lock`. `hashtext` is a
 * pure function of its input, so the lock/unlock calls always agree on the
 * key even though they're computed twice.
 */
async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", [key]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [key]);
    }
  } finally {
    client.release();
  }
}

/**
 * Cost-visibility log line (#30 review, "also fix": `fromCache` was computed
 * by `getOrCompute` and then discarded by all four `assessProperty*`
 * callers — for a cost-control feature, "did this POST spend money" is the
 * one number worth knowing per call). Every flow's `assessProperty*` calls
 * this right after `getOrCompute` returns, so grepping `[ai-assessment]` in
 * the server log gives cache-hit-rate/spend visibility without instrumenting
 * four call sites by hand or changing any of their return shapes (which
 * several integration tests destructure directly, e.g.
 * `result.condition`/`outcome.result.rooms`).
 */
export function logCacheOutcome(
  assessmentType: AssessmentType,
  propertyId: number,
  fromCache: boolean,
): void {
  // eslint-disable-next-line no-console
  console.log(
    `[ai-assessment] property=${propertyId} type=${assessmentType} from_cache=${fromCache}`,
  );
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
 *
 * The whole check-compute-save cycle runs inside `withAdvisoryLock`, keyed
 * on `(propertyId, assessmentType)`, so two concurrent calls for the same key
 * can't both observe a miss and both call the LLM (#30 review, confirmed
 * empirically) — the second blocks until the first has saved, then hits.
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
  const lockKey = `ai_assessment:${propertyId}:${assessmentType}`;

  return withAdvisoryLock(lockKey, async () => {
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
  });
}
