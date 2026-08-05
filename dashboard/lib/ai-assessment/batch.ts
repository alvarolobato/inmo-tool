/**
 * #308 — the missing TRIGGER for the AI-assessment flows.
 *
 * #25/#26/#27/#28 built four property-level assessment flows
 * (`assessProperty{Occupancy,Condition,RedFlags,Extract}`), #30 cached them,
 * #184 wired the below-market price signal into two of them, and
 * `lib/candidates.ts` + `CandidateCard.tsx` already render their verdicts as
 * badges. But NOTHING ever called them: the only entry point was
 * `POST /api/properties/[id]/assessments/*`, which has zero callers anywhere.
 * The investor therefore never saw an occupancy / condition / red-flag /
 * below-market badge, despite fully-built, tested machinery producing them.
 *
 * This module is the caller. It adds NO new AI logic, NO new prompt, NO new
 * schema — it selects ingested properties that lack a current-prompt-version
 * verdict and runs the existing flows for a bounded batch of them. The
 * `scheduler.ts` sibling calls `runAssessmentBatch()` on an interval (started
 * from `instrumentation.ts`); see D-052 for why the trigger lives dashboard-
 * side rather than in the Python ETL orchestrator.
 *
 * ## Budget-safety and idempotency (issue #308 EC-2 / EC-3)
 *
 *  - **Bounded**: at most `batchSize` properties per call, oldest-ingested
 *    first (`property.created_at ASC`). Never a full-history backfill.
 *  - **Idempotent**: the selection query only returns properties MISSING a
 *    current-prompt-version row for at least one flow, and each flow is
 *    re-checked with `getLatestAssessment(...).stale === false` before it
 *    runs — a property whose verdict already matches the current prompt
 *    version is skipped, never re-billed (EC-2). The flows' own #30 cache is
 *    a second, content-hash-level backstop underneath this.
 *  - **Fail-safe**: a `BudgetExceededError` / `CircuitBreakerOpenError`
 *    (raised by `lib/llm.ts`'s `checkDailyBudget()` / circuit breaker, which
 *    is exactly the safety this task reuses rather than reinvents) stops the
 *    batch CLEANLY mid-run — the tick returns a summary, it does not crash the
 *    host process (EC-3). A `NoListingsError` or any other per-property error
 *    is logged and skipped so one bad property never sinks the whole batch.
 *
 * Server-only: transitively imports `lib/db-write` (the `pg` client). Never
 * import from a client component.
 */

import { sql } from "@/lib/db-write";
import { DISABLED_SOURCES_CTE, activeSourceClause } from "@/lib/db/source-active";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";
import { getLatestAssessment, type AssessmentType } from "./cache";
import { NoListingsError } from "./shared";
import { assessPropertyOccupancy, OCCUPANCY_PROMPT_VERSION } from "./occupancy";
import { assessPropertyCondition, CONDITION_PROMPT_VERSION } from "./condition";
import { assessPropertyRedFlags, REDFLAGS_PROMPT_VERSION } from "./redflags";
import { assessPropertyExtract, EXTRACT_PROMPT_VERSION } from "./extract";

/** One flow the batch runs, in a uniform shape so the loop is flow-agnostic. */
export interface BatchFlow {
  type: AssessmentType;
  promptVersion: string;
  /** The existing `assessProperty*` entry point — return value is ignored. */
  assess: (
    propertyId: number,
    opts?: { requestId?: string | null; ctx?: LlmAgenticContext },
  ) => Promise<unknown>;
}

/**
 * The four flows, in run order. Occupancy first because it is the highest-
 * value signal (issue #1 §9). `extract` is included but is self-gating
 * (`needsExtraction`) and cheap when there is nothing to fill.
 */
export const DEFAULT_BATCH_FLOWS: BatchFlow[] = [
  { type: "occupancy", promptVersion: OCCUPANCY_PROMPT_VERSION, assess: assessPropertyOccupancy },
  { type: "condition", promptVersion: CONDITION_PROMPT_VERSION, assess: assessPropertyCondition },
  { type: "redflags", promptVersion: REDFLAGS_PROMPT_VERSION, assess: assessPropertyRedFlags },
  { type: "extract", promptVersion: EXTRACT_PROMPT_VERSION, assess: assessPropertyExtract },
];

/**
 * The three flows whose ABSENCE drives selection. Deliberately excludes
 * `extract`: a property that already has every structured field never gets an
 * `extract` row (the flow self-gates via `needsExtraction`), so keying
 * selection on a missing `extract` row would re-select the same fully-
 * structured properties every tick forever. Occupancy/condition/redflags
 * always produce a row, so once all three are current the property drops out
 * of selection and stops consuming a batch slot. `extract` still runs
 * opportunistically for any property selected on one of these three — it gets
 * exactly one attempt, alongside the property's initial assessment.
 */
const SELECTION_FLOWS: Array<{ type: AssessmentType; promptVersion: string }> =
  DEFAULT_BATCH_FLOWS.filter((f) => f.type !== "extract").map((f) => ({
    type: f.type,
    promptVersion: f.promptVersion,
  }));

/** Why a batch stopped early — a clean, budget-driven halt, not a crash. */
export type BatchStopReason = "budget" | "circuit";

export interface AssessmentBatchResult {
  /** Properties examined this tick (≤ batchSize). */
  properties: number;
  /** Flow runs that actually invoked the flow (a cache-miss LLM path, or a #30 cache hit). */
  assessed: number;
  /** Flow runs skipped because a current-prompt-version verdict already existed (EC-2). */
  skipped: number;
  /** Flow runs skipped because the property had nothing to read (NoListingsError). */
  noListings: number;
  /** Flow runs that raised an unexpected error (logged, non-fatal). */
  errors: number;
  /** Set when a budget/circuit error stopped the batch mid-run (EC-3); null on a clean full pass. */
  stopped: BatchStopReason | null;
}

/**
 * Property IDs that still need at least one of the selection flows, oldest
 * ingested first, bounded to `batchSize`.
 *
 * ## Two-stage filter (issue #326)
 *
 * The LLM assessment is expensive, and capture is deliberately broad (a whole
 * province via a Cimenta2 sitemap, a wide crawl) — most ingested properties
 * match no profile and the investor never sees them, so assessing them wastes
 * LLM calls (and €). Selection is therefore gated in two stages:
 *
 *  - **Stage 1 (cheap, SQL):** a property is eligible ONLY if it is a matched
 *    candidate of at least one ACTIVE (non-archived) profile — a row in
 *    `profile_listing_state` with `matched = true` whose `search_profile` is
 *    not archived. Materialization already computed that row respecting each
 *    profile's full scope (geography / price / type / rooms / hard-exclusions),
 *    so "would the investor ever see this?" is answered by a single EXISTS, not
 *    re-derived here. A new listing becomes eligible the moment it matches a
 *    profile (works with #285 self-healing rematerialize).
 *  - **Stage 2 (the existing gate):** among stage-1 survivors, keep only those
 *    with at least one ACTIVE listing carrying a non-empty description from a
 *    non-disabled source (`loadPropertyListings` would return `[]` →
 *    `NoListingsError` otherwise) that still lack a current-prompt-version
 *    verdict for at least one selection flow.
 *
 * Disabled-source hiding (#322 / D-055): the described-active-listing gate
 * requires `activeSourceClause` too, so a candidate whose only active listings
 * come from a switched-off connector is not assessed — matching the candidate
 * feed, which hides those listings entirely.
 */
export async function selectPropertiesNeedingAssessment(
  batchSize: number,
): Promise<number[]> {
  if (batchSize <= 0) return [];
  const values = SELECTION_FLOWS.map((_f, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
  const params: string[] = SELECTION_FLOWS.flatMap((f) => [f.type, f.promptVersion]);
  const limitParam = `$${params.length + 1}`;
  const rows = await sql<{ id: string }>(
    `WITH ${DISABLED_SOURCES_CTE}
     SELECT p.id
       FROM property p
      WHERE EXISTS (
              -- Stage 1: matched candidate of at least one ACTIVE profile.
              SELECT 1
                FROM profile_listing_state pls
                JOIN search_profile sp ON sp.id = pls.profile_id
               WHERE pls.property_id = p.id
                 AND pls.matched = true
                 AND sp.archived_at IS NULL
            )
        AND EXISTS (
              -- Stage 2a: something readable exists, from an ACTIVE source.
              SELECT 1 FROM listing l
               WHERE l.property_id = p.id
                 AND l.status = 'active'
                 AND COALESCE(TRIM(l.description), '') <> ''
                 AND ${activeSourceClause("l")}
            )
        AND EXISTS (
              -- Stage 2b: at least one selection flow lacks a current verdict.
              SELECT 1
                FROM (VALUES ${values}) AS f(atype, ver)
               WHERE NOT EXISTS (
                       SELECT 1 FROM ai_assessment a
                        WHERE a.property_id = p.id
                          AND a.assessment_type = f.atype
                          AND a.prompt_version = f.ver
                     )
            )
      ORDER BY p.created_at ASC, p.id ASC
      LIMIT ${limitParam}`,
    [...params, String(batchSize)],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * True when the property already has a verdict for this flow under the CURRENT
 * prompt version — the EC-2 skip seam. Reuses `cache.ts`'s `getLatestAssessment`
 * (its `stale` flag is exactly "the latest row's prompt_version isn't current"),
 * so "skip an already-current property" is decided by the same staleness logic
 * the flows and the card UI already share, never a parallel check.
 */
export async function isFlowCurrent(
  propertyId: number,
  flow: { type: AssessmentType; promptVersion: string },
): Promise<boolean> {
  const cached = await getLatestAssessment(propertyId, flow.type, flow.promptVersion);
  return cached !== null && !cached.stale;
}

export interface RunAssessmentBatchOptions {
  /** Max properties to process this tick. */
  batchSize?: number;
  /** Correlation id threaded into the flows' LLM calls / logs. */
  requestId?: string | null;
  /** Overridable seams (tests inject these; production uses the real defaults). */
  flows?: BatchFlow[];
  selectPropertyIds?: (batchSize: number) => Promise<number[]>;
  isCurrent?: (propertyId: number, flow: BatchFlow) => Promise<boolean>;
}

const DEFAULT_BATCH_SIZE = 5;

/**
 * Run one bounded assessment pass. Safe to call repeatedly and concurrently:
 * the selection query and each flow's #30 advisory-locked cache make a re-run
 * over unchanged data a no-op with no wasted LLM spend.
 *
 * Never throws for a budget/circuit stop or a per-property failure — those are
 * reported in the returned summary (`stopped`, `errors`, `noListings`) so the
 * scheduler tick can log a line and move on rather than crash the process.
 * Only a truly unexpected failure in the selection query itself propagates.
 */
export async function runAssessmentBatch(
  opts: RunAssessmentBatchOptions = {},
): Promise<AssessmentBatchResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const flows = opts.flows ?? DEFAULT_BATCH_FLOWS;
  const selectPropertyIds = opts.selectPropertyIds ?? selectPropertiesNeedingAssessment;
  const isCurrent = opts.isCurrent ?? isFlowCurrent;
  const requestId = opts.requestId ?? null;

  const result: AssessmentBatchResult = {
    properties: 0,
    assessed: 0,
    skipped: 0,
    noListings: 0,
    errors: 0,
    stopped: null,
  };

  const propertyIds = await selectPropertyIds(batchSize);

  for (const propertyId of propertyIds) {
    result.properties += 1;
    for (const flow of flows) {
      // EC-2: skip a flow whose verdict already matches the current prompt
      // version — no listing load, no LLM call, no spend.
      if (await isCurrent(propertyId, flow)) {
        result.skipped += 1;
        continue;
      }

      try {
        await flow.assess(propertyId, { requestId });
        result.assessed += 1;
      } catch (err) {
        // EC-3: a budget/circuit stop is a CLEAN halt of the whole batch, not
        // a crash. Return what we have so far so the caller logs and retries
        // on the next tick (by which time the daily window may have reset or
        // the breaker closed).
        if (err instanceof BudgetExceededError) {
          result.stopped = "budget";
          console.warn(
            `[ai-assessment:batch] daily LLM budget exhausted at property=${propertyId} ` +
              `flow=${flow.type} — stopping this pass cleanly (assessed=${result.assessed}).`,
          );
          return result;
        }
        if (err instanceof CircuitBreakerOpenError) {
          result.stopped = "circuit";
          console.warn(
            `[ai-assessment:batch] LLM circuit breaker open at property=${propertyId} ` +
              `flow=${flow.type} — stopping this pass cleanly (assessed=${result.assessed}).`,
          );
          return result;
        }
        // A property with no readable listings can't be assessed — skip it,
        // never let it sink the batch. (Selection filters these out, so this
        // is a race backstop.)
        if (err instanceof NoListingsError) {
          result.noListings += 1;
          continue;
        }
        // Any other per-property/flow failure (malformed model output, a
        // transient DB blip): log and carry on with the next flow/property.
        result.errors += 1;
        console.error(
          `[ai-assessment:batch] property=${propertyId} flow=${flow.type} failed:`,
          err,
        );
      }
    }
  }

  return result;
}
