---
id: D-149
title: AI-assessment batch — bounded per-flow concurrency + adaptive duty cycle
date: 2026-08-21
group: AI layer
rule: "AI-assessment batch gets bounded per-flow concurrency (8), its own advisory-lock pool, a parked-flow-aware selection query, and a scheduler that drains fast only on real progress."
---

# D-149: AI-assessment batch — bounded per-flow concurrency + adaptive duty cycle

*Decided: 2026-08-21*

**Context**: Issue #666. `runAssessmentBatch` (`dashboard/lib/ai-assessment/batch.ts`)
ran two nested serial loops — 30 sequential LLM calls per pass at the default
`batchSize=5` (5 properties × 6 flows) — and `startAssessmentScheduler`
(`scheduler.ts`) used a fixed `setInterval`, so a pass that finished in well
under a minute still left the scheduler idle for most of every 15-minute
window with a real backlog (1,310 unassessed properties measured in
production) sitting behind it. The owner's account is a Claude Max
subscription: cost is explicitly not the constraint — wall-clock time and the
D-107 subscription-quota cap are the only real ceilings, and the ask was
explicitly to go faster, not cheaper.

A first version of this decision shipped with a real bug (a fresh-context
Opus review caught it, reproduced against real Postgres — see "What the
review found and fixed" below) and an overstated measurement (a single-wave
benchmark that flattered high concurrency). Both are corrected here; the
numbers and defaults below are the corrected ones.

## The measurement (corrected methodology)

`dashboard/scripts/bench-assessment-concurrency.ts` (kept, re-runnable) runs
the REAL `runAssessmentBatch()` end to end — real Postgres selection/cache/
failure-ledger code, the real `assessPropertyOccupancy` flow, the real
`claude` CLI backend (`DASHBOARD_LLM_PROVIDER=cli`) — against synthetic
(never-scraped) listing text on a throwaway database.

**The methodology matters**: `workerCount = Math.min(concurrency,
propertyIds.length)`, so a run with `n ≈ concurrency` is a SINGLE wave whose
wall clock is just `max(call latency)` — no queueing tail, and it flatters
high concurrency. The review caught exactly this in the first version
(`--n 6 --concurrency 4`, `--n 8 --concurrency 8`, …, always one wave).
Corrected to `n ≫ concurrency` (24 properties, several waves per level):

| concurrency | properties (n) | waves | assessments/hour | speedup vs. serial |
|---|---|---|---|---|
| 1 (old, always-serial) | 16 | 16 | 201 | 1.0x |
| 4 | 24 | 6 | 641 | 3.19x |
| 8 | 24 | 3 | 1,196 | 5.95x |
| 10 | 24 | 3 | 1,257 | 6.25x |
| 12 | 24 | 2 | 1,427 | 7.10x |

Throughput was STILL CLIMBING at concurrency 12 with no clean plateau in the
tested range — the first version's "diminishing returns around 8" claim does
not hold up under the corrected methodology (it was an artifact of the
single-wave flaw). **This curve is host-dependent** (one `claude` CLI child
process per in-flight call, D-106) — re-run the script on the actual
deployment host before trusting a specific number for capacity planning.

**Prompt caching (D-103's question, review finding 5)**: `llm_usage`'s
`cache_creation_input_tokens`/`cache_read_input_tokens` were measured at
EVERY concurrency level above (1, 4, 8, 10, 12) and read **zero** in every
case — no cache writes, no cache reads, regardless of concurrency or flow
ordering. This traces to a fact D-103's own probe script already documented:
Haiku 4.5 has a ~4,096-token minimum cacheable-prefix, and the real occupancy
system prompt is ~2,700 tokens — BELOW that floor, so nothing caches at all
today, independent of this change. The flow-major grouping this design keeps
(never interleaving flows across concurrent workers) is therefore not
currently protecting any measured cache benefit — it remains in place because
it costs nothing and stays correct if a future prompt grows past the
threshold or a different model's threshold is lower, but the original
"keeps the cache warm" claim is corrected to "would keep the cache warm, if
caching were active, which measurement shows it currently isn't."

## What the review found and fixed

A fresh-context Opus review of the first version found three real bugs,
reproduced against real Postgres, plus smaller issues — all fixed here:

1. **HIGH — the drain heuristic keyed on work TOUCHED, not work DONE.**
   `runOne` (`batch.ts`) sets `result.properties` unconditionally the moment
   it reaches a property, before it knows whether that property was
   skipped/parked/errored. The scheduler's drain condition
   (`scheduler.ts`'s `tick()`) originally read `result.properties >=
   batchSize` alone — so a tick where an ENTIRE page errored or was already
   parked still reported a "full page" and rescheduled again in
   `drainIntervalSeconds` (5s default), a ~180x higher retry rate than the
   old 900s interval on inputs already known to be bad. Fixed two ways,
   complementary not redundant:
   - the drain condition now also requires `result.assessed > 0` (real
     progress this tick), so an all-bad page falls back to the idle cadence;
   - `selectPropertiesNeedingAssessment`'s query now excludes actively-parked
     FLOWS via `eligibility.ts`'s `pendingClause`/`parkGuardParams` — a
     property is only "pending" if it has a selection flow that is BOTH
     missing a verdict AND not parked, correlated per-flow (`af.assessment_type
     = f.atype`) so a park on `extract` (not even a selection flow) can never
     block an otherwise-healthy property's occupancy/condition/redflags.
     This also fixes a PRE-EXISTING latent bug the review surfaced: before
     any of this, a parked head-of-queue property (`created_at ASC` + LIMIT)
     blocked EVERY property behind it from ever being selected, forever —
     #666 only made the retry rate on that stall much faster, it did not
     create it. APPROXIMATE, not hash-exact (see `pendingClause`'s doc):
     a property whose content changed after a flow parked stays excluded
     until `PARK_DECAY_DAYS` (14) elapses or a manual `?force=1`, rather
     than unparking on the very next tick — accepted, a bounded rare delay
     against an unbounded permanent stall.
2. **HIGH — the pool-size fix moved the bottleneck, and the record was
   wrong about the mechanism.** The first version raised `db-write.ts`'s
   pool `max` from 5 to 12, reasoning the advisory-lock-holding connection
   (`cache.ts`'s `#30` stampede guard, held for the WHOLE LLM call) needed
   headroom on that shared pool. Live reproduction: 8 concurrent
   `getOrCompute` calls plus 4 ordinary long-running write-pool queries (a
   real materialize/dedup query's shape) caused every one of the 8 to fail,
   or — if the contention landed on `save()` — to pay for the LLM call and
   then lose the result to a connection-acquire timeout. Fixed properly:
   `cache.ts`'s `withAdvisoryLock` now uses `getLockPool()`, a DEDICATED
   pool (`max: 10`) separate from `db-write.ts`'s general pool (`max: 10`,
   headroom for transient nested queries — `getLatestAssessment`, the
   failure-ledger reads/writes, `save()` — not for anything held long-term).
   Lock-holding can no longer starve ordinary write-pool traffic, or vice
   versa. Reproduced fixed: `cache.integration.test.ts`'s new finding-2 test
   passes with the split pools and TIMES OUT (confirmed) when reverted to
   the shared-pool design. (Also corrected: the record claimed a starved
   caller would "just queue for a free connection" — `db-shared.ts`'s
   `connectionTimeoutMillis: 5000` means pg-pool REJECTS a queued
   acquisition after 5s, it does not block indefinitely.)
3. **MEDIUM-HIGH — a pool connection failure was classified as a content
   failure.** `cache.ts`'s `isEnvironmentalError` did not recognize a
   Postgres pool CONNECTION failure (pg-pool's literal "timeout exceeded
   when trying to connect" message, or a network `ECONNREFUSED`/`ETIMEDOUT`)
   as environmental — before finding 2 existed as a live path this landed
   just outside `getOrCompute`'s try/catch by accident of where the failure
   occurred, not by a guard. Real concurrency (finding 2) makes it a live
   path: several workers can all hit "no free connection" at the same
   instant, exactly like the D-107 quota case already carved out — striking
   each one would park perfectly healthy properties on a transient
   infrastructure blip. Fixed: both cases added to the carve-out, matched
   on `.code` (`ECONNREFUSED`/`ETIMEDOUT`) and on the literal pg-pool
   message (no stable `.code` exists for that one).
   `failure-ledger.test.ts` pins both, plus a control proving an unrelated
   Postgres-flavoured message (e.g. a bad relation name) still strikes.
4. **Also (scoped, smaller fixes):**
   - Two test files (`cache.test.ts`, `failure-ledger.test.ts`) mocked only
     `@/lib/db-write`'s `getPool`, which the advisory lock no longer calls —
     they were silently depending on a REAL Postgres connection for the lock
     (passing only by luck under `npm test`'s isolated-DB wrapper, failing
     outside it). Fixed to mock `"pg"` directly, restoring genuine
     no-live-DB unit-test isolation.
   - `runAssessmentBatch`'s own `concurrency` clamp now uses the SAME
     exported `MAX_ASSESSMENT_CONCURRENCY` constant the scheduler's
     `loadSchedulerConfig` clamps to (previously enforced in only one of the
     two places — a cap a direct caller could trivially exceed isn't a cap).
   - `scheduler.ts` gained a `generation` counter: a `stopAssessmentScheduler()`
     immediately followed by a `startAssessmentScheduler()` while an OLD tick
     was still in flight could arm a second, independent `setTimeout` chain
     alongside the new one (the old chain's reschedule callback only checked
     `started`, which is true again after the restart). `ticking` already
     made this harmless in practice (two chains' tick BODIES still can't run
     concurrently) and `stopAssessmentScheduler` has no production caller —
     but it is the one thing the "no pass overlaps another" guarantee rested
     on, so it is closed structurally rather than left to lean on a mutex
     for an unrelated reason. Pinned with a `vi.getTimerCount()`-based test.
   - `db/llm-health.ts`'s `projectBacklogSeconds` backlog-ETA tile assumes
     near-zero per-tick duration — defensible at the OLD 900s idle interval,
     not at the new 5s drain interval, where a real multi-property tick's own
     processing time can dominate the gap between ticks. Not fully solved
     here (would need live per-tick duration telemetry `llm_usage` does not
     carry) — flagged as a known gap; the tile should be read as a
     lower-bound "ticks needed" count more than a trustworthy ETA until that
     telemetry exists.

## Decision

1. **Bounded worker pool, per flow, not `Promise.all` over everything** —
   see "Design" below for the mechanism (unchanged from the first version;
   review confirmed it via mutation testing — reverting the worker-pool
   logic makes the concurrency tests deadlock/fail).
2. **Concurrency default 8, hard cap 8**
   (`dashboard.assessment_concurrency`). A deliberate balance point given
   the corrected measurement shows no clean plateau through 12 — not a
   measured ceiling. Bounds host resources (one `claude` CLI child process
   per in-flight call) and matches the connection-pool headroom this
   decision provisions.
3. **`dashboard.assessment_batch_size` default raised 5 → 8**, to MATCH
   concurrency — `min(concurrency, batchSize)` is the real worker count per
   round, so a smaller `batchSize` silently caps `concurrency` below its
   configured value.
4. **`dashboard.assessment_drain_interval_seconds` (default 5s)** — the
   scheduler reschedules after this short interval, instead of the full
   `dashboard.assessment_interval_seconds` (default unchanged, 900s), ONLY
   when a tick both touched a full page AND made real progress
   (`result.assessed > 0`) — see review finding 1 above for why both
   conditions are required.
5. **A dedicated advisory-lock connection pool** (`cache.ts`'s
   `getLockPool()`, `max: 10`), separate from `db-write.ts`'s general pool
   (`max: 10`) — see review finding 2.
6. **Selection excludes actively-parked flows**, per-flow-correlated, not a
   blanket per-property exclusion — see review finding 1 and
   `eligibility.ts`'s `pendingClause` doc.
7. **A `stopAssessmentScheduler()`/`startAssessmentScheduler()` generation
   counter** closes the duplicate-timer-chain race — see review finding 4
   above.

## Design (mechanism, unchanged from the first version)

`runAssessmentBatch` keeps its FLOW-MAJOR outer loop (property/flow pairs
grouped by flow, from the earlier llm-batching-plan Phase-1 restructure) and
adds a small worker pool WITHIN each flow's round: up to `concurrency`
properties run in parallel, each worker pulling the next unclaimed property
off a plain incrementing index (safe without a lock — JS only interleaves at
`await` points). `concurrency` defaults to 1 in the pure function itself
(reproducing the exact pre-#666 serial call order/timing byte-for-byte —
every pre-#666 `batch.test.ts` golden-value test passes unchanged); the
scheduler passes the configured value in production.

**Stop semantics widen by at most `concurrency - 1` extra calls.** A
budget/circuit/quota error sets a round-local stop flag; every worker checks
it before pulling its NEXT item, so no NEW (property, flow) pair starts once
a stop fires, but up to `concurrency - 1` OTHER calls already dispatched in
the same round finish (never aborted — Node has no cheap `claude` process
cancellation).

**One bad property still gets exactly one attempt per pass.** The
worker-pool's task list is the same deduplicated `propertyIds` array the
serial loop always had — concurrency changes the ORDER work completes in,
never the SET of work attempted. `batch.test.ts` pins this with a pure
call-count assertion under real concurrent workers; `cache.integration.test.ts`
pins the same guarantee one layer down against real Postgres with genuinely
concurrent (`Promise.all`) `getOrCompute` calls — both the ordinary strike
path (distinct properties, `fail_count` ends at exactly 1 each) and the
D-104 environmental-error carve-out (several properties hitting
`LlmQuotaExceededError` at once strike NONE of them).

**No two ticks can ever overlap**: the next `setTimeout` is only ever armed
after the in-flight tick's promise resolves, closed further by the
`generation` counter (review finding 4) against the stop/restart race.

**Alternatives rejected**:

- *`Promise.all` over the whole property list per flow, no pool.* Removes the
  ability to bound concurrency at all.
- *Interleave flows across workers for simpler code.* Would defeat the
  flow-major cache-locality property this design keeps available for when
  caching activates (see the prompt-caching measurement above) at zero
  extra code complexity.
- *Leave `batchSize` at 5, only raise `concurrency`.* Silently caps
  `concurrency` below its own configured value — corrected before shipping
  (see point 3).
- *Widen the shared write-pool further instead of splitting pools* (the
  first version's approach). Reproduced insufficient: even `max: 12` shared
  between lock-holding and ordinary traffic starved workers under realistic
  concurrent load. A dedicated pool removes the cross-talk structurally.
- *Immediate first tick on scheduler boot.* Left as a low-risk follow-up,
  outside #666's stated scope (reduces boot delay, not inter-tick idle).

**See**: `dashboard/lib/ai-assessment/batch.ts` (worker pool, `MAX_ASSESSMENT_CONCURRENCY`),
`dashboard/lib/ai-assessment/scheduler.ts` (adaptive duty cycle, defaults, `generation`),
`dashboard/lib/ai-assessment/cache.ts` (`getLockPool`, `isEnvironmentalError`),
`dashboard/lib/ai-assessment/eligibility.ts` (`pendingClause`, `parkGuardParams`),
`dashboard/lib/db-write.ts` (pool `max`), `dashboard/scripts/bench-assessment-concurrency.ts`
(the measurement, re-runnable), `dashboard/lib/ai-assessment/__tests__/batch.test.ts`
(`#666: concurrency`), `dashboard/lib/ai-assessment/__tests__/batch.integration.test.ts`
(parked-property selection tests), `dashboard/lib/ai-assessment/__tests__/cache.integration.test.ts`
(`#666` real-Postgres concurrent tests, including finding 2's repro),
`dashboard/lib/ai-assessment/__tests__/scheduler.test.ts` (`#666` adaptive-duty-cycle
and generation-counter tests), `dashboard/lib/ai-assessment/__tests__/eligibility.test.ts`
(`pendingClause`/`parkGuardParams` unit tests), `dashboard/lib/ai-assessment/__tests__/failure-ledger.test.ts`
(environmental-error carve-out tests), [D-043](D-043-batch-capture-auto-advance.md),
[D-052](D-052-assessment-auto-trigger-dashboard-side.md), [D-103](D-103-cli-lean-invocation.md),
[D-104](D-104-assessment-failure-ledger.md), [D-105](D-105-llm-master-kill-switch.md),
[D-106](D-106-cli-spawn-hardening.md), [D-107](D-107-subscription-quota-cap.md).
