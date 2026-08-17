---
id: D-104
title: A failing assessment is parked after N strikes on an unchanged input
date: 2026-08-17
group: AI layer
rule: A CONTENT failure writes a strike to `ai_assessment_failure`, keyed on (property, flow, prompt_version, content_hash); at `dashboard.assessment_max_failures` (default 3) `getOrCompute` raises `AssessmentParkedError` INSTEAD of calling the LLM, and the POST routes map it to 409 with `?force=1` as the override. Infrastructure failures (budget, circuit, timeout, auth, 429/5xx, crash) never strike. New evidence, a prompt bump, a success, or 14 days unparks.
---

# D-104: A failing assessment is parked after N strikes on an unchanged input

*Decided: 2026-08-17*

**Context**: `runAssessmentBatch` handled a flow failure by counting `errors += 1` and moving on. Nothing was written anywhere. The property therefore still satisfied `missingCurrentVerdictClause` — the selection predicate is "has no row for this flow at the current prompt version", and a failure produces no row — so it was re-selected on the very next tick. And because selection is `ORDER BY created_at ASC`, the same oldest poison properties came back **first**, every time.

One property whose text reliably provokes unparseable model output therefore cost up to **96 paid retries per day per flow**, forever, with no backoff, no cap, and no record that it was happening. The circuit breaker does not help: parse failures are deliberately classified as application errors that never trip it (`llm-circuit-breaker.ts`). Before [D-102](D-102-llm-usage-metered-and-capped.md) the spend was also invisible.

**Decision**:

- A new table `ai_assessment_failure` records `(property_id, assessment_type, prompt_version, content_hash)` → `fail_count`, `first_failed_at`, `last_failed_at`, `last_error`.
- The strike is recorded and enforced inside `getOrCompute` (`ai-assessment/cache.ts`), not in the batch loop: that is where the content hash already exists, it wraps the only place money is spent, and it therefore protects **every** caller — the scheduler and the `POST /api/properties/[id]/assessments/*` routes alike — rather than one loop.
- At `fail_count >= dashboard.assessment_max_failures` (default 3, `0` disables), `getOrCompute` raises `AssessmentParkedError` **before** calling `computeFn`. The batch counts it as `parked`, distinct from `errors`.
- **The park is keyed on the content hash**, so it releases itself the moment the evidence changes — a new or edited listing produces a different hash and gets a fresh chance, exactly like a cache miss. A prompt-version bump writes a different key too, so fixing the prompt retries automatically with no operator action.
- **Only CONTENT failures strike.** A strike asserts "this listing's text cannot be assessed", so anything about the environment is exempt: budget stops, an open breaker, `LLM_CLI_TIMEOUT`, `LLM_CLI_AUTH`, `LLM_CLI_API_ERROR`, `LLM_CLI_EXIT`, and any upstream 429/5xx. This is not a nicety — batch selection is `created_at ASC`, so during an outage the *same* head-of-queue property is retried every tick, and three ticks of a bad 45 minutes would otherwise park it. `LLM_CLI_EMPTY`, `LLM_CLI_PARSE` and `LLM_CLI_TRUNCATED` *do* strike: those reproduce on every retry and are the case this exists for.
- A successful run deletes the flow's ledger rows, so a recovered flow is never parked by stale strikes.
- **A park lapses after 14 days** (`PARK_DECAY_DAYS`). A listing nobody edits, on a prompt nobody bumps, would otherwise stay parked forever on the strength of three failures whose cause we may since have fixed. One retry a fortnight is a rounding error against the 96/day it replaced.
- **The POST routes map it to 409**, not 500, with the failure count and last error in the message, and `?force=1` on the same endpoint clears the ledger and retries. Enforcing in `getOrCompute` protects those routes from spending, but without this mapping it also broke them: "Evaluar" on a parked property returned an opaque 500 with no way out.

**Alternatives rejected**:

- *Time-based backoff as the PRIMARY mechanism (retry after an hour, then a day).* Time is the wrong first axis: nothing about a poisoned listing description improves by waiting, and a timer keeps re-buying the same failure forever, just more slowly. Evidence change is the signal that matters, and the content hash already expresses it. Time appears only as the 14-day backstop above, for the case where no other release ever fires.
- *Write a sentinel `ai_assessment` row on failure.* It would satisfy the selection predicate and stop the retries, but it would also make a failure look like a verdict to every reader (`loadFlags`, the card badges, the coverage panel).
- *Park in the batch loop.* Leaves the POST endpoints unprotected and duplicates the hash computation.

**Rationale**: The cost guard belongs next to the only line that spends money, and the invalidation key that already answers "is this the same input?" is the right key for "have we already failed on this input?". Parked flows are counted per tick and the ledger carries `last_error`, so this bounds the spend without hiding the problem.

**Still missing (follow-up)**: nothing surfaces a park to the operator except the scheduler's `parked=N` log line and the 409 itself — no count on `/etl/salud`, no list of what has been given up on. Filed in the roadmap doc; the ledger's `last_failed_at DESC` index exists for it.

**See**: `dashboard/lib/ai-assessment/cache.ts` (`AssessmentParkedError`, `readFailure`/`recordFailure`/`clearAssessmentFailures`, `isEnvironmentalError`, `PARK_DECAY_DAYS`), `dashboard/lib/ai-assessment/route-errors.ts`, `dashboard/lib/ai-assessment/batch.ts`, `etl/schema/init.sql` (`ai_assessment_failure`), `config/schema.yaml` (`dashboard.assessment_max_failures`), [docs/roadmap/llm-cost-optimization.md](../roadmap/llm-cost-optimization.md).
