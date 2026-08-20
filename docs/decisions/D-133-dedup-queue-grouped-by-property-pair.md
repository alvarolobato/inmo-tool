---
id: D-133
title: Dedup review queue groups by property pair; reject vetoes the whole pair
date: 2026-08-20
group: Data / connectors
rule: 'Dedup queue groups by property pair. Confirm merges one representative row. Reject persists a `property_merge_veto` binding the WHOLE pair, not just the listing rows shown.'
---

# D-133: Dedup review queue groups by property pair; reject vetoes the whole pair

*Decided: 2026-08-20 — revised 2026-08-20 (PR #611 review)*

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

**PR #611's review caught a real bug in Part 2's first cut** (the
paragraph below is the origin of this decision's revision — kept for
anyone reading the git history of this file): a grouped card's reject
fanned out to every LISTING-pair row the dashboard's evidence snapshot
showed, via the pre-existing listing-keyed `suggested_merge.status`
skip set. That only ever bound the exact listing pairs shown. Two
multi-listing properties can have listing combinations the queue never
displayed (or that don't exist yet — a listing ingested later), so a
human's rejection left those free to be freshly suggested, or
auto-merged outright, on the very next run. Reproduced live, twice:
rejecting a 2-row card brought the identical question back within one
`ps dedup run`, and in a second case that same next run auto-merged the
exact two properties the human had just rejected — the review queue
literally reversing an explicit "no" without telling anyone.

**Decision**: Reject binds at the level the UI asks the question —
PROPERTY pair, not listing pair. Four linked design calls:

1. **Grouping**: `listDedupPropertyPairSuggestions`/`getDedupPropertyPairCounts`
   (`dashboard/lib/dedup.ts`) group every pending row by
   `(LEAST(property_id_a, property_id_b), GREATEST(...))` — reusing Part 1's
   `NOT_ALREADY_MERGED` filter verbatim inside the same `PENDING_PAIR_CTE`.
   One card (`PropertyPairCard`) renders per group, leading with the
   strongest evidence (`confidence DESC`) and listing the rest as
   collapsed, expandable "pares corroborantes" rows — never hidden, since
   a bulk reject decision should be informed by ALL the evidence, not just
   the headline pair. A `basis` filter narrows to GROUPS containing at
   least one row of that basis but still returns the group's FULL
   evidence. Every count/label the UI shows for a group (badge, toggle,
   warning, button) uses the SAME number — `pair.pair_count`, the count of
   corroborating listing-PAIR rows — and the same noun, "pares"; it is
   never labeled "anuncios" (adverts/listings), which can genuinely differ
   from the pair count when one listing appears in more than one pair.

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
   suggestion-filing, not just re-suggestion, for ANY listing combination
   between the two properties, including ones that don't exist yet.
   `perform_merge` (the single choke point every merge path funnels
   through, including a direct `confirm_suggestion` call on a stale
   pending row) also refuses outright — raises — if ever asked to merge an
   exactly-vetoed pair, as a last-line defense against the race window
   before the veto's own sweep catches a leftover pending row. A veto is
   REPOINTED, never orphaned, when either vetoed property later loses an
   unrelated merge (`perform_merge`'s veto-repoint step) — the properties
   being merged are, by definition, the same real-world unit, so a veto
   against the losing side must still apply to whatever it becomes.
   Because a group reject is a bigger, permanent commitment than the old
   per-listing reject (a veto has no undo path — same permanence D-024
   already established for a listing-level reject, just now applied one
   level up), the UI (`PropertyPairCard`) requires an explicit SECOND tap
   before submitting — the first tap only reveals a warning naming how
   many pairs will be rejected, plus a cancel option.

4. **Reject is atomic, not a fan-out** — a direct consequence of point 3,
   worth stating on its own: because the property-level reject is ONE
   `suggested_merge_action` row, not N independent HTTP requests (the
   first cut's design), there is no partial-failure state to strand a
   card in. It either resolves or fails as one unit, and a failed request
   can be retried cleanly.

**Alternatives rejected**:
- *Reject only the representative row, or fan out to only the listing
  pairs the dashboard's snapshot showed* (the first cut): rejected — both
  leave the group re-suggestible or auto-mergeable via a listing
  combination the reject never touched. This is not a hypothetical; it
  reproduced live twice in PR #611's review.
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

**Rationale**: Confirm's blast radius is bounded and safe to leave to
existing machinery (D-024/#604) — a merge is a merge, and the same-property
filter already makes siblings self-resolve. Reject's blast radius is
unbounded (any future listing combination) and the old listing-keyed skip
set structurally cannot cover it, so it needs its own persisted,
property-level state (`property_merge_veto`) consulted ahead of every
future comparison, not just an enqueue fan-out at click time.

**See**: issue #605, parent spike #600, PR #611 (the review that caught
the listing-vs-property binding bug), [D-024](D-024-dedup-pending-reevaluation.md)
(reevaluation/skip-set semantics both confirm and the veto build on),
the #604 stale-pending same-property fix in `etl/dedup/engine.py::_run`
that confirm relies on, Part 1's `dashboard/lib/dedup.ts`
`NOT_ALREADY_MERGED`/`PENDING_PAIR_CTE`, `etl/schema/init.sql`
`property_merge_veto`, `etl/dedup/engine.py`
`reject_property_pair`/`_load_vetoed_property_pairs`/
`_resolve_pending_vetoed_property`, `etl/dedup/actions.py`,
`dashboard/components/dedup/PropertyPairCard.tsx`,
`dashboard/e2e/dedup-review.spec.ts`,
`etl/tests/test_dedup_engine.py::TestPropertyPairVeto`.
