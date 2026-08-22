---
id: D-092
title: Zero-results regression monitor flags (connector, scope) that went nonzero→0 for N consecutive runs
date: 2026-08-06
group: "Data / connectors"
rule: A (connector, resolved scope/filter) is flagged as a zero-results regression when it had a prior nonzero result AND its last N consecutive measured runs are all 0 (N=`etl.zero_result_regression_runs`, default 3). Always-0 (sparse) scopes and single transient 0s are NOT flagged; a later nonzero clears it. Server counts come from `connector_run_results.geography_scope[].discovered_count`; only 'crawled'/'empty' outcomes are measurements. Surfaced on `/admin/fuentes/<connector>` (data-health), plus an Estado aviso chip linking there — NOT a drift/discovery surface (D-168; `/etl/salud` and `/etl/discovery` are both gone).
---

# D-092: Zero-results regression monitor

*Decided: 2026-08-06*

**Location clause superseded (2026-08-22) by
[D-168](D-168-admin-six-sections-etl-tree-deleted.md)**: `/etl/salud` no longer
exists. The per-scope list is on `/admin/fuentes/<connector>` (#642 P1) and an
active regression also raises an aviso chip on Estado that links there (#642
P2). The detection semantics in the rule above — what counts as a regression,
what clears it, which outcomes are measurements — are untouched; only the named
surface changed.

**Context**: Issue #376. The real fingerprint of a filter/URL drift (the "ático"
failure the owner hit) is portal-agnostic and needs no DOM scraping: a search
that USED TO return listings now returns 0. ~80% of the plumbing already
existed — server connectors record a per-scope `outcome` ('crawled'/'empty') in
`connector_run_results.geography_scope` (D-079), and the browser extension's
`enumerateResultsPages()` (#362) already computes the real harvested count
(`seen.size`) but discarded it.

**Decision**:
- **Persist per-run counts keyed by (connector, resolved scope/filter).**
  - Server: `etl/orchestrator.py` `_record_geo` now writes `discovered_count`
    into each `geography_scope` entry (only the 'crawled'/'empty' terminal
    outcomes carry a real count; every other outcome — uncovered, unresolvable,
    budget, duplicate, fresh_this_cycle, failed — leaves it `None`, i.e. "no
    measurement this run", so a blocked/skipped scope is never mistaken for a
    genuine zero). No DDL — it is a JSONB key.
  - Extension: `enumerateResultsPages()` re-POSTs the search URL WITH its
    `seen.size` at the end of enumeration; the server stores it on
    `search_url_example.last_result_count` (keyed by portal + match_key). The
    dashboard task-run flow persists `capture_task_run.last_result_count`
    (keyed by profile + task). Both columns are idempotent
    `ADD COLUMN IF NOT EXISTS`.
- **Regression check (deterministic, pure).**
  `dashboard/lib/zero-result-regression.ts` `detectZeroResultRegression()` flags
  a scope iff it had a prior nonzero AND its last N consecutive *measured* runs
  are all 0. Always-0 (sparse/never-covered) never flags; a single transient 0
  never flags; a later nonzero clears the flag. N is
  `etl.zero_result_regression_runs` (env > config.yaml > default 3).
  `dashboard/lib/db/zero-result-regression.ts` builds the per-(connector, scope)
  observation stream from `connector_run_results.geography_scope` (30-day
  window) and feeds the pure detector.
- **Surface** on the ETL monitor / data-health page (`/etl/salud`) as
  "Búsquedas que dejaron de devolver resultados", folded into
  `GET /api/etl/data-health`.

**Alternatives rejected**:
- *First-drop alarm.* Owner explicitly chose N-consecutive: a one-off block or
  an empty refresh must not cry wolf.
- *Raw-zero flag.* A genuinely sparse area that was always 0 has lost nothing;
  flagging it is noise. A prior nonzero baseline is required.
- *`/etl/discovery` + `drift.ts`.* That surface is issue #377's (filter-drift
  detection); this monitor lives on the data-health side to avoid overlap.
- *Counting blocked/skipped/uncovered runs as zeros.* A scope that could not be
  searched this run did not "return 0 results"; those outcomes are excluded from
  the observation stream, not counted.

**Rationale**: Portal-agnostic, deterministic, and built almost entirely on data
already recorded. The single judgement call — "only a run that actually searched
the scope counts as an observation" — is what separates a real regression from
a run that never looked. N-consecutive + prior-nonzero-baseline is the minimal
rule that catches the ático case without false positives on sparse areas or
transient blips.

**See**: issue #376; `etl/orchestrator.py` (`_record_geo`);
`dashboard/lib/zero-result-regression.ts`;
`dashboard/lib/db/zero-result-regression.ts`;
`dashboard/lib/db/data-health.ts`; `dashboard/app/etl/salud/page.tsx`;
`etl/schema/init.sql` (`capture_task_run.last_result_count`,
`search_url_example.last_result_count`); `config/schema.yaml`
(`etl.zero_result_regression_runs`); D-079 (geography_scope), #362
(enumerateResultsPages), #377 (discovery filter-drift, sibling surface).
