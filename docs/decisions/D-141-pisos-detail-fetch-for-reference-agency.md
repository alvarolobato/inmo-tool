---
id: D-141
title: pisos.com adds one detail fetch per listing, for reference/agency only
date: 2026-08-20
group: Data / connectors
rule: 'PisosConnector fetch_detail() makes ONE real request per listing (revising D-071''s "no detail fetch") to recover reference_code/contact_raw from the detail page''s `features__feature`("Referencia:")/`owner-info__name` blocks — confirmed live 2026-08-20 absent from the search card/JSON-LD (0/30). A failed detail request (non-404) now raises `ConnectorError` (counted, breaker-visible — never a silent green success). `Connector.backfills_missing_reference_code=True` bypasses the #435 unchanged-list-price skip (D-099) for any listing whose stored reference_code is still NULL — required because pisos is ENABLED in production today (not born-disabled as originally assumed) with 331 already-fetched, price-stable listings that would otherwise never be re-fetched.'
---

# D-141: pisos.com adds one detail fetch per listing, for reference/agency only

*Decided: 2026-08-20, revised 2026-08-21 after Opus review*

> ## REVISES (2026-08-20) — see [D-071](D-071-pisos-search-payload-connector.md)

**Context**: Issue #628, raised from a real pair the owner flagged as
obviously the same property (fotocasa vs. pisos, matching price/m²/rooms/
city) that the dedup queue was asking him to judge by eye instead of
matching automatically — because `reference_code`/`contact_raw` were
captured on the fotocasa side only. Coverage query against the corpus
confirmed pisos at 0/315 for both fields, and cross-checking the pending
dedup queue found pisos the SINGLE LARGEST contributor to the pending
pairs carrying a reference on only one side (see D-140 for the full
measurement).

D-071 explicitly designed `PisosConnector` as search-payload-primary with
**no detail fetch at all**, on the grounds (verified at the time) that the
detail page carries "NO JSON-LD... strictly poorer than the search card,"
and its own "Alternatives rejected" section dismissed a per-listing detail
fetch as "unnecessary and worse... for zero field gain." That reasoning
no longer holds for two specific fields.

A fresh live spike (2026-08-20, honest UA, respecting `robots.txt` — the
same host D-071 already verified allows both `/venta/...` and
`/comprar/...`) fetched a real pisos.com search page (30 cards) and
confirmed, as before, that NEITHER the card markup NOR its per-card
JSON-LD carries a reference code or agency name anywhere (0/30). The
listing's own DETAIL page, however, does carry both:

- `div.features__feature` containing `span.features__label` text
  "Referencia:" with the code in a sibling `span.features__value`
  (real value observed, not committed to any fixture — see AGENTS.md's
  no-scraped-content rule; only the markup SHAPE is documented, in
  `pisos_mapping.py`'s docstrings and a fully synthetic test fixture —
  after the 2026-08-21 review, even the docstrings themselves now carry
  only placeholder example values, never the real captured strings).
- `p.owner-info__name` (inside `.owner-info__header`) with the agency's
  display name, linking to its own `/inmobiliaria-<slug>/` profile page.

So the field IS published — just not where D-071 looked.

**Decision**: `PisosConnector.fetch_detail()` now makes ONE real HTTP
request per listing (`throttle()`-paced, same as every other detail-
fetching connector) to the detail URL discover() already resolved, purely
to extract `reference_code`/`contact_raw` via two new pure functions in
`pisos_mapping.py` (`extract_reference_code`/`extract_agency_name`).
Every other canonical field (price, rooms, baths, m², floor, coordinates,
photos, city/province) is UNCHANGED — still read from the search card and
its JSON-LD, with zero extra requests. A 404/410 on the detail URL raises
`ListingUnavailableError` (the listing was withdrawn between discovery and
fetch), consistent with every other connector's D-049 handling.

**Revision (2026-08-21, Opus review of PR #632) — three must-fix findings,
all fixed before merge:**

1. **The connector is NOT born-disabled — it is live in production.** The
   original version of this decision asserted "safe today: born
   disabled" without checking. A live, read-only production check found:

   ```
   connector_name | enabled | capture_enabled
   pisos          | t       | t
   ```

   331 pisos sale listings, ALL already fetched (`last_fetched_at`
   populated), ALL `status='active'`, ALL carrying a stored
   `current_price`, and 0/331 with a `reference_code`. Corrected
   throughout this record and the PR — never assert a connector's
   enabled state from a stale comment; check `connector_config`.

2. **Given finding 1, the #435 unchanged-list-price optimization (D-099)
   would have skipped every one of those 331 listings forever.** pisos
   implements `discovered_prices()`, so it participates in D-099's
   list-price capture optimization: an already-fetched listing whose
   list price is unchanged skips the deep detail read entirely —
   `fetch_detail()` (hence the new reference/agency extraction) simply
   never runs for it. Since all 331 already have a stable stored price,
   every one would be skipped on every future run, keeping
   `reference_code` permanently `NULL` and defeating this issue's own
   exit criterion. Fixed with a new, opt-in `Connector` capability flag,
   `backfills_missing_reference_code` (default `False`, set `True` only
   on `PisosConnector`): `etl.orchestrator._should_skip_fetch` now checks
   it FIRST, ahead of the #435 skip and every other reason — when the
   flag is set AND the stored `reference_code` is falsy, it forces a real
   fetch unconditionally. `_fetch_freshness_map`'s batched query gained
   `reference_code` to support this (inert for every other connector,
   which never sets the flag). No separate "already tried, give up" bit —
   a listing that genuinely has no published reference stays `NULL` and
   gets re-tried every run; acceptable for pisos's small (~300-listing)
   footprint at its moderate rate limit, revisit with a give-up counter
   if this flag is ever set on a much larger connector.
3. **A non-404 detail-request failure must not read as a clean success.**
   The original version caught every `RequestException` other than
   404/410, logged a warning, and returned a `RawListing` with
   `reference_code=None`/`contact_raw=None` — which `run_connector`
   counts as `fetched += 1` with `breaker.record_success()`. A WAF block,
   timeout, or 5xx on the new detail GET would therefore report as a
   fully healthy run (green status, N listings "fetched") while quietly
   never populating a single reference — defeating D-047 (soft-block
   visibility) and D-069 (run hygiene: green means actually healthy).
   `fetch_detail()` now raises `ConnectorError` on any non-404 failure,
   exactly matching every other detail-fetching connector's own handling
   (e.g. `milanuncios.py`) — it counts as a real error and can trip the
   circuit breaker like any other fetch failure. The 404/410 → clean-skip
   path (D-049) is unchanged.

**Why this is bounded despite pisos being live, not disabled**: pisos's
own rate limit (`rate_limit_per_minute = 6`) and small inventory
(~300-listing footprint from a page-1-only sweep, `discovers_full_
inventory = False`) keep the added per-listing detail request's cost
modest — roughly 300 extra requests spread across however many scopes run,
not an unbounded crawl. The backfill exemption (finding 2) is what makes
the fix actually take effect against the real, already-populated
production data, not just future new listings.

**Alternatives rejected**:
- *Leave pisos's reference/agency permanently unmapped* — rejected: this
  is the single largest contributor to the corpus's one-sided-reference
  gap (D-140), and the owner's own flagged example is a pisos-side
  listing.
- *A lighter partial fetch (HEAD request, or range-request the page head)*
  — considered and rejected: the reference/agency blocks are deep enough
  in the page (past the photo carousel and most feature rows) that a
  partial fetch offers no meaningful savings over a normal GET, and adds
  complexity (partial-HTML parsing) for no real benefit.
- *Guess the reference from the card's numeric id* — already rejected by
  D-071 itself (the id is pisos.com's own ad id, not a seller reference)
  and still correct; not revisited here.
- *Degrade silently on a failed detail request* (the ORIGINAL, pre-review
  version of this decision) — rejected per finding 3 above: a broken run
  must be visible as broken, not read as green.
- *A blanket "missing reference_code always forces a fetch" rule for
  every connector* — rejected: only a connector that actually opts in via
  `backfills_missing_reference_code` gets the exemption; a connector that
  structurally cannot populate the field (milanuncios today, cimenta2,
  vivantial — see D-628's per-portal findings) must not be forced into an
  endless, pointless re-fetch loop.

**Rationale**: two real, previously-unmapped fields directly unblock the
majority of a real, owner-flagged dedup gap, at a bounded, opt-in-only
cost — and, once the review corrected the "born disabled" assumption, the
fix had to also make sure it actually reaches the already-live production
data (finding 2) and reports honestly when it fails (finding 3), not just
work in principle.

**See**: `etl/connectors/pisos.py`, `etl/connectors/pisos_mapping.py`,
`etl/connectors/base.py` (`Connector.backfills_missing_reference_code`),
`etl/orchestrator.py` (`_should_skip_fetch`, `_fetch_freshness_map`),
`etl/tests/test_connector_pisos.py`,
`etl/tests/test_orchestrator.py`'s `TestReferenceCodeBackfillExemption`,
`etl/tests/fixtures/pisos_sample_detail.html` (synthetic),
`etl/tests/fixtures/pisos_sample_detail_no_reference.html` (synthetic),
issues #628/#629, [D-071](D-071-pisos-search-payload-connector.md)
(revised), [D-140](D-140-reference-code-relaxed-normalizer.md) (the
matching/veto-side fix this lands alongside).
