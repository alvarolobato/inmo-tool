---
id: D-149
title: AI-assessment batch — bounded per-flow concurrency + adaptive duty cycle
date: 2026-08-21
group: AI layer
rule: "runAssessmentBatch runs dashboard.assessment_concurrency (default 8, hard cap 8) calls in parallel WITHIN one flow's round (never interleaved across flows — keeps D-103's --system-prompt cache warm); dashboard.assessment_batch_size defaults to the SAME value (8) so concurrency isn't silently capped by too small a page. The scheduler reschedules after dashboard.assessment_drain_interval_seconds (default 5s) instead of the full idle interval whenever a tick touches a full page, backing off to the full interval on an empty page or a budget/circuit/quota stop. db-write pool max raised 5 to 12 so cache.ts's advisory-lock-holding connection (held for the whole LLM call) doesn't silently serialize concurrency below the configured level."
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
subscription: cost is explicitly not the constraint (`dashboard.llm_daily_budget_usd`
governs €, unrelated to this decision) — wall-clock time and the D-107
subscription-quota cap are the only real ceilings, and the ask was explicitly
to go faster, not cheaper.

Three measurements shaped the design, all against the REAL `claude` CLI
backend (D-106's `CLI_SAFETY_ARGS`/`CLI_LEAN_ARGS`), never a mock:

1. **The LLM/CLI backend is not the bottleneck for spawn/network overhead.**
   A trivial prompt ("reply OK"): 6 calls serially took 23.7s (~3.95s/call);
   24 calls at concurrency 24 took ~6.8–9.3s; 40 calls at concurrency 40 took
   ~8.6s — every call succeeded, no rate-limiting observed. The backend
   scales far past double-digit concurrency for a cheap call; it does not
   size the default on its own.
2. **The db-write connection pool WAS a real, non-obvious ceiling.** `cache.ts`'s
   `withAdvisoryLock` (the #30 stampede guard) acquires a DEDICATED Postgres
   client via `getPool().connect()` and holds it for the ENTIRE duration of
   `fn` — which includes the real network LLM call, i.e. potentially many
   seconds per call. `db-write.ts`'s pool was `max: 5`. Any assessment
   concurrency above 5 would not actually get more parallel LLM calls
   in flight; the 6th+ concurrent `getOrCompute` call would simply block
   waiting for a free pool connection, silently capping real throughput below
   whatever `dashboard.assessment_concurrency` was configured to — with no
   error, just quietly worse-than-configured.
3. **End-to-end, against the real `assessPropertyOccupancy` flow and a real
   (throwaway) Postgres database** (`dashboard/scripts/bench-assessment-concurrency.ts`,
   synthetic never-scraped listing text, disjoint property sets per run so
   neither is a #30 cache hit against the other):

   | concurrency | assessments/hour | speedup vs. serial |
   |---|---|---|
   | 1 (old, always-serial) | 179–200 | 1.0x |
   | 4 | 369 | 2.06x |
   | 8 | 998 | 4.98x |
   | 10 | 1,102 | 5.60x |

   Going from 4 → 8 workers roughly doubled the speedup again (2.06x → 4.98x);
   going from 8 → 10 (+25% more workers) bought only +12% more speedup
   (4.98x → 5.60x) — the real, measured point where returns start
   flattening sits right around 8, not 4. This directly answers the issue's
   "find the point where more workers stop helping" — the db-write pool bump
   above removed the ARTIFICIAL ceiling at 5; this is the REAL one.

**Decision**:

1. **Bounded worker pool, per flow, not `Promise.all` over everything.**
   `runAssessmentBatch` keeps its existing FLOW-MAJOR outer loop (property/
   flow pairs grouped by flow, unchanged from the earlier llm-batching-plan
   Phase-1 restructure) and adds a small worker pool WITHIN each flow's round:
   up to `concurrency` properties run in parallel, each worker pulling the
   next unclaimed property off a plain incrementing index (safe without a
   lock — JS only interleaves at `await` points). Flows are never
   interleaved across workers: every concurrent call within one round shares
   the SAME flow, hence the SAME `--system-prompt`, which is what D-103's CLI
   prompt cache keys on — grouping by flow keeps the cache warm across a
   round instead of cold-starting it on every call the way flow-interleaved
   concurrency would. `concurrency` defaults to 1 in the pure function itself
   (reproducing the exact pre-#666 serial call order/timing byte-for-byte —
   every existing `batch.test.ts` golden-value test passes unchanged); the
   scheduler passes the configured value in production.
2. **Stop semantics widen by at most `concurrency - 1` extra calls.** A
   budget/circuit/quota error sets a round-local stop flag; every worker
   checks it before pulling its NEXT item, so no NEW (property, flow) pair
   starts once a stop fires, but up to `concurrency - 1` OTHER calls already
   dispatched in the same round are allowed to finish (never aborted — Node
   has no cheap `claude` process cancellation, and killing a call that
   already spent tokens buys nothing). This is a documented, bounded
   widening of the old "stops on the very first call" guarantee.
3. **One bad property still gets exactly one attempt per pass.** The
   worker-pool's task list is the same deduplicated `propertyIds` array the
   serial loop always had — concurrency changes the ORDER work completes in,
   never the SET of work attempted. `batch.test.ts` pins this with a pure
   call-count assertion under real concurrent workers; `cache.integration.test.ts`
   pins the same guarantee one layer down against a real Postgres
   `ai_assessment_failure` table with genuinely concurrent (`Promise.all`)
   `getOrCompute` calls — both the ordinary strike path (distinct properties,
   `fail_count` ends at exactly 1 each) and the D-104 environmental-error
   carve-out (several properties hitting `LlmQuotaExceededError` at once
   strike NONE of them, not one each).
4. **Concurrency default 8, hard cap 8** (`dashboard.assessment_concurrency`,
   env `DASHBOARD_ASSESSMENT_CONCURRENCY`, clamped server-side regardless of
   config). Default and cap sit at the SAME value — unlike D-043's
   browser-extension batch-capture pattern (default below its cap, headroom
   left unused by default) — because the measurement above found real
   throughput still climbing at 8 with only marginal gain by 10; there was
   no case for shipping a lower default and leaving the observed win on the
   table. Bounds real host resources (one `claude` CLI child process per
   in-flight call) and the db-write pool's connection budget — not the LLM
   API itself, which measured fine well past this level in isolation.
5. **`dashboard.assessment_batch_size` default raised 5 → 8, to MATCH
   concurrency.** A flow's round only ever has `batchSize` properties to
   hand out — one tick selects at most `batchSize` properties up front, and
   every flow round works over that same page — so `min(concurrency,
   batchSize)` is the REAL worker count regardless of what `concurrency`
   alone says. Leaving `batchSize` at its pre-#666 default of 5 would have
   silently capped every round at 5 workers no matter how high
   `assessment_concurrency` was set — the measured 8-way speedup above is
   only reachable in production because both defaults moved together.
6. **db-write pool `max` raised from 5 to 12.** Headroom above the
   concurrency hard cap (8) so the advisory-lock-holding connection never
   starves the configured concurrency, plus margin for the pool's other
   callers (dashboard CRUD writes, the failure-ledger reads/writes that run
   alongside a held advisory-lock connection).
7. **Adaptive scheduler duty cycle**, replacing the fixed `setInterval`
   with a self-rescheduling `setTimeout` chain (`scheduler.ts`): a tick that
   touches a full `batchSize` page reschedules after the short
   `dashboard.assessment_drain_interval_seconds` (default 5s) instead of the
   full `dashboard.assessment_interval_seconds` (default unchanged, 900s);
   a tick that finds fewer than a full page (queue effectively empty) or
   that stops on budget/circuit/quota backs off to the full interval. The
   very first tick after `startAssessmentScheduler()` still waits the full
   interval, unchanged — only the cadence BETWEEN ticks is adaptive. No two
   ticks can ever overlap: the next `setTimeout` is only ever armed after the
   in-flight tick's promise resolves (the pre-existing `ticking` flag is kept
   as a cheap belt-and-suspenders check, pinned by its own test).

**Alternatives rejected**:

- *`Promise.all` over the whole property list per flow, no pool.* Removes the
  ability to bound concurrency at all — at `batchSize` > `concurrency` this
  would spawn `batchSize` CLI processes and DB connections simultaneously
  regardless of configuration, defeating the whole point of a concurrency
  knob.
- *Interleave flows across workers (property-major-ish concurrency) for
  simpler code.* Rejected on the D-103 measurement concern the issue raised:
  interleaving would cold-start the CLI's system-prompt cache on every call
  instead of keeping it warm across a round. Flow-major-grouped concurrency
  costs nothing extra in code complexity and avoids that regression by
  construction.
- *Leave `batchSize` at 5, only raise `concurrency`.* The first version of
  this decision proposed exactly that, reasoning `batchSize` was an
  "independent, orthogonal knob". The end-to-end measurement above showed
  that framing was wrong in practice: with `batchSize=5`, `concurrency=8`
  is unreachable — `min(8, 5)` never exceeds 5 — so the configured knob would
  silently underperform its own value. Corrected before shipping (point 5
  above), not left as a footgun.
- *Immediate first tick on scheduler boot* (mirroring the ETL connector
  orchestrator's "run immediately on startup, then hourly" pattern). Would
  further reduce idle time, but changes `startAssessmentScheduler`'s startup
  timing rather than the inter-tick idle the issue is about, and touches an
  existing, passing test's exact timing assumptions for a benefit outside
  #666's stated scope. Left as a natural, low-risk follow-up rather than
  bundled here.

**Rationale**: The two levers the issue named — "concurrency inside a pass"
and "duty cycle" — are genuinely independent and both needed: concurrency
alone still leaves the scheduler idle after a short pass; a shorter idle
alone still runs every pass serially. Sizing concurrency against the measured
real ceiling (the DB pool, then the CLI/DB resource envelope at 8) — and
keeping `batchSize` in lockstep with it — avoids shipping a knob that
silently underperforms its own configured value.

**See**: `dashboard/lib/ai-assessment/batch.ts` (worker pool), `dashboard/lib/ai-assessment/scheduler.ts`
(adaptive duty cycle + defaults), `dashboard/lib/db-write.ts` (pool `max`),
`dashboard/scripts/bench-assessment-concurrency.ts` (the before/after measurement,
re-runnable), `dashboard/lib/ai-assessment/__tests__/batch.test.ts`
(`#666: concurrency` describe block), `dashboard/lib/ai-assessment/__tests__/cache.integration.test.ts`
(`#666` real-Postgres concurrent-failure tests), `dashboard/lib/ai-assessment/__tests__/scheduler.test.ts`
(`#666: adaptive duty cycle` describe block), [D-043](D-043-batch-capture-auto-advance.md),
[D-052](D-052-assessment-auto-trigger-dashboard-side.md), [D-103](D-103-cli-lean-invocation.md),
[D-104](D-104-assessment-failure-ledger.md), [D-105](D-105-llm-master-kill-switch.md),
[D-106](D-106-cli-spawn-hardening.md), [D-107](D-107-subscription-quota-cap.md).
