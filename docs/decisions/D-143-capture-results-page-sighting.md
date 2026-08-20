---
id: D-143
title: A captured results page bumps last_seen_at for the listings it enumerates
date: 2026-08-21
group: Data / connectors
rule: A captured SEARCH/results page bumps `last_seen_at` for every already-known listing its harvested detail links match (via `external_id_from_url`) — never `status`, never `last_fetched_at`. A sighting proves "still listed", not "re-read".
---

# D-143: A captured results page bumps `last_seen_at` for the listings it enumerates

*Decided: 2026-08-21*

**Context**: Issue #639, part of the #636 monitoring/withdrawal redesign.
Fable's design judgement on #636 found that a captured results page never
updated `listing.last_seen_at` — `etl/capture.py`'s `_process_one` classified
a listing/search page, harvested its detail URLs into `capture_worklist` via
`_seed_derived_worklist`, and stopped. Only a full detail-page capture (or the
crawl path's own `discover()` sweep, via `etl.orchestrator.
_update_last_seen_for_discovered`) ever touched the row. Measured in
production (2026-08-20): idealista had 3,274 active listings, only 74 seen
≤2d, and 1,098 seen >7d — while the owner was capturing idealista search
pages regularly. A large share of that "stale" count was an artefact of the
ledger not recording an enumeration as a sighting, not of the listings
actually being gone. Every downstream staleness signal (D-039's badges, the
#636 Estado board, and the withdrawal/expiry design in #641/#643/#645) reads
`last_seen_at`, so this needed fixing before any of those act on it.

**Decision**: `etl/capture.py`'s `_process_one`, when it recognises a
captured page as a results/listing page, now calls `_record_sightings(conn,
portal, detail_urls)` right after `_seed_derived_worklist`. That function
extracts external_ids from the harvested detail URLs via each portal's own
`external_id_from_url` (the same id extraction `_connector_for_url` already
uses for a single detail capture — new `_CONNECTOR_CLASS_BY_PORTAL`, derived
from the existing `_CAPTURE_CONNECTORS` table so there is one list of
capture-supported portals, not two) and delegates the actual `UPDATE` to
`etl.orchestrator._update_last_seen_for_discovered` — the exact mechanism the
crawl path already uses to bump presence for listings a `discover()` sweep
re-confirmed without fetching their detail page. Reused rather than
reimplemented, so the two ingestion paths write the exact same SQL for the
exact same claim.

A **sighting is weaker than a verification**: it proves the advert is still
listed, not that its fields were re-read. So this only ever writes
`last_seen_at` — never `status` (only a real `fetch_detail()`/`normalize()`
call may change that) and never `last_fetched_at` (the signal skip-if-seen
gates on, per `etl.orchestrator._update_existing_listing`'s own docstring — a
sighting must not make a stale listing look freshly re-fetched and get
skipped from the fetch budget it still needs).

A page with zero matches against known listings is a clean no-op, not an
error (D-069) — best-effort, wrapped so a failure here can never turn an
already-clean 'listing page' outcome into a failed capture.

**Backfill**: not attempted, and not possible in the general case. Past
enumerations were never recorded, so there is no way to reconstruct which
listings a historical results-page capture actually saw — the gap in the
ledger is permanent for everything before this change. Consequence for
#643's heuristic-expiry design: its unseen-window clock effectively starts
now for captured portals, not at each listing's true last real sighting: a
listing that has genuinely been gone for months will read as merely
"unseen since this deploy" until enough new capture sessions accumulate
sighting data past it. That is a one-time, self-healing understatement (every
future capture narrows it), not a standing correctness problem — but #643
should not assume the pre-existing `last_seen_at` values on captured-portal
listings reflect real historical sighting cadence.

**No existing consumer assumed something stronger.** Checked every dashboard
reader of `last_seen_at` (`lib/staleness.ts`, `lib/candidates.ts`,
`lib/ai-assessment/cache.ts`, `lib/db/data-health.ts`): all of them already
treat it as a presence-only signal — `staleness.ts`'s own module docstring
explicitly contrasts it with `last_fetched_at` ("a scraping-budget signal")
and `ai-assessment/cache.ts` explicitly excludes a `last_seen_at` bump from
its cache-invalidation hash. `staleness.ts`'s docstring credits only the
`discover()` sweep as the source of a bump; it is now also true of a captured
results-page enumeration, but no code path needed to change — the semantics
it already documents ("re-confirmed", not "re-read") were correct in advance
of this fix.

**Alternatives rejected**: extracting external_ids from `capture_worklist`'s
`match_key` instead of each connector's `external_id_from_url` — rejected
because `match_key` is a host+path correlation key (issue #237), not the
canonical external_id the `listing` table is keyed on; reusing
`external_id_from_url` keeps exactly one id-extraction path per portal.
Writing a second, capture-scoped copy of the `UPDATE listing SET
last_seen_at = NOW() WHERE source = %s AND external_id = ANY(%s)` — rejected
per the project's own reuse instinct: `etl.orchestrator.
_update_last_seen_for_discovered` already is that statement.

**See**: `etl/capture.py` (`_record_sightings`, `_sighting_ids_from_detail_urls`,
`_CONNECTOR_CLASS_BY_PORTAL`), `etl/orchestrator.py`
(`_update_last_seen_for_discovered`), `etl/tests/test_capture.py`
(`TestListingPageSightingsBumpLastSeen`), issue #639, parent #636,
[D-039](D-039-listing-staleness-surfacing.md), [D-069](D-069-etl-run-hygiene.md).
