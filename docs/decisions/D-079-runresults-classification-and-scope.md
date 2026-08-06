---
id: D-079
title: Typed failure classification + resolved geography scope on connector_run_results
date: 2026-08-06
group: Data / connectors
rule: '`connector_run_results` gets two additive columns off the same `_record_connector_result` write site: `failure_classification TEXT` (CHECK: `soft_block\|network\|structure_change\|unresolvable\|uncovered\|empty_result\|other`, NULL=clean; classifier + one-time backfill in `etl/failure_classification.py`, #242) and `geography_scope JSONB` (one entry per resolved scope with per-geography `outcome`, #109). Disabled connectors still emit NO row (D-069). Surfaced in RunDetail + e2e (D-041).'
---

# D-079: Typed failure classification + resolved geography scope on connector_run_results

*Decided: 2026-08-06*

**Context**: `connector_run_results` recorded failure detail and coverage only as
free text inside `error_msg`. Two operator questions had no queryable answer:
(1) *what KIND of failure was this* — a soft-block backoff, a dead network, a
parse/structure break, an uncovered geography? (issue #242, feeds the #171 trend
work); and (2) *which geography did this run actually run against* — the resolved
scope survived only as prose, so a surprising result could not be traced to the
city/radius/filters used (issue #109). The roadmap
(`docs/roadmap/connector-etl-ops.md` §4/§109) explicitly asked for both columns
to land in ONE migration window on this table, off the SAME
`etl.orchestrator._record_connector_result` write site, to avoid migrating
`connector_run_results` twice in a row. Built on top of #292/#343 (D-069): a
disabled connector still emits NO row, so neither column re-introduces the
per-sweep disabled-row noise D-069 removed.

**Decision**:
- Add two additive, idempotent columns to `connector_run_results`:
  - `failure_classification TEXT` (CHECK-constrained, nullable) — the typed
    failure kind: `soft_block | network | structure_change | unresolvable |
    uncovered | empty_result | other`, or `NULL` for a clean run that ingested
    data. Written by the orchestrator with a precedence that mirrors the
    existing status precedence, then adds the clean-run signals status can't
    express (`soft_block` even on an `ok` run, `empty_result`). A one-time
    best-effort `UPDATE` backfills historical `failed`/`circuit_open` rows from
    their `error_msg` prose (idempotent — only fills NULLs). The exception→kind
    logic and the prose→kind backfill logic both live in the pure, unit-tested
    `etl/failure_classification.py`; the SQL backfill in `init.sql` mirrors it.
  - `geography_scope JSONB` (nullable) — one entry per resolved `ConnectorScope`
    the run walked (fairness-ordered), each `{scope_key, center, radius_km,
    rooms, outcome}` where `outcome ∈ {crawled, empty, uncovered, unresolvable,
    budget, soft_block, fresh_this_cycle, duplicate, failed}`. This is the
    queryable coverage audit; the per-geography `outcome` is where #109's
    "distinguish uncovered from unresolvable for the same city" distinction now
    lives (D-069 means the disabled/no-scope cases emit no row at all, so that
    part of #109's AC is satisfied by finer-grained outcomes on rows that DO
    run, not by a new skipped-row taxonomy).
- Surface both in the run-detail UI (`RunDetail.tsx`): a coloured failure-kind
  badge in the status cell (amber/gray for clean signals, red for genuine
  breaks) and an "Ámbito" row per connector listing each geography with its
  outcome badge. Per D-041, the `etl-monitor` Playwright e2e seeds and asserts
  both.
- **Column name**: `failure_classification` (per the build-task directive). Issue
  #242's body proposed `failure_kind` and the roadmap `failure_class`; nothing
  consumed either yet, so one name was chosen — `failure_classification`.

**Alternatives rejected**:
- Re-introducing per-scope skipped rows to carry disabled-vs-no-scope (fights
  D-069/#343 — those cases deliberately emit no row).
- A second migration for #109 after #242's (the roadmap explicitly wanted one
  window on this table).
- Splitting `network` vs `structure_change` structurally at raise time: the
  orchestrator only knows "fatal ConnectorError", so the split is a best-effort
  message classifier, deliberately coarse and centralised in one testable module.

**Rationale**: Both facts were already computed inside the orchestrator and
thrown away into prose. Making them typed/queryable columns off the existing
write site is the minimal, additive change that turns "grep error_msg" into
"GROUP BY failure_classification" and gives every run an auditable coverage
record — without a new table, without touching the disabled-connector hygiene of
D-069, and in a single migration.

**See**: issues #242, #109; `etl/failure_classification.py`;
`etl/orchestrator.py` (`_record_connector_result`, `run_all_connectors`);
`etl/schema/init.sql` (connector_run_results migration block);
`dashboard/app/api/etl/runs/[id]/route.ts`, `dashboard/app/api/etl/types.ts`,
`dashboard/components/etl/RunDetail.tsx`, `dashboard/e2e/etl-monitor.spec.ts`;
D-069 (run hygiene), D-050 (`fresh_this_cycle` outcome), roadmap
`docs/roadmap/connector-etl-ops.md` §4/§109.
