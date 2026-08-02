# Connectors skill

How to build a listing-site connector against the `Connector` contract from `etl/connectors/base.py` (issue #11, Phase 1.3). Read this before writing a second/third connector (task 2.1 onward) — it exists specifically so that work doesn't start from scratch reading `etl/connectors/fotocasa.py` cold.

## The contract, in practice

A connector implements three methods (`discover`, `fetch_detail`, `normalize`) and declares a few class attributes (`name`, `rate_limit_per_minute`, `circuit_breaker_*`). The framework (`etl/orchestrator.py`) owns everything else: rate limiting, circuit breaking, persistence, run/result bookkeeping, and withdrawal detection. A connector never touches the database directly and never rate-limits itself beyond calling the `throttle` callback it's given.

`discover` should be cheap — it returns a list of `external_id` strings, nothing more. `fetch_detail` does the expensive full-page fetch for one id. `normalize` is pure (no I/O) and maps whatever `fetch_detail` returned into `CanonicalListingVersion` — every field the canonical schema (`etl/schema/init.sql`, `property`/`listing` tables) has a column for. Anything the site publishes that doesn't map cleanly to a canonical column goes in `raw_extra` (JSONB) rather than being dropped — a later phase might want it even if today's schema doesn't have a slot.

## Feasibility spike first — always

Before writing a single line of parsing code for a new site: check `robots.txt`, make a handful of slow, honestly-identified test requests, and confirm the site doesn't wall off automated access behind bot-detection (DataDome, PerimeterX, Cloudflare challenge pages, etc.). Idealista was the original default target for task 1.4 and failed this spike immediately — every request got a 403 CAPTCHA challenge from `captcha-delivery.com` regardless of User-Agent, robots.txt notwithstanding. That's a hard no: bypassing it means CAPTCHA-solving or a JS-executing headless browser, both out of scope per issue #1 §15 (this is a personal tool, not a scraping operation). Fotocasa passed the same spike — robots.txt allows the needed paths, and real requests returned normal server-rendered HTML.

Document the spike's outcome in the implementing PR, even when the answer is "yes, proceed" — the next person shouldn't have to redo the investigation to find out it was actually checked.

## Prefer embedded JSON over HTML scraping

Many modern real-estate sites (Fotocasa included) server-render a full JSON blob into the page — look for a `<script type="application/json" id="...">` tag, or `window.__SOMETHING__ = {...}` inline script, before reaching for CSS-selector-based HTML scraping. It's far more stable (survives markup/styling changes that would break a selector) and gives you structured data (typed fields, nested objects) instead of text you'd have to re-parse. `etl/connectors/fotocasa.py`'s `_extract_initial_props` is the worked example: find the tag by its `id` attribute (don't assume attribute order in a regex — HTML doesn't guarantee it), take everything to the next `</script>`, `json.loads` it.

When a fetch returns that JSON shape but a *different* one than expected (different page template, a "listing no longer available" page, a soft bot-block/interruption page), raise `ConnectorError` rather than returning partial/garbage data — this is the same fail-loud principle as a robots.txt/structural change: better to have the run fail loudly (counted by the circuit breaker) than to silently ingest wrong data. `fotocasa.py` hit exactly this in the wild during the Phase 1.4 feasibility spot-check: 2 of 5 sampled real listings parsed cleanly with full field coverage, 1 returned what looks like a rate-limit/soft-block response with no `__initial_props__` tag — correctly raised, correctly countable, not silently swallowed.

## robots.txt shapes what you can implement, not just whether you can start

Read the *whole* file, not just the top-level `Disallow: /`. Fotocasa's robots.txt disallows deep pagination (`/*/l/2*` through `/*/l/39*`) and bare single-segment city paths (`/*/madrid/*`, exact `/madrid/` substring — a hyphenated slug like `madrid-capital` is fine, no literal `/madrid/` substring). This directly constrains `discover()`: the Fotocasa connector only fetches page 1 of search results and does not paginate, which caps how many listings one `discover()` call finds. That's a real, documented scope limit, not an oversight — don't "fix" it by paginating past what robots.txt allows.

## Don't fabricate precision you don't have

If a site gives you a coded bucket (Fotocasa's `antiquity` field is "more than N years," not a literal construction year) or an ambiguous heuristic-only signal (Fotocasa's `clientTypeId` looked promising for particular-vs-agency classification, but a real sampled listing had `clientTypeId=3` attached to an obviously corporate name — see `etl/connectors/fotocasa_mapping.py`'s `infer_listing_kind` for the sturdier signal actually used, `clientUrl` containing `/inmobiliaria-`), don't map it into a canonical field that implies more certainty than you have. Leave the canonical field `None` and keep the raw value in `raw_extra`. A `None` is honest; a wrong guess presented as data is worse than missing data, because downstream code (scoring, dedup, display) will trust it.

## Withdrawal detection lives in the orchestrator, not per-connector

A listing missing from one `discover()` sweep isn't necessarily gone — pagination noise, a transient site hiccup, or (for a connector that only reads page 1, like Fotocasa's) simply falling off the front page as newer listings push it down are all normal. `etl.orchestrator._reconcile_missed_discoveries` tracks a `missed_discovery_count` per listing and only marks `withdrawn` (with a `listing_status_event`) after `_WITHDRAWAL_THRESHOLD` (currently 3) consecutive misses. This is generic, connector-agnostic infrastructure — a new connector gets it for free by virtue of `run_connector` calling it right after `discover()` returns; there's nothing to implement per-connector.

## Registration

Add your connector class to `etl/connectors/__init__.py`'s `register_all()` function — a single `.append(...)` line. Don't register at import time (a module-level `CONNECTORS.append(...)` in `etl/connectors/__init__.py`) — see that file's docstring for why that creates a circular import with `etl.orchestrator`. `register_all()` is called once, explicitly, from `etl/main.py`, after `etl.orchestrator` is already fully imported.

## Testing

No live network calls in the test suite — save fixture HTML/JSON (trimmed to what the parsing code actually reads, with a comment noting it's a trimmed/synthetic reconstruction of a real page observed on a given date, not a literal full-page dump) and monkeypatch the HTTP call. See `etl/tests/test_connector_fotocasa.py` and its `etl/tests/fixtures/fotocasa_sample_*.html` fixtures for the pattern. Orchestrator-level behavior (price-history append, withdrawal detection) is tested against real Postgres in `etl/tests/test_orchestrator.py` using `DummyConnector` (`etl/tests/fixtures/dummy_connector.py`), not the real site connector — that suite doesn't need network access either.
