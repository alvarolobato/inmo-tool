---
id: D-156
title: Re-capture requeues capture_worklist rows; requeued_at (not a new status) marks them
date: 2026-08-22
group: Data / connectors
rule: "Re-capturing a cohort flips its `capture_worklist` rows from `captured` back to `pending` and stamps `requeued_at`/`requeue_reason`/`requeue_rank` — never a sixth `status` value, never a parallel queue. Only `captured` rows are eligible; `skipped`/`stale`/`failed`/`pending` are left alone. The cohort is a closed predicate enum resolved server-side and re-resolved on write against the confirmed count."
---

# D-156: Re-capture requeues capture_worklist rows; requeued_at (not a new status) marks them

*Decided: 2026-08-22*

**Context**: A parser bug can leave a whole cohort of listings holding bad
data. The case that prompted this (issue #625, parse fix in #654/PR #678):
every one of the 3,289 active Idealista listings stored ≤3 photos, because
Idealista truncates its gallery preview server-side. Fixing the parser does
nothing for the 3,289 rows already in the database, and #625's own plan left
"whether that is a backfill or waits for natural re-fetch, and what it costs"
open.

Measured in production before designing anything: `capture_worklist` holds
3,258 Idealista rows, **all** `status='captured'`, all `added_via='derived'`.
Those rows are how the listings got there in the first place — the browser
extension batch-drove them (D-043). All 3,258 still join to a live listing by
`match_key`. So a re-capture transport already exists and is already the one
the extension drains; what was missing was a way to put rows back into it.

**Decision**:

1. **Requeue the existing rows. Do not build a second queue.** Re-capture is
   `status: captured → pending` plus metadata. No new table, no new driver, no
   extension change — the manual batch path consumes `listWorklist()`'s array
   verbatim, so even the drain ORDER BY is a server-side edit.

2. **`requeued_at` / `requeue_reason` / `requeue_rank`, not a sixth status.**
   Flipping to `pending` in place destroys the fact that the row already
   produced data once, and an interrupted pass then leaves a half-drained
   cohort indistinguishable from one that was never captured. Three columns
   carry that distinction *outside* `status`:

   - never captured → `status='pending' AND requeued_at IS NULL`
   - deliberately requeued → `status='pending' AND requeued_at IS NOT NULL`

   `matched_capture_id` is deliberately **not** cleared: the prior capture
   stays linked until a new one replaces it.

3. **Only `captured` rows are eligible.** `skipped` is an owner decision a bulk
   cohort must not overturn; `stale` means the listing left the portal's
   sitemap; `failed` already has a per-row "Reactivar"; `pending` is already
   queued and requeueing it would only reset a rank nobody asked to change.

4. **The cohort is a closed predicate enum** (`few_photos`, `stale_capture`,
   `never_requeued`), resolved server-side, never a client-supplied list of row
   ids — and re-resolved at write time against the count the operator
   confirmed, returning 409 rather than silently writing a different number.

5. **Ordering is frozen at requeue time**, not joined live. `requeue_rank` is
   the position in the value ordering (best profile score, then fewest photos);
   the drain query sorts
   `(CASE WHEN status='pending' THEN requeue_rank END) ASC NULLS FIRST` so every
   never-requeued row keeps exactly the position it has today.

**Alternatives rejected**:

- *A sixth `status` value (`'requeued'`)* — `status` is read by four
  independent consumers (`listWorklist`/`listPendingWorklist`, the per-portal
  roll-ups, `etl/worklist_seed.py`'s `stale` reconciliation, `etl/capture.py`'s
  correlation). Decisively, the extension filters `r.status === 'pending'`
  client-side in `background.js`, so a new value would sit in a state nothing
  drives: a queue that looks busy and never drains. Orthogonal metadata needs
  no consumer to change.
- *`recapture_reason` alone, with no timestamp* — cannot answer "was this row
  requeued during the pass that got interrupted, or one last month".
- *Joining `listing` to `capture_worklist` in SQL to rank live* — the
  correlation is `worklistMatchKey`, which exists in exactly two places
  (`dashboard/lib/worklist.ts`, `etl/capture.py`) kept byte-identical by a
  shared table of cases asserted in **both** test suites. A SQL ORDER BY join
  would be a third copy in a third language with nothing pinning it. The cohort
  resolver instead selects listings in SQL, maps URLs through the existing
  function in TS, and intersects on `match_key = ANY($1)`.
- *Clearing `requeue_rank` when a row leaves `pending`* — would need a write in
  `etl/capture.py` and in every dashboard status writer, and the two would
  drift. Gating the rank inside the ORDER BY needs no cleanup anywhere.
- *A multi-select checkbox list* — the realistic cohort is thousands of rows;
  unusable on a phone and meaningless at that scale.

**Rationale**: the cheapest correct design here is the one that adds the least
new machinery to a transport that already works, while refusing to lose
information that an interrupted bulk pass would otherwise destroy. The three
columns are additive, the status vocabulary is untouched, and every existing
consumer keeps working unchanged.

The cost model is part of the decision, not a footnote. At the extension's
pacing (`batch.js`: base 2000 ms + jitter [0,5000), base stepping +2000 ms per
25 settled pages to a +12000 ms cap → 16.5 s/listing steady state) the full
Idealista cohort is **~14.6 h** of continuous foreground browsing; the
value-ordered subset of live profile candidates is 2,800 rows and **~12.5 h**.
With `ETL_RETAIN_CAPTURE_HTML_FOR=idealista` set in production (D-150) each
capture also stores ~436 KB raw / ~109 KB post-TOAST, i.e. **~1.4 GB raw /
~355 MB on disk** for a full pass against a 203 MB database on a shared
cluster. A bulk requeue must therefore state its time and storage cost before
the confirm arms — which is why the preview endpoint is read-only, measures
retention empirically from the portal's own recent captures rather than
assuming it, and the confirm button carries the count.

Two gates keep a pass from being wasted browsing, and neither is optional.
A portal switched off in Fuentes contributes nothing to a cohort — re-capture
uses D-055's shared `activeSourceClause`/`DISABLED_SOURCES_CTE`, the same
fragment the list feed and the map feed filter by, rather than a third
private notion of "live listing". And a portal with
`connector_config.capture_enabled = false` is refused on the write path
outright: `etl/capture.py::_connector_capture_enabled` would leave every
resulting capture `pending` forever, so a 12-hour session would produce
nothing at all. The preview reports that flag instead of refusing, since GET
never writes.

The value ordering it promises only holds on the MANUAL batch path. Auto mode
drains through `selectNextPendingUrls`, which ranks by portal due-ness and
`created_at` and ignores `requeue_rank` by design (it must stay in step with
`browser-extension/batch.js selectNextPending`). Rather than change
auto-capture's ordering for this feature, the panel tells the operator to
turn Auto off before starting.

Storage figures here are decimal (1 MB = 10^6 B), matching the SI prefixes the
panel renders; `formatBytes` divides by 1000 for the same reason.

**See**: issue #677, issues #625/#654 (the bug and the parse fix this makes
useful), D-043 (batch pacing), D-150 (HTML retention), D-133/D-135 (the
two-step armed confirm pattern), D-120/D-121/D-124 (the mobile rules the panel
follows), `dashboard/lib/db/recapture.ts`, `etl/schema/init.sql`.
