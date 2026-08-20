---
id: D-133
title: Dedup review queue groups by property pair, not listing pair
date: 2026-08-20
group: Data / connectors
rule: The dedup review queue (`/admin/dedup`) groups pending `suggested_merge` rows by property pair, not listing pair; confirm acts on one representative row (siblings self-resolve via issue #605 Part 1's same-property filter + the existing per-run reevaluation); reject requires an explicit second tap and atomically rejects every underlying row in the group.
---

# D-133: Dedup review queue groups by property pair, not listing pair

*Decided: 2026-08-20*

**Context**: Issue #605 (parent spike #600) — the owner, reviewing duplicates
on his phone, reported *"me sale la misma pregunta varias veces... me estás
repitiendo pares"*. Measured on production: 892 pending `suggested_merge`
rows collapse to 669 distinct PROPERTY-pair questions. Suggestions are keyed
on listing pairs — property A with 6 listings and property B with 7 produce
up to 42 listing-pair rows all asking the identical question. One property
pair had 38 pending rows; another 37; another 19.

Issue #605 shipped in two parts. **Part 1** (PR #610, merged first): the
review query no longer serves a pending pair whose two listings already
share a `property_id` (a stale question left over once some other pair's
merge already unified them) — a `NOT_ALREADY_MERGED` SQL fragment applied
to every read of the pending queue. **Part 2** (this decision): the queue
groups by property pair.

**Decision**: Three linked design calls, made explicit here because #605
asked for them to be stated rather than left implicit:

1. **Grouping**: `listDedupPropertyPairSuggestions`/`getDedupPropertyPairCounts`
   (`dashboard/lib/dedup.ts`) group every pending row by
   `(LEAST(property_id_a, property_id_b), GREATEST(...))` — reusing Part 1's
   `NOT_ALREADY_MERGED` filter verbatim inside the same `PENDING_PAIR_CTE`.
   One card (`PropertyPairCard`) renders per group, leading with the
   strongest evidence (`confidence DESC`) and listing the rest as
   collapsed, expandable "corroborating evidence" rows — never hidden,
   since a bulk reject decision should be informed by ALL the evidence, not
   just the headline pair. A `basis` filter narrows to GROUPS containing at
   least one row of that basis but still returns the group's FULL evidence.

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

3. **Reject**: fans out to EVERY underlying pending row in the group (one
   `reject` action per `suggestion_id`, all enqueued and polled to
   completion). A representative-only reject was rejected as a design: a
   rejected `suggested_merge` row freezes forever (`_load_recorded_pairs`
   keeps `rejected` in its permanent skip set — see D-024), so leaving 37
   sibling rows `pending` after "rejecting" a 38-row group would make the
   group reappear immediately, defeating the whole point of grouping.
   Because a group reject is therefore a bigger, permanent commitment than
   the old per-listing reject, the UI (`PropertyPairCard`) requires an
   explicit SECOND tap — the first tap only reveals a warning naming how
   many pairs will be rejected and a cancel option; nothing is submitted
   until the second tap. If any of the N reject calls fails, the card
   stays and reports how many succeeded vs. failed rather than silently
   claiming success.

**Alternatives rejected**:
- *Reject only the representative row*: rejected — leaves the group
  visibly unresolved (see point 3 above).
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
existing machinery (D-024/#604); reject's blast radius is unbounded and
permanent, so it gets an explicit UI speed bump. Both preserve the
single-suggestion action routes (`/api/dedup/suggestions/[id]/confirm`,
`/reject`) as the only mutation surface — no new backend action endpoints,
only a new grouped READ path (`GET /api/dedup/property-pairs`).

**See**: issue #605, parent spike #600, [D-024](D-024-dedup-pending-reevaluation.md)
(reevaluation/skip-set semantics reject relies on), the #604 stale-pending
same-property fix in `etl/dedup/engine.py::_run` that confirm relies on,
Part 1's `dashboard/lib/dedup.ts` `NOT_ALREADY_MERGED`/`PENDING_PAIR_CTE`,
`dashboard/components/dedup/PropertyPairCard.tsx`,
`dashboard/e2e/dedup-review.spec.ts`.
