# Connector framework — contract, rate limiting, circuit breaking

> Implements issue #1 §4 (per-site connectors) and issue #11 (Phase 1.3: the framework/harness). Fotocasa (issue #12, task 1.4) is the first real connector built against this contract — see [connectors.md skill](../skills/connectors.md) for the site-specific findings (feasibility spike, JSON-over-HTML-scraping, field-mapping judgment calls) from building it. This document stays about the framework itself, not any one site's scraping logic.

## The `Connector` contract

Every listing-site connector (`etl/connectors/base.py`) implements three methods:

- **`discover(scope) -> list[str]`** — cheap: which external IDs exist for a scope (a search-result pagination pass, or similar), no full detail fetch.
- **`fetch_detail(external_id) -> RawListing`** — expensive: the full page/API fetch for one external ID, returned as the connector's native representation (`RawListing.raw`), not yet normalized.
- **`normalize(raw) -> CanonicalListingVersion`** — pure, no I/O: maps site-specific fields onto the schema-shaped `CanonicalListingVersion` (issue #10). Anything the site publishes that doesn't have a first-class column goes in `raw_extra` rather than being silently dropped.

Class attributes (`rate_limit_per_minute`, `circuit_breaker_error_rate`, `circuit_breaker_min_attempts`, `circuit_breaker_window`) configure the framework's behavior for that connector — a connector never rate-limits or trips its own breaker; that's the orchestrator's job, applied uniformly to every connector for free.

## Rate limiting (`etl/connectors/rate_limit.py`)

A fixed-interval limiter: `rate_limit_per_minute` calls are spread evenly, one call every `60 / rate_limit_per_minute` seconds. `RateLimiter.acquire()` blocks until enough time has passed since the previous call.

The orchestrator calls `acquire()` once before `discover()` and once before each `fetch_detail()` — enough to throttle simple connectors. A connector whose own `discover()` implementation makes multiple HTTP calls internally (e.g. paginating through search results) needs its own throttling between those internal calls; the orchestrator's single `acquire()` around the whole `discover()` call doesn't reach inside it.

## Circuit breaking (`etl/connectors/circuit_breaker.py`)

Protects against silently ingesting garbage after a site changes its HTML structure (every fetch/parse starts raising) and against hammering a site that's rejecting requests (every fetch starts erroring). The breaker trips once **both**:
- at least `min_attempts` attempts have happened (avoids tripping on a small, noisy early sample), and
- the error rate **over the last `window` attempts** (not the cumulative rate since the run started) exceeds `error_rate_threshold`.

The rolling window matters: a connector that fetches hundreds of listings cleanly and then hits a site that started rejecting every request must trip quickly, not after accumulating enough failures to drag down an all-time average. `error_rate` (cumulative) is still exposed for reporting/logging; `tripped` uses `windowed_error_rate`, not `error_rate`.

When tripped mid-run, the orchestrator stops processing remaining discovered IDs for that connector and records the run as `circuit_open` rather than `ok` — a signal that this connector needs human attention (site structure changed, credentials expired, IP blocked), not a routine partial failure.

## Orchestration and persistence (`etl/orchestrator.py`)

`run_all_connectors` iterates `CONNECTORS` (registered via `etl/connectors/__init__.py`'s `register_all()` — Fotocasa today, task 2.1's second connector adds one line there), running each through `run_connector`'s discover → fetch_detail → normalize → persist cycle, and records one `connector_runs` row plus one `connector_run_results` row per connector per run for observability (which connector, when, how many discovered/fetched/errored, real elapsed duration). An empty `CONNECTORS` registry is still a supported, tested state (issue #11 EC-4) — the loop runs cleanly with zero connectors.

Persistence (`_upsert_canonical_listing`) follows the schema's core invariant (see [`data-model.md`](data-model.md)): every new `(source, external_id)` gets its own singleton `property` row at ingest, never a deferred-null reference. Re-visits update the existing `listing`/`property` row via `_update_existing_listing`, and every column update is **COALESCE-guarded** (new value if present, otherwise keep the old one) rather than a blind overwrite — this matters even before any dedup exists, since a single connector re-fetch can transiently fail to surface a field, and it matters even more once Phase 2's dedup engine (issue #16) reassigns a listing's `property_id` onto a property shared with another listing: neither listing's re-visit should be able to erase what the other contributed.

Price and status changes are appended to `listing_price_history`/`listing_status_event` only when the new value actually differs from the previous one — these are event logs, not just "last known value" caches.

The insert path also handles the inherent race in "check if it exists, then insert if not": an overlapping manual `--once` run and the scheduled hourly loop can both see "not found" for the same listing and both attempt the insert. The `UNIQUE (source, external_id)` constraint on `listing` turns the loser's attempt into a `UniqueViolation`, which is caught and turned into the same update path a normal re-visit would take, rather than surfacing as a connector fetch error.

A crashed process (killed container, OOM, host reboot) can leave a `connector_runs` row stuck at `status='running'` forever. `run_all_connectors` reconciles any such stale row to `failed` before starting a new run, so staleness never accumulates silently.

`run_scheduler_loop` isolates each scheduled iteration in its own try/except — a transient failure in one iteration is logged and the loop continues at the next interval, rather than killing the long-running container process. It also runs every connector once immediately on startup, before the first sleep — not just on the hourly boundary. Combined with `restart: unless-stopped` in `docker-compose.yml`, this means every container restart is itself a live scrape of every registered connector's site, not only the scheduled hourly runs (see the [connectors skill](../skills/connectors.md) for the operational implication).

## Withdrawal detection requires knowing whether a connector actually sees its full inventory

`_reconcile_missed_discoveries` marks a listing `withdrawn` after `_WITHDRAWAL_THRESHOLD` (3) consecutive `discover()` sweeps that don't include it. This is only a valid signal when `discover()` genuinely covers the connector's active inventory for its scope — if it only ever returns a subset (one search-results page out of hundreds, a top-N-by-relevance cut, etc.), then a listing's absence from one sweep tells you nothing: it may simply have scored below whatever cutoff that sweep's subset represents, especially under a relevance/recency sort rather than a stable one.

This was found live during Phase 1's phase-level review: Fotocasa's `discover()` only reads page 1 of search results (robots.txt disallows pagination — see the connectors skill), against a real inventory of 11,000+ listings for a single geography, sorted by relevance. Treating a Fotocasa listing's absence from 3 sweeps as "withdrawn" would have been wrong far more often than right — corrupting exactly the signal issue #1 §10 calls out as a first-class value-add (real withdrawals, relistings-at-a-lower-price).

`Connector.discovers_full_inventory` (`etl/connectors/base.py`, default `True`) gates this: when a connector sets it to `False`, `run_connector` skips `_reconcile_missed_discoveries` entirely for that connector — not just a raised threshold, since even accumulating a miss-count that never triggers anything would still be tracking a meaningless number. Fotocasa sets `discovers_full_inventory = False`. A connector should only claim `True` when its `discover()` genuinely enumerates (or very nearly enumerates) everything active in its scope — pagination through the full result set, an API that returns a complete listing, etc. Until a connector can honestly claim full coverage, its listings simply never auto-transition to `withdrawn` from absence alone (a human/future mechanism would need to confirm removal some other way).
