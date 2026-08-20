---
id: D-133
title: Dedup review queue groups by property pair; reject vetoes the whole pair
date: 2026-08-20
group: Data / connectors
rule: 'Dedup queue groups by property pair. Confirm merges one representative row. Reject persists a `property_merge_veto` binding the WHOLE pair, not just the listing rows shown.'
---

# D-133: Dedup review queue groups by property pair; reject vetoes the whole pair

*Decided: 2026-08-20 — revised 2026-08-20 (PR #611 first review), revised
again 2026-08-20 (PR #611 second, targeted review of the veto subsystem)*

**Context**: Issue #605 (parent spike #600) — the owner, reviewing
duplicates on his phone, reported *"me sale la misma pregunta varias
veces... me estás repitiendo pares"*. Measured on production: 892 pending
`suggested_merge` rows collapse to 669 distinct PROPERTY-pair questions.
Suggestions are keyed on listing pairs — property A with 6 listings and
property B with 7 produce up to 42 listing-pair rows all asking the
identical question. One property pair had 38 pending rows; another 37;
another 19.

Issue #605 shipped in two parts. **Part 1** (PR #610, merged first): the
review query no longer serves a pending pair whose two listings already
share a `property_id` (a stale question left over once some other pair's
merge already unified them) — a `NOT_ALREADY_MERGED` SQL fragment applied
to every read of the pending queue. **Part 2** (this decision): the queue
groups by property pair.

**PR #611's first review caught a real bug in Part 2's first cut** (the
paragraph below is the origin of this decision's first revision — kept
for anyone reading the git history of this file): a grouped card's reject
fanned out to every LISTING-pair row the dashboard's evidence snapshot
showed, via the pre-existing listing-keyed `suggested_merge.status`
skip set. That only ever bound the exact listing pairs shown. Two
multi-listing properties can have listing combinations the queue never
displayed, so a human's rejection left those free to be freshly
suggested, or auto-merged outright, on the very next run. Reproduced
live, twice: rejecting a 2-row card brought the identical question back
within one `ps dedup run`, and in a second case that same next run
auto-merged the exact two properties the human had just rejected — the
review queue literally reversing an explicit "no" without telling
anyone.

**PR #611's SECOND review** (a targeted re-review of just the veto
subsystem, after the design landed) confirmed the design and the repoint
algebra are correct — verified by hand against live Postgres — but found
four more real problems, all fixed in this revision:

- The repoint test was decorative (asserted nothing the code under test
  actually did — see point 3 below for the fix and the honest test).
- This decision's own wording overclaimed what the veto covers ("listing
  combinations that don't exist yet") — false as a general statement; see
  point 3 and issue #612.
- A CORRECT veto refusal, mid-run, crashed the entire ~84-minute dedup
  pass — `_run` had no `try/except` around `perform_merge`, so the
  `ValueError` propagated out of `engine.run()` and every pair after that
  point went uncompared. Not hypothetical: this is exactly what happens
  when the owner taps "Rechazar" on his phone while a pass is already
  running. Fixed — see point 3.
- A veto, once set, had no undo path at all, and `perform_merge`'s
  repoint step can WIDEN a human's veto onto property ids the human never
  looked at (when one of the two vetoed properties later merges into a
  third, unrelated one). Fixed with `ps dedup unveto` — see point 5.

**Decision**: Reject binds at the level the UI asks the question —
PROPERTY pair, not listing pair. Five linked design calls:

1. **Grouping**: `listDedupPropertyPairSuggestions`/`getDedupPropertyPairCounts`
   (`dashboard/lib/dedup.ts`) group every pending row by
   `(LEAST(property_id_a, property_id_b), GREATEST(...))` — reusing Part 1's
   `NOT_ALREADY_MERGED` filter verbatim inside the same `PENDING_PAIR_CTE`.
   One card (`PropertyPairCard`) renders per group, leading with the
   strongest evidence (`confidence DESC`) and listing the rest as
   collapsed, expandable corroborating-evidence rows — never hidden, since
   a bulk reject decision should be informed by ALL the evidence, not just
   the headline pair. A `basis` filter narrows to GROUPS containing at
   least one row of that basis but still returns the group's FULL
   evidence.

   > **UI-copy paragraph SUPERSEDED by [D-135](D-135-dedup-card-photos-and-advert-counts.md)
   > (2026-08-20, issue #615)** — this paragraph originally required every
   > count/label to use `pair_count` and the noun "pares" ("N pares
   > corroborantes" badge, "otros N pares (de M en total)" toggle text).
   > That labeling is exactly what read to the owner as "N adverts of the
   > same property" (a 7-listing property vs. a 13-listing property
   > produced "38 pares", misread as 38 adverts). D-135 replaces the
   > headline badge with per-side ADVERT counts
   > (`listing_count_lo`/`listing_count_hi`, "7 anuncios ↔ 13 anuncios")
   > and relabels the collapsed toggle to "señales" instead of "pares".
   > `pair_count` itself is unchanged and still exists on the type as a
   > `data-pair-count` debug/test attribute (reject blast-radius
   > bookkeeping). It no longer GATES the reject warning either (PR #621
   > review also-fix): that warning now unconditionally names the advert
   > counts, since D-133's veto always binds the whole property pair
   > regardless of how many `suggested_merge` rows happened to be
   > pending — a group can be `pair_count === 1` while its two properties
   > still carry many adverts each. The grouping/confirm/reject/veto
   > mechanics in points 2–5 below are entirely untouched by D-135 and
   > remain binding as written.

2. **Confirm**: acts on exactly ONE representative row — the group's
   strongest evidence (`evidence[0].suggestion_id`) — via the existing
   single-suggestion confirm action (`enqueueDedupAction`/
   `etl/dedup/engine.py confirm_suggestion`). The merge updates
   `listing.property_id` for the confirmed pair; every SIBLING row in the
   group becomes invisible from the queue IMMEDIATELY (Part 1's
   `NOT_ALREADY_MERGED` filter, since both sides now share a property) and
   is formally flipped to `confirmed` in the DB on the dedup engine's next
   scheduled pass (the pre-existing #604 "stale pending same-property" fix
   in `engine.py`'s `_run` loop) — no new backend plumbing needed, and no
   risk of a double-merge race from confirming several sibling rows
   concurrently.

3. **Reject is PROPERTY-level, enforced by a new `property_merge_veto`
   table** (`etl/schema/init.sql`), not a per-listing-pair fan-out. The
   dashboard sends ONE `reject_pair` action against the representative
   suggestion (`POST .../reject-pair`, a new `DedupActionKind`);
   `etl.dedup.engine.reject_property_pair` derives the property pair from
   that suggestion's listings and, in one transaction: marks EVERY
   currently-pending `suggested_merge` row between the two properties as
   `rejected` (re-queried live against current `listing.property_id`, not
   the dashboard's possibly-stale snapshot), and inserts a permanent
   `property_merge_veto(property_lo_id, property_hi_id)` row.
   `engine._run`'s pairwise loop consults the veto set BEFORE
   `evaluate_pair` for every candidate pair — skipping both auto-merge and
   suggestion-filing, not just re-suggestion, for every listing
   combination between the two vetoed property ids, including
   combinations not yet compared. `perform_merge` (the single choke point
   every merge path funnels through, including a direct
   `confirm_suggestion` call on a stale pending row) also refuses outright
   — raises — if ever asked to merge an exactly-vetoed pair, as a
   last-line defense against the race window before the veto's own sweep
   catches a leftover pending row; verified by hand against live Postgres
   in PR #611's second review, including a genuine concurrent-connection
   reproduction. A veto is REPOINTED, never orphaned, when either vetoed
   property later loses an unrelated merge (`perform_merge`'s
   veto-repoint step, `ON CONFLICT (property_lo_id, property_hi_id) DO
   NOTHING` absorbing the case where two independent vetoes repoint onto
   the identical pair) — the properties being merged are, by definition,
   the same real-world unit, so a veto against the losing side must still
   apply to whatever it becomes.

   **What the veto does NOT cover** (PR #611's second review, B-2; tracked
   as issue #612, deliberately not fixed in this PR): a BRAND-NEW listing
   ingested after the veto starts life as its own new `property` row
   (`etl/orchestrator.py`), not attached to either vetoed id. It only
   becomes subject to the veto once it merges onto one of the two vetoed
   ids, and nothing guarantees it picks the correct side —
   `fetch_listing_records` has no `ORDER BY`, so that outcome is
   insertion-order dependent, and the #197 same-source skip can make the
   wrong side the ONLY reachable partner in the most likely real case (a
   re-listed expired advert on the same portal as one side of the vetoed
   pair). Closing that gap needs evidence-level keying, not id-level
   keying, which is a real design task, not a one-line fix. For the
   record: on `main` before this PR, that same scenario would have been
   auto-merged outright with zero veto protection at all, so this PR is a
   strict improvement even with #612 open.

   **A correct veto refusal must never crash the pass** (PR #611's second
   review, M-1 — promoted to a blocker after the reviewer traced it
   through to a live ~84-minute run getting killed mid-flight). The race:
   a concurrent `reject_pair` action can commit a veto for a pair between
   when `_run` loads `vetoed_property_pairs` (once, at the top of the
   run) and when it reaches that exact pair — `perform_merge`'s own
   fresh, transactional check catches it (correctly), but the resulting
   `ValueError` used to propagate all the way out of `engine.run()`,
   `run_dedup` recorded the whole `dedup_runs` row as failed, and every
   pair after that point in the run went uncompared. `_run` now catches
   the `ValueError` at both call sites that can reach `perform_merge`
   (the direct auto-merge branch and the `_reevaluate_pending_suggestion`
   merge branch), counts it on `DedupRunResult.vetoed_merge_refused`, and
   `continue`s. `confirm_suggestion`'s OWN raise is untouched — there, the
   SAME error correctly becomes one `failed` `suggested_merge_action` row
   for one human's one click, not a whole-run failure.

   Because a group reject is a bigger, permanent commitment than the old
   per-listing reject (a veto has no undo path from WITHIN a dedup run —
   same permanence D-024 already established for a listing-level reject,
   just now applied one level up; see point 5 for the actual undo tool),
   the UI (`PropertyPairCard`) requires an explicit SECOND tap before
   submitting — the first tap only reveals a warning naming how many
   pairs will be rejected, plus a cancel option.

4. **Reject is atomic, not a fan-out** — a direct consequence of point 3,
   worth stating on its own: because the property-level reject is ONE
   `suggested_merge_action` row, not N independent HTTP requests (the
   first cut's design), there is no partial-failure state to strand a
   card in. It either resolves or fails as one unit, and a failed request
   can be retried cleanly.

5. **A veto is undoable and observable** (PR #611's second review, M-2 +
   M-3). `engine.remove_property_veto(conn, id_a, id_b)` / `ps dedup
   unveto <id> <id>` deletes a veto row (accepts either id order) — the
   ONLY way to clear one: `ps dedup revert` undoes a MERGE by its
   `property_merge_log` id, and `ps db query` is SELECT-only
   (`cli/lib/sql_guard.py`). This matters specifically because of point
   3's repoint step: it can widen a human's veto onto a property id the
   human never actually looked at, so "sticky by default" needed a real
   escape hatch, not just a theoretical "file a bug." Separately,
   `DedupRunResult` gains `vetoed_pairs_skipped` (every ordinary pair
   skipped because its properties are vetoed — logged/printed in `ps
   dedup run`, same visibility precedent as `same_source_skipped`) and
   `vetoed_merge_refused` (point 3's mid-run race count) — before this,
   veto suppression was completely silent: no counter, no log line, and
   nothing in the CLI or dashboard read `property_merge_veto` at all.

**Alternatives rejected**:
- *Reject only the representative row, or fan out to only the listing
  pairs the dashboard's snapshot showed* (the first cut): rejected — both
  leave the group re-suggestible or auto-mergeable via a listing
  combination the reject never touched. This is not a hypothetical; it
  reproduced live twice in PR #611's first review.
- *Confirm every row in the group via N confirm actions*: rejected —
  once the first confirm lands, every sibling pair's two listings already
  share a property, so calling `confirm_suggestion` on them again would
  hit "already merged" error paths for no benefit; letting the existing
  same-property filter + next-run reevaluation handle it is simpler and
  avoids a race between N concurrent merge attempts on the same property
  pair.
- *Show only the strongest evidence pair, drop the rest*: rejected — the
  owner explicitly needs to see what a bulk reject is discarding before
  discarding it.
- *Evidence-level (not id-level) veto keying, to close #612 in this same
  PR*: rejected — a real design task (persisting enough of a vetoed
  pair's evidence to evaluate a brand-new listing against it, not just
  against whichever property id it already merged into), not a
  fast-follow. Filed separately rather than bundled in, or silently left
  unfixed with an inflated claim about what shipped.

**Rationale**: Confirm's blast radius is bounded and safe to leave to
existing machinery (D-024/#604) — a merge is a merge, and the same-property
filter already makes siblings self-resolve. Reject's blast radius spans
every listing combination between the two vetoed PROPERTY IDS — including
combinations not yet compared between those same two ids — which the old
listing-keyed skip set structurally cannot cover, so it needs its own
persisted, property-level state (`property_merge_veto`) consulted ahead of
every future comparison between those ids, not just an enqueue fan-out at
click time. It does NOT (yet) extend to a brand-new listing that arrives
as a different property id later — that's #612, deliberately out of scope
here.

**See**: issue #605, parent spike #600, PR #611 (both review rounds — the
first caught the listing-vs-property binding bug, the second caught the
decorative repoint test, the overclaimed coverage, the run-killing
refusal, and the missing undo/observability path), issue #612 (the
evidence-level-keying follow-up B-2 filed rather than fixed here),
[D-024](D-024-dedup-pending-reevaluation.md) (reevaluation/skip-set
semantics both confirm and the veto build on), the #604 stale-pending
same-property fix in `etl/dedup/engine.py::_run` that confirm relies on,
Part 1's `dashboard/lib/dedup.ts` `NOT_ALREADY_MERGED`/`PENDING_PAIR_CTE`,
`etl/schema/init.sql` `property_merge_veto` (RESTRICT, not CASCADE, on its
`property` FKs — matches `property_merge_log`'s own intent, since no code
path in this project ever actually deletes a `property` row),
`etl/dedup/engine.py`
`reject_property_pair`/`remove_property_veto`/`_load_vetoed_property_pairs`/
`_resolve_pending_vetoed_property`/`perform_merge`, `etl/dedup/actions.py`,
`etl/dedup/cli.py` (`reject-pair`/`unveto` subcommands),
`dashboard/components/dedup/PropertyPairCard.tsx`,
`dashboard/e2e/dedup-review.spec.ts`, `dashboard/e2e/mobile-dedup.spec.ts`,
`etl/tests/test_dedup_engine.py::TestPropertyPairVeto` (the repoint tests
specifically: the vetoed property must be shown ACTUALLY losing a merge,
and a two-vetoes-repoint-onto-one-pair collision must be exercised — a
version that merges an unrelated pair and calls that proof is decorative,
per PR #611's second review).
