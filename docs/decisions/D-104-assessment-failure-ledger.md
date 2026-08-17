---
id: D-104
title: A failing assessment is parked after N strikes on an unchanged input
date: 2026-08-17
group: AI layer
rule: A non-environmental assessment failure writes a strike to `ai_assessment_failure`, keyed on (property, flow, prompt_version, content_hash); at `dashboard.assessment_max_failures` (default 3) `getOrCompute` raises `AssessmentParkedError` INSTEAD of calling the LLM. Budget/circuit errors never strike. New evidence or a prompt-version bump unparks automatically; a success clears the ledger.
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
- **Budget and circuit-breaker errors never strike.** They are facts about the environment, not about this property's input; striking on them would let one budget-exhausted day park the entire backlog permanently.
- A successful run deletes the flow's ledger rows, so a recovered flow is never parked by stale strikes.

**Alternatives rejected**:

- *Time-based backoff (retry after an hour, then a day).* Time is the wrong axis: nothing about a poisoned listing description improves by waiting, and a timer keeps re-buying the same failure forever, just more slowly. Evidence change is the signal that matters, and the content hash already expresses it.
- *Write a sentinel `ai_assessment` row on failure.* It would satisfy the selection predicate and stop the retries, but it would also make a failure look like a verdict to every reader (`loadFlags`, the card badges, the coverage panel).
- *Park in the batch loop.* Leaves the POST endpoints unprotected and duplicates the hash computation.

**Rationale**: The cost guard belongs next to the only line that spends money, and the invalidation key that already answers "is this the same input?" is the right key for "have we already failed on this input?". Parked flows are counted per tick and the ledger carries `last_error`, so this bounds the spend without hiding the problem.

**See**: `dashboard/lib/ai-assessment/cache.ts` (`AssessmentParkedError`, `readFailure`/`recordFailure`/`clearFailures`), `dashboard/lib/ai-assessment/batch.ts`, `etl/schema/init.sql` (`ai_assessment_failure`), `config/schema.yaml` (`dashboard.assessment_max_failures`), [docs/roadmap/llm-cost-optimization.md](../roadmap/llm-cost-optimization.md).
