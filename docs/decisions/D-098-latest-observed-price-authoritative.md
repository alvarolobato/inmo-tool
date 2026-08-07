---
id: D-098
title: Most-recent observed price is authoritative for current_price; re-fetch net re-anchored
date: 2026-08-07
group: Data / connectors
rule: 'The most-recent OBSERVED price is authoritative everywhere (header/card, below-market %, scoring): every price-history write site (discovery `_record_discovery_price_observations`, capture/fetch `_update_existing_listing`) adopts it as `listing.current_price` through a sanity band (`_observed_price_is_adoptable`: adopt a move inside [1%, 60%]; a >60% suspect is still recorded to history but never adopted; sub-1% noise is ignored). Revises D-070 (`current_price` no longer fetch-path-owned). The price-change re-fetch net is preserved but re-anchored: `_should_skip_fetch` reason #5 fires when the latest `listing_price_history.observed_at > last_fetched_at` (an unconfirmed observation), not when discovery price ≠ stored price. init.sql carries an idempotent backfill.'
---

# D-098: Most-recent observed price is authoritative for `current_price`; re-fetch net re-anchored

*Decided: 2026-08-07*

**Context**: Property 1739 displayed a stale price — the header/card showed
157,000 € while the price history, the trend graph, and the below-market badge
all showed 146,000 € (a real −7% drop). Root cause: [D-070](D-070-discovery-price-history.md)
deliberately left `listing.current_price` **fetch-path-owned**. A price drop
seen at discovery time (or via a browser-extension capture) was written to
`listing_price_history` and was *supposed* to force a confirming re-fetch that
would update `current_price` — but that re-fetch is bounded by the fetch budget
(circuit breaker, rate limit, `min_refetch_interval_seconds`), so during a
backfill the confirmation lagged for hours-to-days. Meanwhile the header, card,
below-market %, and scoring all read `current_price`, so the displayed and
deal-math price stayed stale while every history-derived surface already showed
the drop. ~8 listings were diverged at decision time.

D-070's point 4 spelled out *why* `current_price` was fetch-owned: the
price-change re-fetch trigger (`_should_skip_fetch` reason #5) compared the
discovery price to the stored `current_price`, so updating `current_price` from
discovery would make that comparison equal and the trigger would go silent.
That coupling is real — this decision breaks it by re-anchoring the trigger to a
different, more correct signal, rather than by leaving the display stale.

The owner chose **Option A**: the most-recent *observed* price becomes
authoritative everywhere.

**Decision**:

1. **`current_price` = latest observed price, at every write site.** Discovery
   (`_record_discovery_price_observations`), and capture/fetch (both routed
   through `_update_existing_listing`) adopt the newly-observed price as
   `listing.current_price`. Below-market %, scoring, filters, and the detail
   header/card already read `current_price`, so they auto-correct with no
   change of their own.

2. **Phase-2 sanity band guards `current_price`.** A raw observation can be
   junk (a parse glitch, a "consultar precio" placeholder, a dropped digit), so
   adoption goes through `_observed_price_is_adoptable(old, new)`:
   - `< 1%` move → **noise**: not adopted, not even recorded to history
     (`_observed_price_is_material`), so it can't drive a wasteful re-fetch.
   - `1%–60%` move → **adopted** as `current_price` and recorded to history.
   - `> 60%` move → **suspect**: recorded to history (so the discrepancy is
     visible and the re-fetch net can confirm it) but **never** adopted as
     `current_price`. A genuinely huge move stays visible in history without
     corrupting the displayed/deal-math price; the authoritative fetch path
     applies the same band, so a real crash-price is not silently trusted from
     one observation.
   - No comparable baseline (`old` NULL/≤0) → adopt (a backfill, not a move).

3. **D-070's re-fetch net is preserved but re-anchored.**
   `_should_skip_fetch` reason #5 now forces a re-fetch when the listing's
   latest `listing_price_history.observed_at` is **newer than
   `last_fetched_at`** — i.e. an observation exists that no authoritative
   detail fetch has confirmed yet. Discovery writes history at `NOW()` without
   touching `last_fetched_at`, so this fires on the *next* sweep and the fetch
   confirms the price (bumping `last_fetched_at` to match, which clears the
   trigger). The old discovery-price-vs-`current_price` comparison is removed:
   it would go silent the moment `current_price` = observed, which is exactly
   the listings the fetch budget never reached — the ones that most need the
   confirm. `_fetch_freshness_map` now also selects `max(observed_at)` per
   listing to feed the trigger.

4. **Discovery never clobbers a same-run authoritative fetch.**
   `_record_discovery_price_observations` runs after the fetch loop and skips
   the `current_price` adoption for any listing whose `last_fetched_at >=
   run_started_at` (fetched this run) — the detail-page price outranks the
   search-payload price. (`run_started_at` is captured at the top of
   `run_connector`; direct/test callers may pass `None` to disable the guard.)

5. **One-time idempotent backfill** in `etl/schema/init.sql`: set
   `current_price` to the most-recent `listing_price_history` price for
   listings where they diverge, subject to the same 1%–60% band. Idempotent by
   construction — the band is re-evaluated each run, so a realigned listing has
   no divergence left and a suspect (>60%) latest observation is blocked the
   same way every run.

**Alternatives rejected**:
- *Keep `current_price` fetch-owned (status quo, D-070)* — the original bug:
  display and deal-math lag the confirmed history for as long as the fetch
  budget takes to reach the listing.
- *Adopt the observed price with no sanity band* — a single junk observation
  (parse error, placeholder) would poison `current_price` and every
  below-market/scoring number derived from it.
- *Block >60% moves everywhere including history* — a genuine >60% move would
  then be invisible in history AND unable to trigger a confirming re-fetch;
  recording-but-not-adopting keeps it visible and self-correcting.
- *Keep the old discovery-vs-`current_price` re-fetch trigger alongside the new
  one* — it goes silent once `current_price` = observed, giving false comfort;
  the history-vs-`last_fetched_at` anchor is the one that actually keeps firing
  for un-confirmed observations.

**Rationale**: the most-recent observation is the best estimate of the true
price and is what every other surface (history, graph, badge) already shows;
making `current_price` track it fixes the display and deal-math immediately,
while the sanity band prevents a junk observation from doing damage and the
re-anchored re-fetch net keeps the authoritative confirm-by-refetch that D-070's
coupling was protecting.

**See**: issue #432; [D-070](D-070-discovery-price-history.md) (revised);
`etl/orchestrator.py` (`_observed_price_is_adoptable`,
`_observed_price_is_material`, `_record_discovery_price_observations`,
`_update_existing_listing`, `_fetch_freshness_map`, `_should_skip_fetch`,
`run_connector`); `etl/schema/init.sql` (backfill); tests in
`etl/tests/test_orchestrator.py`.
