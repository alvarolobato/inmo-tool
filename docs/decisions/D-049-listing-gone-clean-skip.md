---
id: D-049
title: A removed listing (HTTP 404/410) is a clean skip, not a per-scope error
date: 2026-08-05
group: Data / connectors
rule: A `fetch_detail` HTTP 404/410 means the listing was removed between discovery and fetch — raise `ListingUnavailableError`; `run_connector` counts it as a clean skip (`gone`), NOT `error_count`. It still records a FATAL breaker error so a wholesale break trips `circuit_open`; never mark withdrawn on one 404; a 200-no-payload soft-block stays a `SoftBlockError` (D-047), never gone.
order: 52
---

# D-049: A removed listing (HTTP 404/410) is a clean skip, not a per-scope error

*Decided: 2026-08-05*

**Context**: essentially every fotocasa / milanuncios scope run reported a
persistent nonzero `connector_run_results.error_count`, consistently ~7–10
(e.g. `estepona: discovered=805 fetched=70 skipped=295 errors=7`;
`sevilla-capital: discovered=1358 fetched=136 errors=7..10`). 136 successful
fetches in the same run rules out a soft-block (which caps fotocasa at ~4–5
fetches before every subsequent request returns HTTP 200 with no payload), so
these were a genuine handful of per-listing fetch failures on an otherwise
healthy sweep — ~5% (7 of ~143 attempted), below the 30% circuit-breaker
threshold, so they never tripped it and simply accumulated every run. Root
cause: a listing surfaced by a `discover()` sweep is routinely removed by the
seller (or expires) in the minutes before the detail fetch reaches it — normal
inventory churn on a live classifieds site. Every connector's `fetch_detail`
called `response.raise_for_status()` and wrapped **all** HTTP errors —
including the `404` a since-removed detail page returns — into a plain
`ConnectorError`, which `etl.orchestrator.run_connector` counted toward
`error_count`. There was no "listing gone" path anywhere (issue #291; this is
the *removed-ad* half of the #66 "removed vs. blocked" ambiguity).

**Decision**: reclassify the unambiguous HTTP-gone case as a clean skip.

1. `fetch_detail` raises `ListingUnavailableError` (a `ConnectorError`
   subclass, `etl/connectors/base.py`) when the detail request fails with an
   HTTP status in `LISTING_GONE_HTTP_STATUSES = {404, 410}`, and a generic
   `ConnectorError` for anything else.
2. `etl.orchestrator.run_connector` catches `ListingUnavailableError` **before**
   its generic per-listing handler and treats it as a clean skip — counted in a
   separate `gone` tally (surfaced in the summary dict as `gone_count` and in
   the per-scope log line), **not** in `error_count`. A normal sweep therefore
   reports `errors=0`; a real, actionable error stays rare.
3. A "gone" listing still records a **FATAL circuit-breaker error** — i.e.
   `breaker.record_error(soft_block=False)` under D-047's two-category breaker
   (fatal vs. soft-block) — even though it is not a run error. A removed
   listing is NOT a soft-block (do not pass `soft_block=True`): a wholesale
   break (the detail-URL shape changed so every real listing 404s) must still
   trip the **fatal** threshold to `circuit_open` rather than the looser
   soft-block threshold, and rather than silently fetching nothing while
   reporting a clean `errors=0`. A dedicated `_GONE_ALARM_RATIO` check
   (default 0.5 of attempted fetches, min 10 attempts) logs the specific
   "detail path likely broke" diagnosis a bare `circuit_open` can't give.
4. A "gone" 404 **never** marks the listing withdrawn: a single 404 is not the
   `_WITHDRAWAL_THRESHOLD`-consecutive-miss evidence withdrawal requires.
5. `run_connector` also logs a per-scope breakdown of the *genuine* remaining
   errors by exception type, so the next real run reveals at a glance what any
   residual errors actually are (the run result stores only an aggregate).

Applies to Fotocasa, Milanuncios, and `MilanunciosRentalConnector` (inherits
`fetch_detail` unchanged). The bank-portal connectors keep their own
removed-listing handling and were left untouched.

**Alternatives rejected**:
- *Not counting "gone" toward the circuit breaker at all* — would let a total
  detail-path break (every fetch 404s) report a silent, clean `errors=0` run,
  the exact silent-failure class this codebase is paranoid about.
- *Marking a listing withdrawn on a single 404* — reintroduces the
  mass-withdrawal hazard `_reconcile_missed_discoveries` guards against the
  moment a URL-shape change makes every listing 404.
- *Reclassifying the 200-with-no-payload page as "gone" too* — that page is the
  soft-block signature (a `SoftBlockError`, D-047); treating it as "gone" would
  hide a real block. `ListingUnavailableError` (gone) and `SoftBlockError`
  (throttle) are distinct sibling `ConnectorError` subclasses that COMPOSE:
  only the HTTP-status-gone case (a raised `RequestException` with a 404/410
  status) is gone; a soft-block never raises one, stays counted in
  `error_count`, and trips only the looser soft-block threshold.
- *Adding a `gone_count` column to `connector_run_results`* — a schema change
  that overlaps PR #270's in-flight rework of that table's status/error
  semantics; deferred. `gone` lives in logs and the `run_connector` return
  dict, which already achieves `error_count=0` on a normal run.

**Rationale**: separates expected inventory churn from actionable failures so
"runs should be clean" is achievable, while the breaker + gone-ratio alarm keep
a genuine outage loud rather than masked.

**See**: issue #291, issue #66; `etl/connectors/base.py`
(`ListingUnavailableError`, `LISTING_GONE_HTTP_STATUSES`), `etl/connectors/
fotocasa.py` / `milanuncios.py` `fetch_detail`, `etl/orchestrator.py`
`run_connector`, `docs/architecture/connectors.md` ("Removed listings are a
clean skip"), tests in `etl/tests/test_orchestrator.py`
(`TestListingGoneReclassification`), `test_connector_fotocasa.py`
(`TestFetchDetailFailureClassification`), `test_connector_milanuncios.py`
(`TestFetchDetail`). Composes with [D-047](D-047-soft-block-clean-outcome.md)
(soft-block / budget classification, #270/#300): the two error schemes are
distinct sibling `ConnectorError` subclasses — this owns the *genuine
removed-listing* side (a clean skip, not counted); D-047 owns the *soft-block /
budget* side (a clean outcome, still counted in `error_count`).
