---
id: D-143
title: A captured/enumerated results page bumps last_seen_at for the listings it lists
date: 2026-08-21
group: Data / connectors
rule: Both the manual single-page capture path (etl/capture.py) AND the real production D-088 enumeration path (dashboard lib/db/worklist.ts addWorklistUrls, via='derived') bump `listing.last_seen_at` — GREATEST-based, at the true observation instant, never `status`/`last_fetched_at`, never a portal's own "gone" route.
---

# D-143: A captured/enumerated results page bumps `last_seen_at` for the listings it lists

*Decided: 2026-08-21*

**Context**: Issue #639, part of the #636 monitoring/withdrawal redesign.
Fable's design judgement on #636 found that a captured results page never
updated `listing.last_seen_at` — `etl/capture.py`'s `_process_one` classified
a listing/search page, harvested its detail URLs into `capture_worklist` via
`_seed_derived_worklist`, and stopped. Measured in production (2026-08-20):
idealista had 3,274 active listings, only 74 seen ≤2d, and 1,098 seen >7d —
while the owner was capturing idealista search pages regularly. Every
downstream staleness signal (D-039's badges, the #636 Estado board, and the
withdrawal/expiry design in #641/#643/#645) reads `last_seen_at`, so this
needed fixing before any of those act on it.

**First pass and its review.** The first implementation added
`etl.capture._record_sightings`, called from `_process_one`'s results-page
branch. A fresh-context Opus review (D-003) found it correct in isolation but
**unreachable in production**: measured against production `extension_capture`
(08-04→08-20), 3,517 rows, `listing` status count **0** — the D-088
results-page walk that actually enumerates idealista never posts HTML to
`POST /api/extension/capture` at all (`popup.js` routes a recognised listing
page to `enterBatchMode`, never `runSingleCapture`; `content-script.js` gates
auto-capture on `currentDetail()`). It POSTs harvested detail URLs straight to
`POST /api/etl/worklist { via: 'derived' }` (3,325 rows measured against
idealista's 3,274 actives — the enumeration was unambiguously happening, just
recorded nowhere). The review also found the URL→id extraction not equivalent
to the classifier that gates it (C4), the write time wrong for a delayed
capture (C2), and a portal's own "this listing is gone" route counting as a
sighting of it still being live (C3). See PR review comments on the issue for
the full C1–C4/M1/M2 finding; this record documents the corrected design.

**Decision — two languages, one semantics.**

1. **The real production path**: `dashboard/lib/db/worklist.ts`
   `addWorklistUrls`, when `addedVia === 'derived'`, collects every
   valid, portal-resolved `(portal, url)` pair in the batch (added AND
   duplicate outcomes both count — a duplicate still means this enumeration
   re-confirmed a listing it already knew) and calls a new
   `recordSightings()`, which extracts external_ids via
   `dashboard/lib/capture-sightings.ts` (`sightingIdsByPortal`) and issues one
   `UPDATE listing SET last_seen_at = GREATEST(last_seen_at, NOW()) WHERE
   source = $1 AND external_id = ANY($2)` per portal. Best-effort — a failure
   is logged, never turns a successful worklist POST into an error. Scoped to
   `via: 'derived'` only (not `'manual'`), matching the review's own framing
   of the enumeration path.
2. **The manual/single-page capture path** (kept — real, just not the
   production volume): `etl/capture.py`'s `_process_one`, on a recognised
   results/listing page, calls `_record_sightings(conn, portal, detail_urls,
   created_at)` right after `_seed_derived_worklist`, which delegates to
   `etl.orchestrator._update_last_seen_for_discovered` (also `GREATEST`-based
   now — see below).

**Why a two-language mirror was unavoidable here, not a design shortcut**:
the write has to happen where the enumeration actually arrives —
dashboard-side, in TypeScript, inside `addWorklistUrls` — while
`etl/capture.py`'s Python path stays alive for a real, if lower-volume, case
(a manually-captured single results page). There is no shared runtime
between the ETL container and the dashboard container (the same reason
`extension_capture` is a polled queue table rather than a synchronous call —
see that table's own schema comment), so one implementation in one language
was never on the table; the only real choice was how tightly the two stay
bound.

Both languages share the SAME id-extraction shape (`_sighting_id_from_url` /
`sightingIdFromUrl`), and — per a second Opus review's own follow-up finding
— they are bound MECHANICALLY, not by convention: both suites
(`etl/tests/test_capture.py::TestSightingIdExtraction` /
`dashboard/lib/__tests__/capture-sightings.test.ts`) read the literal SAME
fixture file, `etl/tests/fixtures/sighting_ids.json` (22 `{portal, url,
expected}` cases), rather than each hard-coding its own copy. This is
deliberately a STRICTER pattern than this codebase's existing
`listing_detect.py`/`detect.js` and `worklist_match_key`/`worklistMatchKey`
mirrors, which are each covered by two independently-authored case tables
asserted to the same expected values — correct in intent, but a silent
drift between the two tables (one language's list quietly missing a case
the other added) would still pass both suites. That gap is real: as of this
writing `listing_detect.py`/`detect.js` (D-069) has NO parity test at all
between the two files, maintained by a docstring's "MUST stay byte-for-byte
equivalent" alone. Not a reason to repeat it here — a rule this important
(it is the presence signal #643/#645's expiry logic will trust) drifting
silently between two hand-maintained lists is exactly the failure mode this
project has been bitten by twice in one week, so this one sets the better
pattern: a shape one language's regex accepts and the other rejects now
fails a shared-fixture test in BOTH suites, rather than aging into a wrong
expiry months later with nothing pointing back here.

- **C4 (URL normalization)**: a harvested `<a href>` or enumerated URL can
  carry a query string, a fragment, or lack the trailing slash a connector's
  `external_id_from_url` regex was calibrated for (that regex trusts a real
  browser's `location.href`, the OTHER call site that also uses it
  unrelaxed). `_normalize_detail_path` (Python) / `normalizeDetailPath` (TS)
  strip query/fragment and guarantee a trailing slash on the PATH ALONE
  before extraction — never loosening any connector's own regex, which stays
  exactly as strict for the real-URL call site.
- **C3 (gone-route exclusion)**: hipoges' detail route accepts a same-id
  suffix for "this advert is gone" (`.../detail/<id>/unavailable`,
  `.../detail/<id>/contact-received`) — a link shaped like this on a results
  page must never count as a sighting of the advert still being live.
  `_GONE_URL_SUFFIXES` (Python) / `GONE_URL_SUFFIXES` (TS) excludes it before
  id extraction.
- **C2 (observation time, not processing time)**: `etl.orchestrator.
  _update_last_seen_for_discovered` gained an optional `seen_at` parameter
  (default NOW()) and its write is now `GREATEST(last_seen_at, seen_at)`, not
  a blind overwrite. `etl.capture._record_sightings` passes the capture row's
  own `extension_capture.created_at` — a captured page can sit `pending` for
  hours (a paused connector, an outage) before being processed, and stamping
  NOW() at processing time would record a sighting that never happened at
  that moment, in the exact column #643/#645 will trust. The dashboard's
  `recordSightings` runs synchronously in the request that just harvested the
  URLs (no equivalent queue delay), so it uses NOW() directly; `GREATEST`
  still guards it against a rarer concurrent-write race. Either way the write
  can only move `last_seen_at` forward, never backward past a more recent
  sighting some other path already recorded.
- **M1 (honest count)**: `_update_last_seen_for_discovered` now returns the
  UPDATE's actual `cur.rowcount`, and `_record_sightings` returns that
  through — not `len(external_ids)`, which only says how many ids were
  targeted, not how many matched an ingested listing (the review's own
  example: a page with 30 links and 0 matching rows must never log "30
  sighted"). `_record_sightings` also logs a drop count when
  `len(urls) - len(external_ids)` is nonzero, so a systematic extraction gap
  is visible.

A **sighting is weaker than a verification**: it proves the advert is still
listed, not that its fields were re-read. So this only ever writes
`last_seen_at` — never `status` (only a real `fetch_detail()`/`normalize()`
call may change that) and never `last_fetched_at` (the signal skip-if-seen
gates on, per `etl.orchestrator._update_existing_listing`'s own docstring — a
sighting must not make a stale listing look freshly re-fetched and get
skipped from the fetch budget it still needs).

A page with zero matches against known listings is a clean no-op, not an
error (D-069) — best-effort on both languages' sides, wrapped so a failure
here can never turn an already-clean 'listing page'/worklist-add outcome into
a failure.

**M2 — a known, accepted side effect, not fixed here**: `etl.
materialize_reconciler._stale_profiles_exist` treats `MAX(GREATEST(
last_seen_at, last_fetched_at, first_seen_at))` across `listing` as "is there
new data" — a sighting-only bump (no field actually changed) now makes it see
"new data" and fire `notify_materialize_all` (D-046) after every enumerated
capture batch, even when nothing substantive changed. This is benign (the
reconciler pass is best-effort and idempotent by design, per D-046) but is
now measurably more frequent; not worth a special-case exclusion given the
mechanism's own idempotency guarantee, but noted here so a future investigator
of "why does the reconciler fire so often" finds the cause immediately.

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
`lib/ai-assessment/cache.ts`, `lib/db/data-health.ts`, `lib/property-detail.ts`,
`app/etl/salud/page.tsx`, `etl/materialize_reconciler.py`): all of them
already treat it as a presence-only signal — `staleness.ts`'s own module
docstring explicitly contrasts it with `last_fetched_at` ("a scraping-budget
signal") and `ai-assessment/cache.ts` explicitly excludes a `last_seen_at`
bump from its cache-invalidation hash. `staleness.ts`'s docstring credits
only the `discover()` sweep as the source of a bump; it is now also true of
an enumerated/captured results page, but no reader code path needed to
change — the semantics it already documents ("re-confirmed", not "re-read")
were correct in advance of this fix. `materialize_reconciler.py` is the one
consumer whose BEHAVIOUR (frequency, not correctness) shifts — see M2 above.

**Alternatives rejected**: extracting external_ids from `capture_worklist`'s
`match_key` instead of each connector's `external_id_from_url` — rejected
because `match_key` is a host+path correlation key (issue #237), not the
canonical external_id the `listing` table is keyed on. Writing a second,
capture-scoped copy of `UPDATE listing SET last_seen_at = ...` — rejected per
the project's own reuse instinct: `etl.orchestrator.
_update_last_seen_for_discovered` already is that statement, extended (not
duplicated) with `seen_at`/`GREATEST`. Relaxing each connector's
`external_id_from_url` regex directly (instead of normalizing the harvested
URL before calling it) — rejected because that regex is also used UNRELAXED
on a real captured URL in `_connector_for_url`; loosening it there risks a
spurious id match on a URL that never went through the classifier at all.

**See**: `etl/capture.py` (`_record_sightings`, `_sighting_id_from_url`,
`_sighting_ids_from_detail_urls`, `_normalize_detail_path`,
`_GONE_URL_SUFFIXES`, `_CONNECTOR_CLASS_BY_PORTAL`), `etl/orchestrator.py`
(`_update_last_seen_for_discovered` — see its own docstring and the inline
comments at both its call sites in `run_connector` for the C2 clock-source
regression), `dashboard/lib/capture-sightings.ts`, `dashboard/lib/db/worklist.ts`
(`addWorklistUrls`, `recordSightings`), the shared fixture
`etl/tests/fixtures/sighting_ids.json`, `etl/tests/test_capture.py`
(`TestListingPageSightingsBumpLastSeen`, `TestSightingIdExtraction`),
`dashboard/lib/__tests__/capture-sightings.test.ts`,
`dashboard/lib/db/__tests__/worklist-sightings.integration.test.ts`, issue
#639, parent #636, [D-039](D-039-listing-staleness-surfacing.md),
[D-046](D-046-materialize-staleness-reconciler.md),
[D-069](D-069-etl-run-hygiene.md).
