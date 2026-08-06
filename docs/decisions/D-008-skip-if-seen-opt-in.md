---
id: D-008
title: Skip-if-seen fetch-budget policy defaults to off; opt in per connector with a price-delta safety net
date: 2026-08-03
group: Data / connectors
rule: Skip-if-seen defaults to 0 (always fetch); opt in per connector. Never skip missing/changed discovery price.
order: 10
---

# D-008: Skip-if-seen fetch-budget policy defaults to off; opt in per connector with a price-delta safety net

*Decided: 2026-08-03*

**Context**: `etl/orchestrator.py`'s fetch loop called `fetch_detail()` for every id `discover()` returned, on every run, with no skip-if-seen — invisible at ~30 ids/connector, a hard blocker at Fotocasa's zone-partitioned scale (issue #65, ~1,500 ids/sweep at 3 req/min ≈ 8h against an hourly schedule, issue #143). The obvious fix (skip a listing that was fetched "recently enough") risks silently breaking the product's core signal: price-drop and status-change detection (issue #1 §10, issue #34) depend on every real change actually being observed within a bounded window. A skip policy that's too aggressive, or applied uniformly regardless of a connector's actual fetch economics, degrades that signal in a way that looks exactly like "the market went quiet" rather than "we stopped looking."

**Decision**:
- `Connector.min_refetch_interval_seconds` (class attribute, default `0`) is the skip-if-seen window. `0` means "always fetch" — the behaviour every connector had before this decision. A connector opts in by setting this non-zero, with a documented reason for the chosen window (see `fotocasa.py`: 24h, because list prices/statuses don't typically move sub-daily). Operator-overridable per connector via `connector_config.min_refetch_interval_seconds` (`NULL` = no override), same pattern issue #99 established for `filters.rooms`.
- Regardless of the window, `etl.orchestrator._should_skip_fetch` never skips a listing that has never been fetched, is missing its stored `current_price`, or whose discovery-time price (see below) disagrees with what's stored.
- `Connector.discovered_prices() -> dict[str, Decimal]` (default `{}`) lets a connector supply a per-listing price it can read for free from the same request `discover()` already makes (no second fetch). When present and it disagrees with the stored price, the orchestrator forces a re-fetch immediately, regardless of the staleness window. A connector only overrides this once it has **live-verified** the field exists and is reliable — not assumed from a reference mapping or another connector's shape. Fotocasa's `rawPrice` was verified this way (2026-08-03); Milanuncios's equivalent was investigated and could not be confirmed (a live re-check hit a bot-block page), so it was deliberately left unshipped rather than guessed.

**Alternatives rejected**:
- **A uniform global staleness window for every connector.** Rejected: a 200k-listing bank-portal connector and a 3-req/min Fotocasa have different fetch economics; a one-size window would be too aggressive for one and too conservative for the other.
- **Per-run detail cap with rotation, or prioritized fetching (issue #143's options 2/3).** Rejected for this pass as more complex than needed once skip-if-seen plus the discovery-price gate solves the steady-state cost; either composes with this decision later if a connector's economics still don't fit after enabling skip-if-seen.
- **Shipping a guessed Milanuncios discovery-price signal** on the theory that "some price field probably exists." Rejected: a wrong discovery-price signal is worse than none, because `_should_skip_fetch` trusts it to force (or not force) a re-fetch — a fabricated match would silently suppress real price-change detection, the exact failure mode this decision exists to prevent.

**Rationale**: Defaulting to off (byte-identical to pre-#143 behaviour) means the fetch-budget win is available everywhere but never applied without a connector-specific verification and a deliberate choice, which is what keeps the price-change/withdrawal-detection guarantees from silently degrading as more connectors land.

**See**: `etl/connectors/base.py` (`Connector.min_refetch_interval_seconds`, `discovered_prices`), `etl/orchestrator.py` (`_should_skip_fetch`, `_fetch_freshness_map`, `_update_last_seen_for_discovered`), `etl/connectors/fotocasa.py` (`_extract_search_result_prices`), `docs/skills/connectors.md#skip-if-seen-the-fetch-budget-policy-issue-143`, issue #143, issue #65, issue #99 (the `connector_config` override pattern this reuses).
