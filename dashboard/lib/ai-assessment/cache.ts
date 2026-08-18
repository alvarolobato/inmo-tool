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
 * ## Addendum (#184, D-010): the signal comes back, derived and bucketed
 *
 * The above is still true of the RAW `price` field — it is never rendered
 * and never hashed. What changed in #184 is that `getOrCompute` gained an
 * optional `extraHashInput` parameter (and `computeAssessmentContentHash`
 * an optional `extra` parameter) so occupancy/redflags can hash a DERIVED,
 * non-listing signal alongside the listings: a bucketed zone-median price
 * comparison from `lib/analytics/area-price.ts` (#32), computed by
 * `lib/ai-assessment/price-signal.ts`. That module renders and hashes the
 * exact same string from the exact same call site, so the invalidation key
 * and the prompt can never disagree — see its doc and D-010 for the full
 * design (bucketing, silence rules, why only two flows). `condition`/
 * `extract` never pass `extraHashInput`, so their hashes are computed
 * exactly as before this parameter existed — see `extra`'s doc below.
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
import { getSystemConfig } from "@/lib/system-config/loader";

/** Every property-level assessment_type this cache wrapper understands. */
export type AssessmentType =
  | "occupancy"
  | "condition"
  | "redflags"
  | "location"
  | "opportunity"
  | "extract";

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
 *
 * ## `extra` — derived, non-listing prompt content (#184)
 *
 * Optional second input, folded into the hash material alongside `listings`
 * when given. This exists for exactly one purpose: some flows (currently
 * occupancy/redflags — see `lib/ai-assessment/price-signal.ts`) render a
 * derived string into the prompt that is NOT computed from any one listing's
 * fields (a bucketed zone-median price comparison, `lib/analytics/
 * area-price.ts` via #32). Requirement 1 of #184 is that the invalidation
 * key and the rendered prompt must always agree — the mismatch #180 fixed
 * for price, generalised — so any such content must be hashed too, not just
 * `listings`.
 *
 * Deliberately backward-compatible when `extra` is omitted: the hash for a
 * two-argument call is bit-for-bit identical to before this parameter
 * existed (`extra === undefined` hashes the bare `material` array, not a
 * wrapper object), so condition/extract — which never pass `extra` — see NO
 * hash-format churn from this change, and every pre-#184 stored
 * `content_hash` for those two assessment types remains valid.
 */
export function computeAssessmentContentHash(
  listings: ListingSnapshot[],
  extra?: string,
): string {
  const material = listings
    .map((l) => ({ id: l.listingId ?? null, d: (l.description ?? "").trim() }))
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const payload: unknown = extra === undefined ? material : { material, extra };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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
 * Raised instead of calling the LLM when this exact (property, flow, prompt
 * version, content hash) has already failed `assessment_max_failures` times.
 *
 * A distinct type so callers can tell "we deliberately did not spend money on
 * a known-bad input" apart from "the call was attempted and failed" — the
 * batch counts it separately and it must never trip the circuit breaker.
 */
export class AssessmentParkedError extends Error {
  constructor(
    readonly propertyId: number,
    readonly assessmentType: AssessmentType,
    readonly failCount: number,
    readonly lastError: string | null,
  ) {
    super(
      `Assessment parked: property=${propertyId} type=${assessmentType} ` +
        `failed ${failCount}x on unchanged input` +
        (lastError ? ` (last error: ${lastError})` : ""),
    );
    this.name = "AssessmentParkedError";
  }
}

/** How many failures on an UNCHANGED input before the flow stops being retried. */
export const DEFAULT_MAX_ASSESSMENT_FAILURES = 3;

function maxAssessmentFailures(): number {
  try {
    const raw = getSystemConfig()["dashboard.assessment_max_failures"]?.value;
    if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
      const n = Number(String(raw).trim());
      // 0 disables parking entirely (retry forever — the pre-ledger behaviour).
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
  } catch {
    // Loader unavailable (build context / schema file missing) — use the default.
  }
  return DEFAULT_MAX_ASSESSMENT_FAILURES;
}

interface FailureRow {
  fail_count: number;
  last_error: string | null;
}

/**
 * Days after which a park lapses and the input gets one more chance.
 *
 * A park is normally released by new evidence (a changed content hash) or a
 * prompt-version bump. This is the third release: a listing nobody edits, on a
 * prompt nobody bumps, would otherwise stay parked forever on the strength of
 * three failures — including three failures that happened to be caused by
 * something we have since fixed. One cheap retry a fortnight is a rounding
 * error against the 96/day it replaced.
 */
const PARK_DECAY_DAYS = 14;

/**
 * Current strike count for this exact input, or null when never failed.
 *
 * Rows whose most recent failure is older than `PARK_DECAY_DAYS` are ignored,
 * so a stale park does not outlive its cause.
 */
async function readFailure(
  propertyId: number,
  assessmentType: AssessmentType,
  promptVersion: string,
  contentHash: string,
): Promise<FailureRow | null> {
  const rows = await sql<FailureRow>(
    `SELECT fail_count, last_error
       FROM ai_assessment_failure
      WHERE property_id = $1 AND assessment_type = $2
        AND prompt_version = $3 AND content_hash = $4
        AND last_failed_at > now() - ($5 || ' days')::interval`,
    [propertyId, assessmentType, promptVersion, contentHash, String(PARK_DECAY_DAYS)],
  );
  return rows[0] ?? null;
}

/**
 * Record one failed attempt (upsert, incrementing the strike count).
 *
 * Best-effort: a bookkeeping write must never replace the real error the
 * caller is about to see, so a failure here is logged and swallowed.
 */
async function recordFailure(
  propertyId: number,
  assessmentType: AssessmentType,
  promptVersion: string,
  contentHash: string,
  err: unknown,
): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  try {
    await sql(
      `INSERT INTO ai_assessment_failure
         (property_id, assessment_type, prompt_version, content_hash, last_error)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ON CONSTRAINT ai_assessment_failure_key DO UPDATE
         SET fail_count = ai_assessment_failure.fail_count + 1,
             last_failed_at = now(),
             last_error = EXCLUDED.last_error`,
      [propertyId, assessmentType, promptVersion, contentHash, message],
    );
  } catch (writeErr) {
    console.error("[ai-assessment] failed to record assessment failure:", writeErr);
  }
}

/**
 * Clear the ledger for this flow (any hash — the flow works again).
 *
 * Called automatically after a successful run, and exported so a route can
 * honour an explicit operator override (`POST …?force=1`) — the documented
 * escape hatch from a park, see `route-errors.ts`.
 */
export async function clearAssessmentFailures(
  propertyId: number,
  assessmentType: AssessmentType,
  promptVersion: string,
): Promise<void> {
  try {
    await sql(
      `DELETE FROM ai_assessment_failure
        WHERE property_id = $1 AND assessment_type = $2 AND prompt_version = $3`,
      [propertyId, assessmentType, promptVersion],
    );
  } catch (err) {
    console.error("[ai-assessment] failed to clear assessment failures:", err);
  }
}

/**
 * Errors that are about the ENVIRONMENT, not this property's input.
 *
 * A strike is a claim that *this listing text* cannot be assessed. A budget
 * stop, an open breaker, a timeout, an expired credential or an upstream
 * 429/5xx say nothing of the kind — and striking on them is actively
 * dangerous: batch selection is `created_at ASC`, so during any sustained
 * outage the SAME head-of-queue property is struck every tick, and three
 * ticks of a bad 45 minutes would park it (the circuit breaker only opens
 * after 5 CONSECUTIVE failures and half-opens every 60s, so it does not
 * cover this on its own).
 *
 * Matched by `name`/`code` rather than `instanceof` to avoid importing
 * `lib/llm` here, which would create a cycle (llm → llm-context → …  →
 * ai-assessment). `lib/llm-usage.ts` and `lib/llm-circuit-breaker.ts` both set
 * `.name` explicitly; `cli/errors.ts` sets `.code`. Pinned by tests that
 * import the real classes.
 */
/**
 * `CliRunnerError.code` values that describe infrastructure, not content.
 *
 * Deliberately NOT here: `LLM_CLI_EMPTY`, `LLM_CLI_PARSE` and
 * `LLM_CLI_TRUNCATED` — an unparseable, empty or oversized completion IS a
 * property of this listing's text, reproduces on every retry, and is exactly
 * the poison-property case D-104 exists to stop paying for.
 */
const TRANSIENT_CLI_CODES = new Set([
  "LLM_CLI_TIMEOUT",
  "LLM_CLI_AUTH",
  "LLM_CLI_API_ERROR",
  "LLM_CLI_EXIT",
]);

function isEnvironmentalError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  // `LlmQuotaExceededError` (D-107) belongs here for the same reason as the
  // other two, and its omission was actively destructive: the cap trips for
  // EVERY property in the tick, each one takes a strike, and at the default
  // `assessment_max_failures: 3` the head-of-queue properties (selection is
  // `created_at ASC`) are PARKED PERMANENTLY after three ticks. The cap
  // self-heals in 30 minutes when the reading goes stale; the parks do not —
  // they release only on changed listing text, a prompt bump, 14 days, or a
  // manual `?force=1`. A cost guard that damages data is worse than no guard.
  if (
    name === "BudgetExceededError" ||
    name === "CircuitBreakerOpenError" ||
    name === "LlmQuotaExceededError" ||
    name === "LlmDisabledError"
  ) {
    return true;
  }

  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSIENT_CLI_CODES.has(code)) return true;

  // Upstream rate-limit / server errors, however they surface.
  const status = (err as { status?: unknown; innerErrorCode?: unknown } | null);
  for (const raw of [status?.status, status?.innerErrorCode]) {
    if (typeof raw === "number" && (raw === 429 || raw >= 500)) return true;
  }
  return false;
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
 *
 * `extraHashInput` (#184, optional): forwarded verbatim to
 * `computeAssessmentContentHash`'s `extra` parameter — see that function's
 * doc. Callers that render a derived, non-listing string into the prompt
 * (occupancy/redflags's bucketed area-price signal) MUST pass the exact same
 * string here that they passed into `FlowVars.areaPriceSignal`, from the
 * same call site, so the hash can never disagree with what the model saw.
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
  extraHashInput?: string,
): Promise<{ result: T; model: string | null; fromCache: boolean }> {
  const contentHash = computeAssessmentContentHash(listings, extraHashInput);
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

    // Cost guard: refuse to re-buy a call that has already failed N times on
    // this exact input. Checked AFTER the cache read (a hit is still free) and
    // BEFORE `computeFn` (the only place money is spent). Keyed on the content
    // hash, so new evidence unparks it automatically.
    const maxFailures = maxAssessmentFailures();
    if (maxFailures > 0) {
      const failure = await readFailure(propertyId, assessmentType, promptVersion, contentHash);
      if (failure && failure.fail_count >= maxFailures) {
        throw new AssessmentParkedError(
          propertyId,
          assessmentType,
          failure.fail_count,
          failure.last_error,
        );
      }
    }

    let result: T;
    let model: string | null;
    try {
      ({ result, model } = await computeFn());
    } catch (err) {
      // Budget/circuit stops are about the environment, not this input — they
      // must not accrue strikes, or a single budget-exhausted day would park
      // the whole backlog.
      if (!isEnvironmentalError(err)) {
        await recordFailure(propertyId, assessmentType, promptVersion, contentHash, err);
      }
      throw err;
    }

    await save(propertyId, result, model, contentHash);
    await clearAssessmentFailures(propertyId, assessmentType, promptVersion);
    return { result, model, fromCache: false };
  });
}
