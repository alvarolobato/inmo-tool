---
id: D-052
title: AI-assessment auto-trigger lives dashboard-side, not in the ETL orchestrator
date: 2026-08-05
group: AI layer
rule: The AI-assessment auto-trigger is a dashboard-side in-process scheduled pass (`ai-assessment/{batch,scheduler}.ts`, started from `instrumentation.ts`), NOT an ETL hook — bounded N-oldest-unassessed per tick, skips current-prompt-version verdicts, stops cleanly on budget/circuit errors. Configured via `dashboard.assessment_*`.
order: 66
---

# D-052: AI-assessment auto-trigger lives dashboard-side, not in the ETL orchestrator

*Decided: 2026-08-05*

**Context**: Phase-4's four property-level assessment flows
(`dashboard/lib/ai-assessment/{occupancy,condition,redflags,extract}.ts`, issues
#25/#26/#27/#28, cached by #30, price-signal-wired by #184) were fully built,
tested, and their verdicts already rendered as candidate-card badges
(`lib/candidates.ts`'s `loadFlags` → `CandidateCard.tsx`). But a repo-wide search
found **zero callers**: the only entry point was
`POST /api/properties/[id]/assessments/*`, which nothing fetched — no frontend,
no chat tool (`llm-tools/catalog.ts` explicitly excludes assessment flows), no
ETL hook, no cron. Net effect: the candidate feed showed zero occupancy /
condition / red-flag / below-market badges in practice despite the machinery
existing. Issue #308 (the P0 from the #307 strategy review) is to add the missing
*trigger* — no new AI logic, no new UI, no new schema.

The trigger has two parts: **when to run** (a scheduler) and **the work**
(running the flows). The work MUST be dashboard-side: the flows are TypeScript,
persist through `lib/db-write`, and — critically — depend on `lib/llm.ts`'s
`checkDailyBudget()` ceiling and circuit breaker (`BudgetExceededError` /
`CircuitBreakerOpenError`), which exist only in the dashboard process. The
question was only where the *scheduler* lives.

**Decision**: The auto-trigger is a **dashboard-side in-process scheduled pass**.
`dashboard/lib/ai-assessment/batch.ts`'s `runAssessmentBatch()` selects the N
oldest ingested properties lacking a current-prompt-version verdict and runs the
four existing flows for them; `dashboard/lib/ai-assessment/scheduler.ts` fires it
on an interval, started once from `instrumentation.ts`'s `register()` (the same
startup seam that already bootstraps config.yaml and applies `init.sql`). It is:

- **Bounded**: at most `dashboard.assessment_batch_size` (default 5) properties
  per tick, oldest-first (`property.created_at ASC`). Never a full-history
  backfill.
- **Idempotent**: the selection query only returns properties MISSING a
  current-prompt-version row for at least one of occupancy/condition/redflags,
  and each flow is re-checked with `getLatestAssessment(...).stale === false`
  before it runs (`cache.ts`'s existing staleness logic — the same the flows and
  the card UI share). A property already at the current prompt version is
  skipped, never re-billed. The flows' own #30 content-hash cache is a second
  backstop underneath.
- **Fail-safe**: a `BudgetExceededError` / `CircuitBreakerOpenError` mid-run
  stops the batch CLEANLY (returns a summary), never crashing the host process.
  A `NoListingsError` or any other per-property error is logged and skipped.
- **Configurable** via `config/schema.yaml`: `dashboard.assessment_auto_enabled`
  (kill switch), `dashboard.assessment_batch_size`,
  `dashboard.assessment_interval_seconds` (default 900s).

`extract` runs opportunistically for any selected property (it self-gates via
`needsExtraction`) but does NOT drive selection: a fully-structured property
never gets an `extract` row, so keying selection on a missing one would re-select
it every tick forever.

**Alternatives rejected**:
- *ETL orchestrator post-run POST* (mirror `notify_materialize_all`, D-046):
  viable and event-driven, and the `ETL_DASHBOARD_BASE_URL` plumbing already
  exists. Rejected because (a) it touches `etl/main.py`/`etl/orchestrator.py`
  during PR #305's active rework of the freshness-cadence scheduler (rebase/churn
  risk the issue explicitly asked to avoid), and (b) a Python trigger would only
  ever POST back into the dashboard to reach the flows' budget/circuit safety —
  splitting a purely-TypeScript concern across two containers for no benefit.
- *A new external cron / systemd timer*: another moving part and a second place
  to configure; the in-process loop needs no new infra and rides the persistent
  `next start` process the dashboard already runs.

**Rationale**: Keep the whole feature in one language and one process, next to
the safety rails it must respect, touching zero Python and avoiding churn with
the connector scheduler. The `instrumentation.ts` seam is the established
"run once when the server starts" hook.

**See**: issue #308 (part of #307); `dashboard/lib/ai-assessment/batch.ts`,
`scheduler.ts`; `dashboard/instrumentation.ts`; `config/schema.yaml`
(`dashboard.assessment_*`); `docs/architecture/data-model.md` § AI assessments;
D-046 (materialize-staleness reconciler, the sibling "dashboard-triggered vs
ETL-triggered" precedent), #182 (the parallel extract-consumer gap, left
independent).
