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

`run_all_connectors` iterates `CONNECTORS` (registered via `etl/connectors/__init__.py`'s `register_all()` — Fotocasa and, as of task 2.1, Milanuncios), running each through `run_connector`'s discover → fetch_detail → normalize → persist cycle, and records one `connector_runs` row plus one `connector_run_results` row per connector per run for observability (which connector, when, how many discovered/fetched/errored, real elapsed duration). An empty `CONNECTORS` registry is still a supported, tested state (issue #11 EC-4) — the loop runs cleanly with zero connectors.

Persistence (`_upsert_canonical_listing`) follows the schema's core invariant (see [`data-model.md`](data-model.md)): every new `(source, external_id)` gets its own singleton `property` row at ingest, never a deferred-null reference. Re-visits update the existing `listing`/`property` row via `_update_existing_listing`, and every column update is **COALESCE-guarded** (new value if present, otherwise keep the old one) rather than a blind overwrite — this matters even before any dedup exists, since a single connector re-fetch can transiently fail to surface a field, and it matters even more once Phase 2's dedup engine (issue #16) reassigns a listing's `property_id` onto a property shared with another listing: neither listing's re-visit should be able to erase what the other contributed.

Price and status changes are appended to `listing_price_history`/`listing_status_event` only when the new value actually differs from the previous one — these are event logs, not just "last known value" caches.

The insert path also handles the inherent race in "check if it exists, then insert if not": an overlapping manual `--once` run and the scheduled hourly loop can both see "not found" for the same listing and both attempt the insert. The `UNIQUE (source, external_id)` constraint on `listing` turns the loser's attempt into a `UniqueViolation`, which is caught and turned into the same update path a normal re-visit would take, rather than surfacing as a connector fetch error.

A crashed process (killed container, OOM, host reboot) can leave a `connector_runs` row stuck at `status='running'` forever. `run_all_connectors` reconciles any such stale row to `failed` before starting a new run, so staleness never accumulates silently.

`run_scheduler_loop` isolates each scheduled iteration in its own try/except — a transient failure in one iteration is logged and the loop continues at the next interval, rather than killing the long-running container process. It also runs every connector once immediately on startup, before the first sleep — not just on the hourly boundary. Combined with `restart: unless-stopped` in `docker-compose.yml`, this means every container restart is itself a live scrape of every registered connector's site, not only the scheduled hourly runs (see the [connectors skill](../skills/connectors.md) for the operational implication).

## Discovery scope comes from active search profiles (issue #71)

`ConnectorScope` no longer defaults to a hardcoded geography. `etl.orchestrator._active_profile_scopes` queries every active (`archived_at IS NULL`) `search_profile` row, reads its `scope.geography` (`{"type": "radius", "center": [lat, lon], "radius_km": ...}` — task 2.3's shape), and returns one deduplicated `ConnectorScope(center=..., radius_km=...)` per distinct area. **Zero active profiles means zero connector activity** — `run_all_connectors` logs that plainly and returns without calling any connector's `discover()`, rather than falling back to a default city nobody asked for.

Each registered connector runs once per distinct profile-derived scope, and results are aggregated into a single `connector_run_results` row per connector per run (the `UNIQUE (run_id, connector_name)` constraint predates per-scope iteration and wasn't worth migrating for this) — `discovered_count`/`fetched_count`/`error_count` are sums across all scopes that connector was asked to cover in that run, and `status` favors `circuit_open` over `failed` over `ok` if scopes disagree (see `run_all_connectors`'s status-mapping comment for the exact precedence, forced by `connector_run_results.status`'s three-value CHECK constraint having no `'partial'` option).

**Point-to-slug translation lives in each connector, not in a shared registry.** `etl/connectors/geography.py` provides `nearest_city(center) -> str | None` — a small, site-agnostic nearest-known-city-centroid lookup (a city's coordinates don't depend on which site you're scraping). What a resolved city name turns *into* — Fotocasa's `"madrid-capital"` hyphenated slug vs. Milanuncios's `"madrid-madrid"` doubled path segment — is each connector's own `_resolve_geography()` + `_CITY_SLUGS` table, deliberately not centralized: different sites encode geography in unrelated ways, and a shared slug registry would need editing every time a new site connector is added. A profile whose center resolves to no known city (or a connector's `_CITY_SLUGS` table doesn't yet cover it) is simply skipped for that connector's `discover()` — logged loudly via a raised `ConnectorError`, not silently defaulted to Madrid.

`ConnectorScope.geography` (the original free-text field) still exists as an explicit escape hatch for tests/manual construction that want to bypass point-based resolution entirely — connector-level unit tests (`test_connector_fotocasa.py`/`test_connector_milanuncios.py`) use it directly rather than going through a seeded search profile, since they're testing `discover()` in isolation from the profile-derivation machinery.

## Withdrawal detection requires knowing whether a connector actually sees its full inventory

`_reconcile_missed_discoveries` marks a listing `withdrawn` after `_WITHDRAWAL_THRESHOLD` (3) consecutive `discover()` sweeps that don't include it. This is only a valid signal when `discover()` genuinely covers the connector's active inventory for its scope — if it only ever returns a subset (one search-results page out of hundreds, a top-N-by-relevance cut, etc.), then a listing's absence from one sweep tells you nothing: it may simply have scored below whatever cutoff that sweep's subset represents, especially under a relevance/recency sort rather than a stable one.

This was found live during Phase 1's phase-level review: Fotocasa's `discover()` only reads page 1 of search results (robots.txt disallows pagination — see the connectors skill), against a real inventory of 11,000+ listings for a single geography, sorted by relevance. Treating a Fotocasa listing's absence from 3 sweeps as "withdrawn" would have been wrong far more often than right — corrupting exactly the signal issue #1 §10 calls out as a first-class value-add (real withdrawals, relistings-at-a-lower-price).

`Connector.discovers_full_inventory` (`etl/connectors/base.py`, default `True`) gates this: when a connector sets it to `False`, `run_connector` skips `_reconcile_missed_discoveries` entirely for that connector — not just a raised threshold, since even accumulating a miss-count that never triggers anything would still be tracking a meaningless number. Fotocasa sets `discovers_full_inventory = False`. A connector should only claim `True` when its `discover()` genuinely enumerates (or very nearly enumerates) everything active in its scope — pagination through the full result set, an API that returns a complete listing, etc. Until a connector can honestly claim full coverage, its listings simply never auto-transition to `withdrawn` from absence alone (a human/future mechanism would need to confirm removal some other way).

## Reusing `property_web_scraper` — the reference project for this domain

[`RealEstateWebTools/property_web_scraper`](https://github.com/etewiah/property_web_scraper) is a mature, MIT-licensed open-source real-estate scraper covering 100+ portals across dozens of countries, including four Spanish sites (Idealista, Fotocasa, pisos.com, Habitaclia). It is **not vendored into this repo** — different language (Ruby/TypeScript vs. this project's Python), different license terms to keep separate, and it targets a completely different scale (110 site mappings vs. inmo-tool's 2-4). It's a reference to *read*, not a dependency to import. When doing connector work, clone it locally as a sibling checkout (e.g. `../property_web_scraper` next to this repo, or anywhere convenient — it's not part of this repo's build):

```bash
git clone https://github.com/etewiah/property_web_scraper.git
```

**What's worth reading there, and why:**

| Path | What it is | Why it matters here |
|---|---|---|
| `config/scraper_mappings/*.json` | Per-site field-extraction config (110 sites) | Field locations/structure reference for a new connector — see the caution below |
| `app/models/property_web_scraper/listing.rb` | Their canonical ~70-field schema | Cross-check against `etl/schema/init.sql`'s `property`/`listing` columns when a connector surfaces a field inmo-tool doesn't have a slot for yet (see issue #76) |
| `astro-app/src/lib/extractor/strategies.ts`, `html-extractor.ts` | Their current (TypeScript) extraction engine | **The pattern to adopt** — see below |
| `chrome-extensions/property-scraper/` | Their Manifest V3 browser extension for bot-protected sites | Forked as-is for inmo-tool's own Idealista capture path (issue #75) — this one *is* worth reusing close to verbatim, unlike the mapping files |
| `astro-app/src/lib/extractor/quality-scorer.ts` | Weighted per-listing extraction-completeness scoring | Concept reference for issue #80 (not the code — different runtime) |

**The pattern to adopt: fallback-chain extraction, not literal file copying.** Their extraction engine tries a primary strategy per field, then falls through an ordered list of fallbacks until one returns a non-empty result. Priority order (highest first), per `strategies.ts`'s `retrieveTargetTextSingle`:

1. `flightDataPath` — Next.js RSC/flight data (not currently relevant to any Spanish site inmo-tool targets)
2. `jsonLdPath` — `<script type="application/ld+json">` schema.org structured data (stable across redesigns — the most standardized fallback source when present)
3. `scriptJsonVar`/`scriptJsonPath` — a named JS variable holding embedded JSON (`window.__INITIAL_PROPS__`, `__NEXT_DATA__`, etc.) — the *primary* strategy for both Fotocasa (issue #77) and Milanuncios (issue #78). Milanuncios live-checked JSON-LD (step 2 above) as a genuine second source per its own attributes-array data (issue #78) and confirmed it exists but carries only a `BreadcrumbList` nav schema, no property data (`etl/connectors/milanuncios._has_usable_jsonld_property_schema` codifies this as an executable check against a fixture, not a comment-only claim). Unlike Fotocasa (which has a CSS-selector fallback, step 6), Milanuncios has no rendered-HTML fallback — its visible stats render client-side from the same JSON already used as the primary source — but its free-text `ad.description` routinely spells the same rooms/bathrooms/m² stats out in prose (e.g. "353 m2 construidos ... 4 habitaciones y 3 banios"), giving `rooms`/`bathrooms`/`m2_built` a real second getter via `_description_stat`'s regex extraction (Opus review, PR #85) — deliberately *not* extended to `current_price`, since a price mentioned in free text is often negotiable/approximate rather than the actual listing price.
4. `scriptRegEx` — regex over raw `<script>` contents
5. `urlPathPart` — a path segment of the listing URL itself (e.g. sale-vs-rent detection)
6. `cssLocator` — a CSS selector against rendered HTML (least stable — the first thing a redesign breaks, but often the only thing available when nothing above exists)

`etl/connectors/extraction.py` (introduced by issue #77) is the shared Python helper — `first_present(*getters)` tries an ordered list of callables and returns the first non-empty result. **Do not port their JSON-mapping-file DSL wholesale** — a 110-site project needs a declarative config format editable without touching code; a 2-4-connector project doesn't. `etl/connectors/fotocasa.py`'s `_icon_stat_text`/`_price_fallback_text` are the worked example of step 6 (`cssLocator`) as a real fallback getter, not just a design note: rooms/bathrooms/surface/price each try their embedded-JSON path first, then fall through to a live-verified CSS selector if that path comes back empty. One concrete lesson already learned doing this: property_web_scraper's own selectors for this exact site (`.re-DetailHeader-*`, last checked by them 2026-02-20) no longer match anything on the live page as of Fotocasa's own retrofit — the site migrated to a Tailwind-utility design system with no semantic classes left. **A reference mapping's selectors are a starting hypothesis, not a fact — verify against a real live page before trusting them**, same as this project's existing feasibility-spike discipline for discover()/fetch_detail() itself.

**When starting a new connector** (see issue #79 for pisos.com/Habitaclia), check the matching `config/scraper_mappings/<locale>_<site>.json` file first for field locations — but verify every selector/regex/JSON-path against a real, live page before trusting it. Their own `expectedExtractionRate` field is a useful signal of how much to trust a given mapping (Idealista 0.75, Fotocasa 0.70, Habitaclia 0.60, pisos.com 0.45 — the lower end reads as thin/speculative, not battle-tested) — but even a high rate doesn't excuse skipping this project's own feasibility-spike discipline (robots.txt check + live sample requests, documented in the implementing PR) established by the Fotocasa/Milanuncios tasks (#12/#15).

## Idealista: a capture-only connector (issue #75)

Idealista is the one connector that never makes a live network request at all — task 1.4's feasibility spike already found it returns an immediate CAPTCHA/bot-detection wall to every direct HTTP request, and property_web_scraper hits the identical wall (their own automated-fetch path explicitly refuses this site). The answer both projects landed on: capture rendered HTML a human's own browser already loaded, and parse that instead of fetching anything.

**`browser-extension/`** is a fork of `chrome-extensions/property-scraper/` from the local `property_web_scraper` reference clone (MIT, attribution in `browser-extension/NOTICE.md`) — the content script (page-HTML capture on message) is used verbatim; the popup/background/options/manifest are trimmed for a single-deployment personal tool (no haul/multi-tenant/API-key machinery, host permissions scoped to Idealista + the owner's own dashboard host instead of ~18 international portals).

**`etl/connectors/idealista.py`** is a real `Connector` subclass with a twist: `scope_key()` always returns `None`, so the orchestrator's normal profile-driven sweep (`run_all_connectors`) skips it every single run without ever calling `discover()`/`fetch_detail()` (both raise defensively if somehow called anyway — see the module docstring). It's still registered in `register_all()` so `CONNECTORS` stays "every known site," but its real entry point is `normalize()`, called directly by `etl/capture.py`.

**Why a queue table, not a synchronous call**: the dashboard (Node/TypeScript, `POST /api/extension/capture`) and this connector's parsing logic (Python, sharing `etl/connectors/extraction.py`'s fallback-chain helper with Fotocasa/Milanuncios) run in separate containers with no shared filesystem or RPC channel — and issue #75 explicitly requires a future automated Idealista connector, if one ever becomes viable, to share one source of truth with this capture path rather than a second, drifting TypeScript reimplementation. `extension_capture` (`etl/schema/init.sql`) is the same "signal via a Postgres row" pattern this project already uses for `etl_manual_trigger`. Flow: the dashboard inserts a `pending` row and returns immediately; `etl/capture.py`'s `run_capture_poll_loop` (started in its own thread alongside the hourly connector scheduler, `etl/main.py`) picks it up on a ~10s interval, runs `IdealistaConnector.normalize()` against the captured HTML, and persists via the exact same `etl.orchestrator._upsert_canonical_listing()` an automated connector's fetch uses — no special-cased bypass, so dedup/hard-filtering/the dashboard see it identically to any other listing. The extension's popup polls `GET /api/extension/capture/[id]` for the result.

**Idealista's mapping is less certain than Fotocasa/Milanuncios's**, and honestly so: `idealista_mapping.py`'s module docstring and inline comments document exactly which fields are grounded in a real (if archival, not independently live-verified — this connector has no way to fetch a fresh page itself) captured sample vs. best-effort (property type from title-text keyword matching, no structured typology field found; `lat`/`lon` not found anywhere in the sample, meaning a captured Idealista property can't use the dedup engine's `address_coords` signal at all; `energy_rating` investigated and left `None` — a single sample wasn't enough to confirm which CSS class actually encodes the letter grade vs. static styling). Revisit these once real captures via the extension are available to check against.
