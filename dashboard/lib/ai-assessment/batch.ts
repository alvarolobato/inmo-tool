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
 * ## Loop order (docs/roadmap/llm-batching-plan.md, Phase 1)
 *
 * The per-property/flow work is FLOW-MAJOR (`for flow { for property { … } }`),
 * not property-major — a pure control-flow restructure, no prompt or version
 * change. It exists as a prerequisite for a later, separate change (multi-
 * property batching, NOT built here): packing several properties into one LLM
 * call requires collecting them per flow first, which only a flow-major outer
 * loop makes possible. See the loop body below for the one semantic
 * consequence this ordering has for a mid-pass budget/circuit/quota stop.
 *
 * Server-only: transitively imports `lib/db-write` (the `pg` client). Never
 * import from a client component.
 */

import { sql } from "@/lib/db-write";
import {
  DISABLED_SOURCES_CTE,
  assessmentEligibleClause,
  selectionFlowValues,
  missingCurrentVerdictClause,
} from "./eligibility";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import { LlmQuotaExceededError } from "@/lib/llm-enabled";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";
import { getLatestAssessment, AssessmentParkedError, type AssessmentType } from "./cache";
import { NoListingsError } from "./shared";
import {
  getTrendingCandidateTypes,
  getDismissedCandidateTypes,
  type RedflagTrendingCandidate,
  type DismissedCandidate,
} from "@/lib/db/redflag-candidates";
import { assessPropertyOccupancy, OCCUPANCY_PROMPT_VERSION } from "./occupancy";
import { assessPropertyCondition, CONDITION_PROMPT_VERSION } from "./condition";
import { assessPropertyRedFlags, REDFLAGS_PROMPT_VERSION } from "./redflags";
import { assessPropertyLocation, LOCATION_PROMPT_VERSION } from "./location";
import { assessPropertyOpportunity, OPPORTUNITY_PROMPT_VERSION } from "./opportunity";
import { assessPropertyExtract, EXTRACT_PROMPT_VERSION } from "./extract";

/** One flow the batch runs, in a uniform shape so the loop is flow-agnostic. */
export interface BatchFlow {
  type: AssessmentType;
  promptVersion: string;
  /** The existing `assessProperty*` entry point — return value is ignored. */
  assess: (
    propertyId: number,
    opts?: {
      requestId?: string | null;
      ctx?: LlmAgenticContext;
      /**
       * #396 — the trending `other` candidate slugs, computed ONCE per batch
       * (below) and passed to every flow. Only redflags reads it; the others
       * accept it structurally and ignore it — the same harmless-no-op shape
       * `areaPriceSignal` already uses. Passing it to every flow keeps this
       * loop flow-agnostic.
       */
      trendingCandidates?: RedflagTrendingCandidate[];
      /**
       * #407 — the human-dismissed candidate slugs, computed ONCE per batch
       * (below) and passed to every flow. Only redflags reads it; the others
       * ignore it — same harmless-no-op shape as `trendingCandidates`.
       */
      dismissedCandidates?: DismissedCandidate[];
    },
  ) => Promise<unknown>;
}

/**
 * The six flows, in run order. Occupancy first because it is the highest-
 * value signal (issue #1 §9). `location` (#388) and `opportunity` (#398) each
 * self-gate a `terreno` plot (`locationApplies` / `opportunityApplies`) — the
 * axis doesn't apply — and are cheap in that case. `extract` is included but is
 * self-gating (`needsExtraction`) and cheap when there is nothing to fill.
 */
export const DEFAULT_BATCH_FLOWS: BatchFlow[] = [
  { type: "occupancy", promptVersion: OCCUPANCY_PROMPT_VERSION, assess: assessPropertyOccupancy },
  { type: "condition", promptVersion: CONDITION_PROMPT_VERSION, assess: assessPropertyCondition },
  { type: "redflags", promptVersion: REDFLAGS_PROMPT_VERSION, assess: assessPropertyRedFlags },
  { type: "location", promptVersion: LOCATION_PROMPT_VERSION, assess: assessPropertyLocation },
  { type: "opportunity", promptVersion: OPPORTUNITY_PROMPT_VERSION, assess: assessPropertyOpportunity },
  { type: "extract", promptVersion: EXTRACT_PROMPT_VERSION, assess: assessPropertyExtract },
];

/** Why a batch stopped early — a clean, budget-driven halt, not a crash. */
export type BatchStopReason = "budget" | "circuit" | "quota";

export interface AssessmentBatchResult {
  /** Properties examined this tick (≤ batchSize). */
  properties: number;
  /** Flow runs that actually invoked the flow (a cache-miss LLM path, or a #30 cache hit). */
  assessed: number;
  /** Flow runs skipped because a current-prompt-version verdict already existed (EC-2). */
  skipped: number;
  /** Flow runs skipped because the property had nothing to read (NoListingsError). */
  noListings: number;
  /**
   * Flow runs skipped WITHOUT spending, because this exact input has already
   * failed `dashboard.assessment_max_failures` times (AssessmentParkedError).
   * A steadily growing number here means bad inputs are being parked instead
   * of retried forever — which is the point; a large one is worth inspecting.
   */
  parked: number;
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
  // Eligibility (stage 1 + stage 2a) and the pending predicate (stage 2b) come
  // from the shared `eligibility.ts` fragments, so the cost panel's coverage
  // (`lib/db/llm-health.ts`) counts EXACTLY the population this query drains.
  const { valuesSql, params } = selectionFlowValues(1);
  const limitParam = `$${params.length + 1}`;
  const rows = await sql<{ id: string }>(
    `WITH ${DISABLED_SOURCES_CTE}
     SELECT p.id
       FROM property p
      WHERE ${assessmentEligibleClause("p")}
        AND ${missingCurrentVerdictClause("p", valuesSql)}
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
  /**
   * #666 — how many (property, flow) calls may be in flight at once WITHIN
   * one flow's round (see the worker-pool doc below). Defaults to 1, which
   * reproduces the exact serial call order/timing the pre-#666 code had —
   * every pre-existing test in `batch.test.ts` that asserts "stopped on the
   * very first call" relies on this default. Production passes the
   * scheduler's configured `dashboard.assessment_concurrency` instead.
   */
  concurrency?: number;
  /** Correlation id threaded into the flows' LLM calls / logs. */
  requestId?: string | null;
  /** Overridable seams (tests inject these; production uses the real defaults). */
  flows?: BatchFlow[];
  selectPropertyIds?: (batchSize: number) => Promise<number[]>;
  isCurrent?: (propertyId: number, flow: BatchFlow) => Promise<boolean>;
  /**
   * #396 — overridable seam for the once-per-batch trending-candidates fetch
   * (tests inject a stub; production uses `getTrendingCandidateTypes`). Threaded
   * into every flow's `assess` call, read only by redflags.
   */
  fetchTrendingCandidates?: () => Promise<RedflagTrendingCandidate[]>;
  /**
   * #407 — overridable seam for the once-per-batch dismissed-candidates fetch
   * (tests inject a stub; production uses `getDismissedCandidateTypes`).
   * Threaded into every flow's `assess` call, read only by redflags.
   */
  fetchDismissedCandidates?: () => Promise<DismissedCandidate[]>;
}

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_CONCURRENCY = 1;

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
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
  const flows = opts.flows ?? DEFAULT_BATCH_FLOWS;
  const selectPropertyIds = opts.selectPropertyIds ?? selectPropertiesNeedingAssessment;
  const isCurrent = opts.isCurrent ?? isFlowCurrent;
  const fetchTrendingCandidates =
    opts.fetchTrendingCandidates ?? getTrendingCandidateTypes;
  const fetchDismissedCandidates =
    opts.fetchDismissedCandidates ?? getDismissedCandidateTypes;
  const requestId = opts.requestId ?? null;

  const result: AssessmentBatchResult = {
    properties: 0,
    assessed: 0,
    skipped: 0,
    noListings: 0,
    parked: 0,
    errors: 0,
    stopped: null,
  };

  const propertyIds = await selectPropertyIds(batchSize);

  // #396: compute the trending `other` candidate slugs ONCE for the whole pass
  // (not per property, not per flow) and thread them into every flow's assess
  // call — only redflags renders them into its prompt. A failure here must never
  // sink the batch: the injection is pure context, so on error we fall back to
  // an empty list (the model just sees "no candidates yet").
  let trendingCandidates: RedflagTrendingCandidate[] = [];
  try {
    trendingCandidates = await fetchTrendingCandidates();
  } catch (err) {
    console.warn(
      "[ai-assessment:batch] trending-candidate fetch failed — continuing with an " +
        "empty list (redflags prompt shows no candidates this pass):",
      err,
    );
  }

  // #407: same once-per-batch treatment for the human-dismissed slugs. A failure
  // here must never sink the batch — the injection is pure context, so on error
  // we fall back to an empty list (the model just sees "nothing dismissed yet").
  let dismissedCandidates: DismissedCandidate[] = [];
  try {
    dismissedCandidates = await fetchDismissedCandidates();
  } catch (err) {
    console.warn(
      "[ai-assessment:batch] dismissed-candidate fetch failed — continuing with an " +
        "empty list (redflags prompt shows no dismissed slugs this pass):",
      err,
    );
  }

  // Phase 1 (llm-batching-plan.md): FLOW-MAJOR, not property-major. The outer
  // loop is the flow, the inner loop is the property — the reverse of the
  // original #308 shape. This exists purely as a Phase-3 prerequisite: batching
  // N properties into one LLM call (planned, not built here) requires collecting
  // N properties *for the same flow* before any call is made, which is only
  // possible if the flow is the outer loop. This PR is control-flow only — no
  // prompt, no version bump, no batching yet; every flow still runs one property
  // at a time via the existing `flow.assess(propertyId, …)` entry point.
  //
  // `properties` keeps its original meaning ("distinct properties this tick
  // actually reached, not just selected") via `touchedProperties`, a property
  // is "touched" the first time ANY flow visits it — mirroring the old
  // unconditional `result.properties += 1` at the top of the (then) outer
  // property loop, just computed from the new (then) inner loop instead.
  //
  // SEMANTIC CONSEQUENCE (deliberate, not a bug — see the Phase-1 PR body):
  // under the old property-major order, a mid-pass budget/circuit/quota stop
  // left a clean prefix of properties fully assessed (every flow) and a clean
  // suffix wholly untouched. Under flow-major, the same stop instead leaves
  // EVERY selected property assessed on the flows that ran before the stopped
  // one, and none on the flows after it — i.e. properties get assessed on
  // *some* axes and not others, rather than some properties being fully done
  // and others fully pending.
  //
  // That recovers cleanly for the three SELECTION flows and ONLY those three.
  // `missingCurrentVerdictClause` (eligibility.ts) is per-axis, but over
  // `ASSESSMENT_SELECTION_FLOWS` — occupancy, condition, redflags — not over
  // all six in `DEFAULT_BATCH_FLOWS`. Those three run first here, so once a
  // property holds current verdicts for them it is never selected again, and
  // a stop landing at or after `location` leaves `location`/`opportunity`/
  // `extract` permanently unwritten for EVERY property in the page — not just
  // the one in flight, as under the old property-major order. The blast radius
  // of that pre-existing gap therefore scales with the page size (measured:
  // 1 property -> 5 at the default batch size).
  //
  // Shipping it knowingly, because the exposure is bounded and closing:
  // stops only fire on a budget/quota/circuit halt (none configured today),
  // and Phase 2's `triage` merge makes `location`/`opportunity` ride the same
  // call as `condition` — a selection flow — which removes the orphaning by
  // construction. `extract` stays out of selection deliberately (it self-gates
  // via `needsExtraction`; selecting on its absence would re-select fully
  // structured properties forever). Tracked as F-9 / issue #542.
  //
  // Pinned by the "budget stop mid-flow" test in batch.test.ts, which is also
  // the ONLY test that fails if this loop is reverted to property-major.
  const touchedProperties = new Set<number>();

  // #666 — CONCURRENCY, added on top of the flow-major structure above, not
  // instead of it.
  //
  // Each flow's round still runs to completion (or a stop) before the NEXT
  // flow starts — flow-major order is kept for two independent reasons, not
  // just the Phase-3 batching prerequisite documented above:
  //
  //   1. It is what makes the "one bad property never turns into three
  //      strikes in a single pass" (#666 exit criterion / D-104) trivially
  //      true regardless of concurrency: the (flow, propertyId) task list
  //      handed to a round is `propertyIds` for THAT flow — already a
  //      deduplicated array with no retry-within-pass logic anywhere — so
  //      each pair is attempted AT MOST ONCE per `runAssessmentBatch` call
  //      no matter how many workers race to drain it. Concurrency changes
  //      the ORDER work completes in, never the SET of work attempted.
  //   2. D-103's CLI prompt cache keys on `--system-prompt`, which is
  //      identical for every call within one flow's round and changes
  //      between rounds. Grouping concurrent calls by flow (rather than
  //      interleaving occupancy/condition/redflags/… calls across workers)
  //      keeps every round hitting the SAME cached system prompt instead of
  //      cold-starting it on every call — see docs/decisions/D-149 for the
  //      measurement this is based on.
  //
  // WITHIN a flow's round, up to `concurrency` properties run in parallel via
  // a small worker-pool (below), not `Promise.all` over the whole array —
  // `concurrency` bounds how many `claude` CLI processes (D-106) and
  // advisory-lock-holding DB connections (cache.ts's `withAdvisoryLock`,
  // db-write.ts's pool — see D-149) are in flight at once, which is the
  // actual ceiling, not the LLM API itself (measured, D-149).
  //
  // STOP semantics under concurrency (budget/quota/circuit): the FIRST
  // stop-worthy error observed sets a round-local `stopReason` flag. Every
  // worker checks that flag before pulling its NEXT item from the queue, so
  // no NEW (flow, property) pair starts once a stop fires — but up to
  // `concurrency - 1` OTHER calls already dispatched in the same round may
  // still be in flight and are allowed to finish (not aborted; Node has no
  // cheap `claude` process cancellation, and killing a call that already
  // spent tokens buys nothing safety-wise). Those in-flight calls still
  // update `result` normally (including, rarely, setting the SAME
  // `stopReason` a second time via a same-typed error — harmless, first
  // write wins). This is a bounded, documented widening of the pre-#666
  // "stops on the very first call" guarantee — with the production default
  // concurrency the widening is at most `dashboard.assessment_concurrency`
  // extra calls, not the rest of the page.
  const stopSignal: { reason: BatchStopReason | null } = { reason: null };

  /** Process one (flow, propertyId) pair — the exact body the old loop had. */
  async function runOne(flow: BatchFlow, propertyId: number): Promise<void> {
    touchedProperties.add(propertyId);
    result.properties = touchedProperties.size;

    // EC-2: skip a flow whose verdict already matches the current prompt
    // version — no listing load, no LLM call, no spend.
    if (await isCurrent(propertyId, flow)) {
      result.skipped += 1;
      return;
    }

    try {
      await flow.assess(propertyId, { requestId, trendingCandidates, dismissedCandidates });
      result.assessed += 1;
    } catch (err) {
      // EC-3: a budget/circuit stop is a CLEAN halt of the whole batch, not
      // a crash. Record what we have so far so the caller logs and retries
      // on the next tick (by which time the daily window may have reset or
      // the breaker closed).
      if (err instanceof BudgetExceededError) {
        if (!stopSignal.reason) {
          stopSignal.reason = "budget";
          console.warn(
            `[ai-assessment:batch] daily LLM budget exhausted at property=${propertyId} ` +
              `flow=${flow.type} — stopping this pass cleanly (assessed=${result.assessed}).`,
          );
        }
        return;
      }
      // D-107: the subscription quota cap is a clean halt of the WHOLE pass,
      // exactly like a budget stop. Continuing would throw for every
      // remaining property in the page to no purpose.
      if (err instanceof LlmQuotaExceededError) {
        if (!stopSignal.reason) {
          stopSignal.reason = "quota";
          console.warn(
            `[ai-assessment:batch] subscription quota cap reached at property=${propertyId} ` +
              `flow=${flow.type} (${err.pctUsed}% of the "${err.window}" window, ` +
              `limit ${err.threshold}%) — stopping this pass cleanly ` +
              `(assessed=${result.assessed}).`,
          );
        }
        return;
      }
      if (err instanceof CircuitBreakerOpenError) {
        if (!stopSignal.reason) {
          stopSignal.reason = "circuit";
          console.warn(
            `[ai-assessment:batch] LLM circuit breaker open at property=${propertyId} ` +
              `flow=${flow.type} — stopping this pass cleanly (assessed=${result.assessed}).`,
          );
        }
        return;
      }
      // A property with no readable listings can't be assessed — skip it,
      // never let it sink the batch. (Selection filters these out, so this
      // is a race backstop.)
      if (err instanceof NoListingsError) {
        result.noListings += 1;
        return;
      }
      // Parked by the failure ledger — no LLM call was made, no money spent.
      // Logged at info, not error: this is the cost guard working, and at
      // one line per tick per parked flow it would otherwise drown the log.
      if (err instanceof AssessmentParkedError) {
        result.parked += 1;
        return;
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

  /**
   * Bounded worker pool over `propertyIds` for one flow. `concurrency`
   * workers each pull the next unclaimed index (a plain `let` increment —
   * safe because JS only interleaves at `await` points, so two workers can
   * never read-then-increment the same index) and stop early once
   * `stopSignal.reason` is set, WITHOUT starting a new pair. `Promise.all`
   * only resolves once every worker has stopped — i.e. once every pair
   * dispatched before the stop was observed has actually finished.
   */
  async function runFlowRound(flow: BatchFlow): Promise<void> {
    let nextIndex = 0;
    async function worker(): Promise<void> {
      for (;;) {
        if (stopSignal.reason) return;
        const i = nextIndex++;
        if (i >= propertyIds.length) return;
        await runOne(flow, propertyIds[i]);
      }
    }
    const workerCount = Math.min(concurrency, propertyIds.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  for (const flow of flows) {
    await runFlowRound(flow);
    if (stopSignal.reason) {
      result.stopped = stopSignal.reason;
      return result;
    }
  }

  return result;
}
