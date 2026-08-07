---
id: D-099
title: Accepted/seguimiento properties are always full-read; a list-price capture optimization skips unchanged listings
date: 2026-08-08
group: Data / connectors
rule: 'Accepted / "en seguimiento" properties (latest feedback = `accept`, matched in an active profile — `_accepted_property_ids`) are ALWAYS full detail-read on every pass — exempt from BOTH skip-if-seen and the #435 optimization (checked first in `_should_skip_fetch`). The #435 list-price capture optimization: where a connector exposes list-page prices (`discovered_prices()`, Fotocasa today), only NEW or price-CHANGED (material ≥1% move, incl. >60% suspect) listings are deep-captured; UNCHANGED (sub-1% vs stored `current_price`) listings are skipped without re-opening the detail page — superseding the staleness window (reason 6) and the history-anchored net (reason 5, which still governs listings with no list price). Connectors without list prices fall back to full capture. Counted as `connector_run_results.skipped_unchanged_count` vs `fetched_count`.'
---

# D-099: Accepted properties always full-read; list-price capture optimization

*Decided: 2026-08-08*

**Context** (issues #435, #436; built on #432/D-098): capturing a results page
re-read *every* listing's detail page (one tab / one `fetch_detail()` per
discovered id) on every pass. Fotocasa's search pages already embed a verified
per-listing price (`discovered_prices()`, the D-070/D-098 mechanism), so most of
that work is redundant — the list already tells us whether the price moved. The
waste is worst in Auto continuous mode (#434), which re-opens hundreds of
unchanged detail pages per cycle. Separately, accepted / "en seguimiento"
properties (D-096: the tracked working set) must be kept maximally up to date and
must never be the ones an optimization skips.

**Decision**:

1. **Accepted/seguimiento always full-read (#436).** `_accepted_property_ids(conn)`
   materialises once per run the set of property ids whose LATEST state-defining
   feedback event (`accept`/`reject`/`star`/`clear`, ordered by `created_at` then
   `id`) is `accept`, matched (`profile_listing_state.matched = true`) in an
   active profile (`search_profile.archived_at IS NULL`) — the same derivation as
   the candidate feed (D-096). `_should_skip_fetch` checks `is_accepted` FIRST and
   returns "fetch" unconditionally, so an accepted property is exempt at BOTH skip
   points: the skip-if-seen staleness window AND the #435 optimization. The set is
   cheap (few rows), shared across every connector/scope, and source-agnostic
   (keyed on property_id, consulted via each listing's property_id).

2. **List-price capture optimization (#435).** In `_should_skip_fetch`, when the
   connector surfaced a list-page price for this listing this run
   (`discovered_price is not None`):
   - price UNCHANGED (not `_observed_price_is_material` vs stored `current_price`,
     i.e. a sub-1% move) → **skip the deep detail read** (we already captured the
     detail; the list confirms the price is stable), regardless of the staleness
     window;
   - price CHANGED (a material move ≥1%, including a >60% suspect) → deep-capture
     this same pass to record the authoritative price (a suspect is confirmed by
     the authoritative fetch, which re-applies D-098's sanity band);
   - stored `current_price` NULL → deep-capture (backfill).
   Placed before the skip-if-seen branches, so for a listing carrying a list price
   it supersedes both the staleness window (reason 6) and the history-anchored
   re-fetch net (reason 5). Reason 5 still governs listings with NO list price
   (e.g. a capture-path observation the fetch budget never confirmed). A NEW
   listing (never fetched) is always fully captured first; the optimization only
   applies from the second pass on.

3. **Per-connector coverage.** Only connectors that override
   `discovered_prices()` with a live-verified list-page price get the
   optimization — **Fotocasa** today (`FotocasaConnector`, sale). Every other
   connector returns `{}` and falls back to full capture (Milanuncios investigated
   and could NOT confirm a reliable list price — D-070; the sitemap/worklist
   capture path carries no list price either). The optimization is thus opt-in per
   connector by construction, mirroring `discovered_prices()`'s own contract.

4. **Counters.** `run_connector` tracks `skipped_unchanged_count` (list-price
   optimization skips) apart from `skipped_count` (skip-if-seen staleness skips);
   `run_all_connectors` sums both and persists `skipped_unchanged_count` on
   `connector_run_results` next to `fetched_count` (deep-captured new/changed) —
   the "saltados por sin-cambio vs deep-capturados" split the issue asked for. A
   skip is categorised without an extra return field: a `_should_skip_fetch` skip
   while a list price is present can only be the unchanged-list-price path (the
   staleness skip is unreachable once a list price short-circuits earlier).

**Alternatives rejected**:
- *Extend the extension/worklist capture path too*: it exposes no per-listing list
  price (sitemap-driven), so it has nothing to optimize on — it stays full-capture
  (the documented fallback), not a special case.
- *Keep D-098's record-now/confirm-next-sweep timing for list-price connectors*:
  #435 deliberately makes the results-page scan drive a SAME-run deep-capture of
  changed listings — deferring would re-open the detail on the next cycle anyway,
  defeating the Auto-mode saving. D-098's invariants (adopt through the sanity
  band; record the change exactly once) are preserved.
- *A staleness backstop that force-refreshes unchanged listings past the window*:
  rejected — the owner's requirement is explicit ("saltar los sin cambios, ya
  tenemos su detalle"); accepted properties (always full-read) cover the working
  set that must stay fresh regardless.

**Rationale**: trust the free, live-verified list price to decide which details
are worth opening; spend fetch budget on new/changed listings and on the tracked
working set, not on re-reading stable inventory every cycle.

**See**: `etl/orchestrator.py` (`_should_skip_fetch`, `_accepted_property_ids`,
`_fetch_freshness_map`, `run_connector`, `run_all_connectors`,
`_record_connector_result`), `etl/connectors/fotocasa.py` (`discovered_prices`),
`etl/schema/init.sql` (`connector_run_results.skipped_unchanged_count`),
`etl/tests/test_orchestrator.py`. Related: D-098 (latest-observed price
authoritative + re-fetch net), D-070 (discovery-price history), D-096 (accept =
seguimiento), D-097 (seguimiento watchlist pass), issue #143 (skip-if-seen).
