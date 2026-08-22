---
id: D-166
title: Actividad is one rolled-up event vocabulary over eight ingest tables; the run-level row appears only when it has something its connectors cannot say
date: 2026-08-22
group: Frontend / UI
rule: 'Actividad rows are {kind, source, t, counts, status} rolled up in SQL at read time; short codes only, never error_msg. A childless sweep renders Omitidos. Page by Madrid days.'
---

# D-166: Actividad is one rolled-up event vocabulary over eight ingest tables; the run-level row appears only when it has something its connectors cannot say

*Decided: 2026-08-22*

**Context**: Issue #644, part of #636. "What happened to my data today?" required
four surfaces — `/etl` for connector runs, `/etl/salud` for capture aggregates,
nothing at all for dedup passes or worklist requeues, and raw SQL for
withdrawals. The owner's three standing questions from the last three days were
*"no sé cuántos datos se ha cargado en las últimas horas"*, *"¿se ha atascado
algo esta noche?"* and *"¿por qué esta pasada no produjo nada?"*, and none of
them could be answered from one screen.

Measured in production on 2026-08-22 before designing anything:

| table | rows | shape that forced a design choice |
|---|---:|---|
| `connector_run_results` | 353 | one row per connector per sweep, spread over hours |
| `connector_runs` | 178 | **8 of the last 12** stored `total_connectors = 0, duration_ms = 3` |
| `extension_capture` | 4.912 | 1.350 in one day; 4.867 of 4.905 inter-row gaps under 5 minutes |
| `capture_worklist` (requeued) | 2.840 | in exactly **3** batches — 3 distinct `requeued_at` values |
| `dedup_runs` | 115 | one row per pass |
| `listing_status_event` | 13.890 | ~600/day, overwhelmingly `active` first sightings |
| `etl_manual_trigger` | 0 | never used in production yet |
| `extension_block_episode` | 0 | #637's history, and the section #642 P2 would delete by omission |

Two numbers set the whole design. **4.912 captures** means a raw feed is a log
tail, not a chronology. And **`total_connectors = 0, duration_ms = 3`** is, in
every existing surface, an unreadable row: it says a pass happened and
produced nothing, without saying why.

Traced through `etl/orchestrator.py`, that row means every registered
connector `continue`d before writing a `connector_run_results` row —
`_finish_connector_run` stores `total_connectors = ok + failed + skipped`, so
three routes reach it: **disabled** in `connector_config` (increments
`skipped`), **fresh and not due** under the D-050 cadence gate, and **no
scope to cover** (#71/#99); the latter two increment nothing. All finish
`status = 'success'` in a few ms. It is the *healthy quiet run* — and the
open question is which of those three it was.

> **Correction.** An earlier draft of this record, and of the PR that
> introduced it, attributed that row to the **D-009 crash-loop guard
> declining to sweep**. That is wrong and is recorded here rather than
> quietly edited out.
> `run_all_connectors_respecting_restart_guard` returns `None` *before*
> `run_all_connectors` reaches `_create_connector_run`, so a suppressed
> restart sweep writes **no `connector_runs` row at all** and cannot appear
> on this timeline under any status. The mistake inverted the design story —
> it cast the row as a guard refusing to work when it is in fact the quiet
> healthy pass — and it is the reason this decision now mandates the
> `Omitidos` metric (see point 5) instead of treating the bare row as
> self-explanatory.

**Decision**:

1. **One event shape for every kind.** Every row the API emits is
   `{ id, kind, source, t, tEnd, status, counts, note, detailHref, rolledUp }`.
   No per-kind bespoke prose, no per-kind extra fields. Eight kinds today
   (`crawl`, `sweep`, `captura`, `recola`, `dedup`, `manual`, `estado`,
   `bloqueo`); adding a ninth means adding a row to that table, never a new
   shape.

2. **Five statuses, shared across kinds**: `ok` / `aviso` / `error` / `curso` /
   `omitido`. `aviso` is not `error` (a tripped breaker or a partly-failed
   capture session is worth looking at, but it is not "this broke"), and
   `omitido` is neither (an operator disabling a connector is normal — issue
   #99 — and colouring it amber trains the eye to ignore amber).

3. **`error_msg` never renders on the timeline** — drill-through only (#531's
   no-prose rule). The `note` field carries only SHORT STABLE CODES:
   `connector_run_results.verification_alarm` and
   `capture_worklist.requeue_reason`. Both name an operator ACTION — one
   withheld, one taken — that no counter on the row can express; a guarded
   verification run stores `verified_gone_count = 0`, indistinguishable from a
   run where every listing came back alive.

4. **Rollups are derived in SQL at read time. No session table.** Captures
   group by portal with a 30-minute gap; requeues group by the `requeued_at`
   the batch stamped; status changes group by source and transition with the
   same gap. `rolledUp` on every row states how many raw rows it stands for, so
   "1.350 capturas" is visibly a rollup rather than a claim that one thing
   happened.

5. **A sweep gets a row of its own ONLY when it recorded no per-connector
   outcome, and it MUST render `Omitidos` alongside `Conectores`.** Otherwise
   its connectors already speak for it, at their real times, and a sweep row
   would restate them. This inversion is the point, not an optimisation: the
   only case where a run has something its children cannot say is the case
   where it has no children.

   `Omitidos` is not decoration — it is what makes the row answer its
   question, and it is rendered even when zero, because the whole distinction
   lives in that zero: `Conectores N · Omitidos N` is "every connector is
   switched off", `Conectores 0 · Omitidos 0` is "nothing was due" (D-050
   cadence gate) or "nothing had a scope to cover" (#71/#99). Suppress the
   zero and the two collapse back into the same unreadable row this decision
   exists to split apart.

6. **Paging is by whole Madrid-local days, never a row cursor.** A session is
   only well defined relative to the window it is computed over; a cursor
   landing mid-session either splits it across two pages or re-emits it
   truncated. Day boundaries make paging correct by construction, and they give
   each day a rollup line — which is the literal answer to question one. Days
   are Europe/Madrid (production Postgres runs UTC; the owner does not), and
   sessions never straddle a local midnight.

7. **`listing_status_event`'s `active` rows are excluded, except
   resurrections.** ~600/day are first sightings, i.e. ingest volume the crawl
   and captura rows already report. An `active` event on a listing that was
   previously non-active is a real market event (D-157's explicit-resurrection
   clause) and is kept, labelled `reactivadas`.

8. **Disabled sources are NOT filtered.** `activeSourceClause()` /
   `DISABLED_SOURCES_CTE` (D-055) exist so a switched-off portal's listings stop
   appearing as live candidates. This is a history feed: what a source did last
   Tuesday stays true after it is switched off, and hiding it would erase the
   very run that made the operator switch it off. No fourth copy of that
   discriminator is created here.

9. **Section boundaries are binding.** Estado (#638/#640) = what is true NOW
   (queue depth, freshness, active-block chip). Fuentes (#676) = ONE source in
   depth (config, worklist, quality). Actividad = what HAPPENED, when, across
   every source. Actividad therefore carries no live queue depth, no
   configuration and no controls; it links to the other two. A number that
   describes the present belongs on Estado even when it is derived from
   history.

**Alternatives rejected**:

- *Infinite scroll on a row cursor, as #644's own scope suggested.* Rejected on
  the session-grouping correctness argument in point 6. Day sections also read
  better on a phone, which is where this is used.
- *Emitting a sweep row for every run, alongside its connector rows.* Rejected:
  on a 15-connector sweep that is one duplicate parent for fifteen children,
  and the duplication is exactly the "solo has añadido" complaint in miniature.
- *Rendering `error_msg` inline for failed rows.* Rejected per #531; the run
  detail page already shows it, expandable, and that is one tap away.
- *Making `estado` (withdrawals) a metric on the crawl/captura rows instead of
  its own kind.* Rejected: withdrawals arrive from two unrelated mechanisms
  (crawl verification, D-157; captured retirement notices, D-159), and folding
  them into their causes means "what left the market today" can only be
  answered by adding up two different rows. The crawl row keeps
  `verified → retirados` because that pair measures the PASS (was verification
  productive?), which is a different question from the inventory one; the
  overlap is deliberate and named in `lib/db/activity.ts`.
- *A `render_timeout` event kind, per the owner's comment on #644.* Not built:
  there is no channel that reports an abandoned `pollUntilReady` wait — no
  `extension_capture` row is created at all — so a kind for it would render an
  empty filter chip that looks like "this never happens". Left to a follow-up
  that adds the write side first.

**Rationale**: the owner's complaint governing this whole tracker is *"has
hecho un rediseño de la administración pero solo has añadido, no has eliminado
nada"*. A chronology that merely concatenates eight tables would be another
addition. What makes this a consolidation is that each row is the same shape,
each rollup replaces N raw rows the owner would otherwise scroll, and the
surfaces it supersedes (`/etl`'s run list, `/etl/salud`'s capture-per-portal
block, #637's episode history) now have a named home so #642 P2 can delete them
without losing anything by omission.

**See**: issues #644, #636, #642 (P2 disposition table), #637 (episode
history), #531 (no-prose rule), D-009 (restart burst guard), D-055
(source-active discriminator), D-120/D-121/D-124 (phone-width conventions),
D-156 (requeue metadata), D-157 (evidence, not time), D-159 (Idealista retired
notice), D-162 (timing legs; NULL is not 0).
Files: `dashboard/lib/activity.ts`, `dashboard/lib/db/activity.ts`,
`dashboard/app/api/etl/activity/route.ts`,
`dashboard/app/admin/actividad/page.tsx`.
