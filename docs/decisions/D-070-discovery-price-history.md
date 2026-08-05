---
id: D-070
title: Discovery-time prices are written to listing_price_history, decoupled from the fetch budget
date: 2026-08-06
---

# D-070: Discovery-time prices are written to listing_price_history, decoupled from the fetch budget

*Decided: 2026-08-06*

**Context**: PR #175 (issues #143/#172) added
`Connector.discovered_prices() -> dict[str, Decimal]` — a per-listing price a
connector can read for free out of the same search payload `discover()` already
fetches to enumerate external_ids. Fotocasa's implementation
(`_extract_search_result_prices`, live-verified 2026-08-03) supplies a
detail-page-accurate price for *every* one of the ~1,358 listings a full sweep
discovers, *every* sweep, at zero extra request cost. But that signal was used
only as a **boolean gate**: `_should_skip_fetch` compared the discovery price to
the stored `listing.current_price` to decide whether to force an immediate
re-fetch, then threw the value away. It was never persisted.

Price-drop detection (issue #34) therefore only got a fresh price for the
subset of ids the run's fetch budget (circuit breaker, rate limit,
`min_refetch_interval_seconds`) actually re-fetched. During Fotocasa's initial
backfill the fetch front advances only ~40 ids/run, so a verified price for the
whole inventory sat unused every sweep while most listings' price history went
stale for however long the backfill took (~1.4 days).

**Decision**: persist every discovery-time price straight to
`listing_price_history`, decoupled entirely from the fetch budget.

1. New helper `etl.orchestrator._record_discovery_price_observations(conn,
   source, discovery_prices)` appends one `listing_price_history` row per
   discovered listing **whose discovery price differs from that listing's most
   recent recorded price** (the latest `listing_price_history` row, via
   `IS DISTINCT FROM` a `LIMIT 1` correlated subquery). It is a single set-based
   `INSERT … SELECT` over `unnest(external_ids, prices)` joined to `listing`
   (no N+1), commits its own transaction like the sibling discovery-time helper
   `_update_last_seen_for_discovered`, and returns the count written.
2. `run_connector` calls it **after** the per-listing fetch loop, once per
   scope, and surfaces the count as `discovery_price_observations` in its
   summary dict + an INFO log. After-the-loop placement is what gives the
   dedup for free: a listing the loop *did* re-fetch this run already had its
   authoritative fetched price appended by `_update_existing_listing`, so the
   discovery price equals the latest row and is deduped away — no double-insert
   of the same observation. A listing the budget never reached still gets its
   verified discovery price recorded.
3. Dedup keys on the **last recorded price**, not on `listing.current_price`,
   which makes it idempotent across runs too: once a discovery price is
   recorded it becomes the latest row, so re-seeing the same price next sweep
   is a no-op. This mirrors the fetch-path write's own "insert only on a real
   change" contract in `_update_existing_listing`.
4. `listing.current_price` stays **exclusively fetch-path-owned**. The
   discovery recorder never writes it. This is load-bearing, not cosmetic:
   `_should_skip_fetch`'s central price-change safety net (reason #5) forces a
   re-fetch precisely when `discovery_price != stored current_price` — updating
   `current_price` from the discovery signal would make stored already equal
   the discovered value, and that trigger would silently stop firing.
5. Connector-agnostic by construction: it drives off whatever
   `Connector.discovered_prices()` returns, which is `{}` (base default) for
   every connector that hasn't verified a discovery-time price field, so the
   helper is a cheap early-return no-op for all but Fotocasa today. Only
   listings that already have a `listing` row can get an observation (the FK
   requires it); a brand-new discovered id gets its first price on its first
   real fetch, exactly as before.

The fetch budget, the circuit breaker, the rate limiter, and the
`min_refetch_interval_seconds` estimator are **untouched** — this adds a write
path alongside the existing skip/fetch machinery, it does not change how many
full detail fetches happen per run.

**Alternatives rejected**:
- *Also update `listing.current_price` from the discovery price* — breaks
  `_should_skip_fetch`'s price-change re-fetch trigger (see decision point 4);
  it would make skip-if-seen stop detecting real price changes, the exact
  failure #143 exists to prevent.
- *Record before the fetch loop* (the issue's first-pass suggestion) — would
  double-insert for listings the loop then re-fetches: the discovery write
  appends the price, then `_update_existing_listing` appends the same price
  again because it dedups against `current_price` (still the old value), not
  against the history row just written.
- *Dedup against `listing.current_price` instead of the last history row* —
  since `current_price` is left fetch-path-owned, a not-yet-fetched dropped
  listing would re-insert its discovery price every sweep (current_price never
  moves), defeating idempotency.
- *A `source` flag column distinguishing "seen at discovery" from "confirmed
  via full fetch"* — considered per the issue's open question, deferred: no
  current consumer needs the distinction, and adding a nullable column now is
  schema churn for a hypothetical. The timeline is append-only and both kinds
  of observation are equally real prices at their `observed_at`.

**Rationale**: makes price-drop detection complete for the whole discovered
inventory immediately, using a signal that was already being computed and
discarded, without touching the fetch-budget machinery that necessarily bounds
full fetches — and without weakening skip-if-seen's price-change guarantee.

**See**: issue #183, PR #175, issues #143/#172, issue #34;
`etl/orchestrator.py` (`_record_discovery_price_observations`, `run_connector`,
`_should_skip_fetch`), `etl/connectors/fotocasa.py`
(`discovered_prices` / `_extract_search_result_prices`),
`etl/connectors/base.py` (`Connector.discovered_prices`),
`etl/schema/init.sql` (`listing_price_history`), tests in
`etl/tests/test_orchestrator.py` (`TestDiscoveryPriceHistory`).
