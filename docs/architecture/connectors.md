# Connector framework — contract, rate limiting, circuit breaking

> Implements issue #1 §4 (per-site connectors) and issue #11 (Phase 1.3: the framework/harness). No real site connector exists yet — that's issue #12 (task 1.4). This document describes what task 1.4 (and every later connector) plugs into, not any specific site's scraping logic.

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

`run_all_connectors` iterates `CONNECTORS` (empty until issue #12 registers the first real one — a no-op empty registry is a supported, tested state), running each through `run_connector`'s discover → fetch_detail → normalize → persist cycle, and records one `connector_runs` row plus one `connector_run_results` row per connector per run for observability (which connector, when, how many discovered/fetched/errored, real elapsed duration).

Persistence (`_upsert_canonical_listing`) follows the schema's core invariant (see [`data-model.md`](data-model.md)): every new `(source, external_id)` gets its own singleton `property` row at ingest, never a deferred-null reference. Re-visits update the existing `listing`/`property` row via `_update_existing_listing`, and every column update is **COALESCE-guarded** (new value if present, otherwise keep the old one) rather than a blind overwrite — this matters even before any dedup exists, since a single connector re-fetch can transiently fail to surface a field, and it matters even more once Phase 2's dedup engine (issue #16) reassigns a listing's `property_id` onto a property shared with another listing: neither listing's re-visit should be able to erase what the other contributed.

Price and status changes are appended to `listing_price_history`/`listing_status_event` only when the new value actually differs from the previous one — these are event logs, not just "last known value" caches.

The insert path also handles the inherent race in "check if it exists, then insert if not": an overlapping manual `--once` run and the scheduled hourly loop can both see "not found" for the same listing and both attempt the insert. The `UNIQUE (source, external_id)` constraint on `listing` turns the loser's attempt into a `UniqueViolation`, which is caught and turned into the same update path a normal re-visit would take, rather than surfacing as a connector fetch error.

A crashed process (killed container, OOM, host reboot) can leave a `connector_runs` row stuck at `status='running'` forever. `run_all_connectors` reconciles any such stale row to `failed` before starting a new run, so staleness never accumulates silently.

`run_scheduler_loop` isolates each scheduled iteration in its own try/except — a transient failure in one iteration is logged and the loop continues at the next interval, rather than killing the long-running container process.
