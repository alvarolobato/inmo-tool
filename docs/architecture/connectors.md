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

`run_scheduler_loop` isolates each scheduled iteration in its own try/except — a transient failure in one iteration is logged and the loop continues at the next interval, rather than killing the long-running container process. It also runs every connector once immediately on startup, before the first sleep — not just on the hourly boundary. Combined with `restart: unless-stopped` in `docker-compose.yml`, this used to mean every container restart was itself an unconditional live scrape of every registered connector's site. Issue #172's restart-burst guard (`should_skip_immediate_sweep` / `run_all_connectors_respecting_restart_guard`) now gates the *full-sweep* path (scheduler iterations, and `--once` with no `--connector`) on how recently a completed `connector_runs` row exists — see the [connectors skill](../skills/connectors.md) for the operational detail and the threshold's config key.

## Fetch budget: skip-if-seen (issue #143)

`run_connector`'s fetch loop no longer calls `fetch_detail()` unconditionally for every discovered id — `_should_skip_fetch` (pure function, DB-free) decides per id, using a batched `(last_fetched_at, current_price)` lookup (`_fetch_freshness_map`, one query per connector-scope, not per listing) and whatever discovery-time price signal the connector supplies (`Connector.discovered_prices()`, default `{}`). The policy itself, the per-connector `min_refetch_interval_seconds` knob (class attribute + `connector_config` override), and the Fotocasa-vs-Milanuncios discovery-price verification are documented in the [connectors skill](../skills/connectors.md#skip-if-seen-the-fetch-budget-policy-issue-143) rather than duplicated here — that's where a connector implementer needs to look when deciding whether to opt in.

Two schema/bookkeeping consequences worth knowing at the framework level: `listing.last_seen_at` and `listing.last_fetched_at` are no longer the same moment (`_update_last_seen_for_discovered` bumps the former for every discovered id, fetched or skipped, right after `discover()` returns; `_upsert_canonical_listing`/`_update_existing_listing` bump the latter only on a real fetch); and `connector_run_results.skipped_count` tracks listings left unfetched this run, separate from `connector_runs.connectors_skipped` (issue #99's whole-connector disabled count, a different granularity entirely).

## Discovery scope: profile-derived by default, operator-overridable (issues #71, #99)

`ConnectorScope` no longer defaults to a hardcoded geography. `etl.orchestrator._active_profile_scopes` queries every active (`archived_at IS NULL`) `search_profile` row, reads its `scope.geography` (`{"type": "radius", "center": [lat, lon], "radius_km": ...}` — task 2.3's shape), and returns one deduplicated `ConnectorScope(center=..., radius_km=...)` per distinct area. This is the **default** every connector gets when nothing else is configured — a fresh profile with zero extra setup still drives something reasonable to crawl.

Issue #99 adds an explicit override on top of that default, via a `connector_config` table (one row per connector, present or not):

| `connector_config` state | Effect |
|---|---|
| No row for this connector | Issue #71's default: scope = union of active profiles. |
| `enabled = false` | Connector is skipped entirely for the run — never resolves a scope, never calls `discover()`. Gets a `connector_run_results` row with `status='skipped'` (not counted toward `connectors_ok`/`connectors_failed`, counted separately in `connectors_skipped`) so a fully-disabled run is distinguishable from a fully-healthy empty one, rather than a failure; an operator turned it off. This is the lever the connector-management UI (#100) exposes. |
| `geography_override` set, `enabled` true/default | Used **instead of** the profile union for this connector only — e.g. an operator broadening ingestion ahead of profiles that don't exist yet. Same `{center, radius_km}` shape as a profile's geography. Malformed values (wrong shape, non-dict, non-numeric coordinates) fall back to the profile-derived default with a warning logged, rather than erroring the run — every branch is `isinstance(dict)`-guarded before any dict access, specifically so a bad row (however it got there — hand-edited, a future UI bug) can never take down the whole run, not just this one connector's resolution. |
| `filters` set | A JSONB bag of connector-specific native filters (e.g. `{"rooms": 2}`), merged onto whichever base scope (override or profile-derived) applies. Additive by design — see the per-site filter findings below for why this isn't a fixed column per site. An unrecognized `connector_name` in this table, or a malformed `filters` value, is logged as a warning rather than silently doing nothing. |

`etl.orchestrator._scopes_for_connector` is where this precedence is actually resolved, per connector, on every `run_all_connectors` call — there's no cross-connector effect: overriding one connector's scope or disabling it doesn't touch any other connector's own (independent) resolution. **Zero active profiles and no override still means zero activity for that connector** — nothing falls back to a default city nobody asked for.

Each registered connector runs once per distinct resolved scope, and results are aggregated into a single `connector_run_results` row per connector per run (the `UNIQUE (run_id, connector_name)` constraint predates per-scope iteration and wasn't worth migrating for this) — `discovered_count`/`fetched_count`/`skipped_count`/`error_count` are sums across all scopes that connector was asked to cover in that run, and `status` favors `circuit_open` over `failed` over `ok` if scopes disagree (see `run_all_connectors`'s status-mapping comment for the exact precedence, forced by `connector_run_results.status`'s three-value CHECK constraint having no `'partial'` option). `skipped_count` (issue #143) is listings the skip-if-seen policy deliberately left unfetched — see below.

### Native site filter findings (issue #99, live-verified 2026-08-02)

Only one filter dimension is confirmed real and wired in — the rest are documented here specifically so nobody re-derives or re-guesses them later without checking first:

| Site | Filter | Status | Evidence |
|---|---|---|---|
| Fotocasa | rooms count | **Confirmed, wired in** (`scope.rooms`) | `/es/comprar/viviendas/{geography}/todas-las-zonas/{n}-habitaciones/l` returns a genuinely narrower result set with its own heading ("... con N habitaciones") — not an SEO alias identical to the unfiltered page. This is an EXACT-match filter (every result in the live sample had exactly N rooms, none more), hence `rooms` not `min_rooms`. The same path-segment mechanism also has real amenity filters (`terraza`, `reformado`, `ascensor`, room counts up to at least 4), not yet wired in. |
| Fotocasa | price range, property type | **Unconfirmed — needs its own feasibility spike** | Both are visibly present in the site's own sidebar UI ("Precio", "Tipo de vivienda"), but no URL/query mechanism was observable via static fetch — likely applied client-side after a JS interaction. Do not assume from this table; verify with the same rigor as task 1.4/2.1 before relying on it. |
| Milanuncios | rooms/bathrooms | **Inconclusive — treat as unverified** | An SEO-styled URL pattern (`/inmobiliaria/pisos-y-casas-en-venta-de-4-habitaciones-2-banos-{geography}.htm`) looked plausible, but comparing its listing count against the connector's real per-city page gave a *higher* count for the supposedly-narrower filter, and the URL shape doesn't match the connector's actual `venta-de-pisos-en-{geography}-{geography}/` slug pattern. Needs a dedicated spike composed against the connector's real geography slug before use. |
| Idealista | any | **Moot** | `etl/connectors/idealista.py` is capture-only by design (#75) — `discover()`/`fetch_detail()` raise if ever called, `scope_key()` always returns `None`. There is no live query to filter. |
| Solvia | geography (provincia/municipio) | **Confirmed, wired in** | robots.txt disallows only `/api/` and `/ajax/`; the SSR search tree `/es/comprar/viviendas/{provincia}/{municipio}` is allowed and narrows genuinely (Torrevieja reported 61 homes vs. 6,375 nationally). Pagination is **not** available: `?pagina=2`/`?page=2` return byte-identical results to page 1 because real pagination goes through the disallowed `/api/`, so a single municipality page sees at most 20 server-rendered links — hence `discovers_full_inventory = False`. **Issue #190**: geography is no longer the *only* partitioning axis within a province — the site publishes its own municipality partition list via `sitemap_comprar_viviendas.xml` (1,737 entries nationally; 43 Sevilla, 44 Málaga, live-verified 2026-08-03), and `discover()` now sweeps every municipality the sitemap lists for a scope's resolved provincia instead of just the one municipio a centroid names. See [D-011](../decisions/D-011-solvia-sitemap-partitioning.md) and the "Partitioning a search space" section below. |

`connector_config.filters` stays a flexible JSONB bag rather than a fixed column per site-per-filter precisely because most of the above is still unconfirmed — adding a real column for every future finding would mean a schema migration each time, when most "findings" so far have been negative or inconclusive.

**Point-to-slug translation lives in each connector, not in a shared registry.** `etl/connectors/geography.py` provides `nearest_city(center) -> str | None` — a small, site-agnostic nearest-known-city-centroid lookup (a city's coordinates don't depend on which site you're scraping). What a resolved city name turns *into* — Fotocasa's `"madrid-capital"` hyphenated slug vs. Milanuncios's `"madrid-madrid"` doubled path segment — is each connector's own `_resolve_geography()` + `_CITY_SLUGS` table, deliberately not centralized: different sites encode geography in unrelated ways, and a shared slug registry would need editing every time a new site connector is added. A profile whose center resolves to no known city (or a connector's `_CITY_SLUGS` table doesn't yet cover it) is simply skipped for that connector's `discover()` — logged loudly via a raised `ConnectorError`, not silently defaulted to Madrid.

### Servicer portals publish fields consumer portals don't

Solvia (#116) established a pattern worth checking on every bank/servicer
portal in batch #132, because it holds for a structural reason: a servicer
*owns* the asset, so it has registry and cost data a portal merely
re-listing someone else's property never sees.

| Field | Why it matters | Where it lands |
|---|---|---|
| `caracteristicas.refCatastral` | The cadastral reference — the dedup engine's **highest-confidence** signal (#1 §6 signal 1), where a match is definitive rather than probabilistic. Issue #42 (a Catastro *lookup* connector) was cancelled on the sound reasoning that consumer portals withhold the address precision needed to derive one; servicers simply publish it. | `property.cadastral_ref`, the column `dedup/signals/cadastral.py` reads — wired end to end by #140, so the signal fires on real data. Values are normalised (upper-cased, whitespace-stripped) and rejected to `NULL` unless they are exactly 20 alphanumeric characters, in `CanonicalListingVersion.__post_init__`; a portal publishing a placeholder can't mass-merge unrelated properties at confidence 1.000. |
| `importeIbi`, `importeGastosComunidad` | Annual property tax and monthly community fees — the carrying costs Phase 5's net-yield maths (#33) would otherwise have to assume. | `raw_extra` |
| `reformar`, `estado` | Structured condition flags, a real input for the condition assessment flow (#26) instead of inferring from prose. | `raw_extra` |

Solvia also publishes **no coordinates at all** (verified across five live
listings), so `address_coords` dedup cannot fire for it — which is exactly
why the cadastral reference is load-bearing here rather than a bonus.

`ConnectorScope.geography` (the original free-text field) still exists as an explicit escape hatch for tests/manual construction that want to bypass point-based resolution entirely — connector-level unit tests (`test_connector_fotocasa.py`/`test_connector_milanuncios.py`) use it directly rather than going through a seeded search profile, since they're testing `discover()` in isolation from the profile-derivation machinery.

## Withdrawal detection requires knowing whether a connector actually sees its full inventory

`_reconcile_missed_discoveries` marks a listing `withdrawn` after `_WITHDRAWAL_THRESHOLD` (3) consecutive `discover()` sweeps that don't include it. This is only a valid signal when `discover()` genuinely covers the connector's active inventory for its scope — if it only ever returns a subset (one search-results page out of hundreds, a top-N-by-relevance cut, etc.), then a listing's absence from one sweep tells you nothing: it may simply have scored below whatever cutoff that sweep's subset represents, especially under a relevance/recency sort rather than a stable one.

This was found live during Phase 1's phase-level review: Fotocasa's `discover()` only reads page 1 of search results (robots.txt disallows pagination — see the connectors skill), against a real inventory of 11,000+ listings for a single geography, sorted by relevance. Treating a Fotocasa listing's absence from 3 sweeps as "withdrawn" would have been wrong far more often than right — corrupting exactly the signal issue #1 §10 calls out as a first-class value-add (real withdrawals, relistings-at-a-lower-price).

Zone partitioning (issue #65, see the section below) improved Fotocasa's coverage by roughly two orders of magnitude, but **did not change this flag** — and the reason is worth stating, because "we fixed coverage" is exactly the sort of claim that tempts someone to flip it. Each zone slice is still capped at its own first ~30 listings, so a busy neighbourhood with 200 active listings still contributes only 30, and a perfectly active listing can be absent from a sweep purely because it ranked 31st in its zone. Absence still proves nothing. `discovers_full_inventory` stays `False` until a connector can enumerate its scope, not merely sample it widely.

`Connector.discovers_full_inventory` (`etl/connectors/base.py`, default `True`) gates this: when a connector sets it to `False`, `run_connector` skips `_reconcile_missed_discoveries` entirely for that connector — not just a raised threshold, since even accumulating a miss-count that never triggers anything would still be tracking a meaningless number. Fotocasa sets `discovers_full_inventory = False`. A connector should only claim `True` when its `discover()` genuinely enumerates (or very nearly enumerates) everything active in its scope — pagination through the full result set, an API that returns a complete listing, etc. Until a connector can honestly claim full coverage, its listings simply never auto-transition to `withdrawn` from absence alone (a human/future mechanism would need to confirm removal some other way).

## Partitioning a search space to get past a page-1 cap (and the rate limit that makes it work)

Several sites disallow pagination in robots.txt while leaving *filtered* search paths allowed. Where that holds, sweeping many narrow allowed slices beats fetching one broad page — same compliance posture, far more coverage. Issue #65 established the pattern on Fotocasa; expect it to generalize.

**The mechanics.** Fotocasa's city page embeds ~160 neighbourhood links of the form `/es/comprar/viviendas/{geography}/{zone}/l`, none matched by any Disallow rule. Each returns its own ~30-listing slice, and the slices barely overlap (live-verified: Chamberí vs the unfiltered page shared 0 listings; Chamberí vs Barrio de Salamanca shared 0). `discover()` reads those slugs from the city page itself rather than a hardcoded table, so the list tracks the site as zones are added or renamed. The zone regex is scoped to the requested geography — city pages link *other* cities too, and an unscoped match silently ingests the wrong city's listings.

**Path segments are allowed; query strings are not.** On Fotocasa, `minPrice`, `maxPrice`, `minRooms`, `maxRooms`, `propertySubtypeIds` and `filter=*` (bar an `isnewconstruction` carve-out) are all Disallowed, while zone / property-type / room-count *path segments* are fine. `fotocasa._search_url` therefore builds URLs with no query string at all, and `test_every_constructed_url_is_robots_allowed` drives a real sweep and checks every requested URL against the real robots.txt — so adding a disallowed filter later fails a test rather than quietly shipping.

**Do not trust `protego` for these decisions.** Issue #65's spike found protego 0.5.0 reporting the connector's own working, 200-serving URL as Disallowed: its `_quote_pattern()` runs `urlparse()` over raw pattern text, which drops a literal `?` when only `$` follows it, so `/*/l?$` is evaluated as `/*/l$`. `etl/tests/robots_matcher.py` implements the documented spec directly (only `*` and trailing `$` are special; longest match wins; ties to Allow) and is the reference used by the compliance test.

**The rate limit is the load-bearing part, and it is measured, not guessed.** Turning a 1-request sweep into ~161 makes pacing a correctness concern rather than a courtesy one. Measured on Fotocasa:

| Rate | Behaviour |
|---|---|
| 20/min (3s apart) | First ~4 zones return full data; every page after that is **HTTP 200 with the `__initial_props__` payload missing entirely** — the soft-block page — and it persists for minutes after the burst stops. |
| 3/min (20s apart) | Sustained full data (31/30/30 listings across consecutive real zones). |

The failure mode is why this matters: sweeping too fast does not raise an error or trip the circuit breaker, it silently returns *fewer listings* while every request still looks successful. Fotocasa is therefore pinned at `rate_limit_per_minute = 3`, which puts a full 161-request sweep at roughly 54 minutes. `max_zones_per_sweep` (default `None`, meaning all) bounds that when the schedule can't absorb it.

`discover()` counts zones that failed *and* zones that returned zero listings, and logs at ERROR when more than 80% of a sweep comes back in either state — real neighbourhoods reliably return ~30 listings, so a mostly-empty sweep is the signature of throttling, not of a city full of empty districts. Without that check the degenerate case looks like an ordinary successful run.

**When adding this to another connector**: verify the allowed/disallowed split against that site's own robots.txt (don't assume Fotocasa's shape), confirm slices genuinely differ rather than being SEO aliases of the same result set, and characterise the site's rate tolerance *before* setting `rate_limit_per_minute` — the sustainable rate for a 160-request sweep is unlikely to be the one that worked for a single request.

### Solvia: the partition list doesn't need reverse-engineering — the site publishes it (issue #190)

Fotocasa's zone slugs come from parsing neighbourhood links off the city page itself, because nothing else exposes them. Solvia's `robots.txt` disallows only `/api/` and `/ajax/`, and its `Sitemap:` line points at `https://www.solvia.es/sitemap.xml` — a sitemap index whose `sitemap_comprar_viviendas.xml` child lists one `<loc>` per municipality search page (`.../es/comprar/viviendas/{provincia}/{municipio}`): 1,737 entries nationally, live-verified 2026-08-03 — 43 under `sevilla`, 44 under `malaga`. Same manoeuvre as Fotocasa's zone partitioning, but the subdivision list is handed to you instead of scraped off a page.

**The mechanics.** `discover()` resolves a scope down to a provincia only (not the single municipio a centroid's nearest-known-city match would otherwise pin), then sweeps every municipality page the sitemap lists for that provincia, unioning the ~20 detail links each one renders. This is what makes a Sevilla-centered profile reach `dos-hermanas` — a town `nearest_city`'s 4-entry table can't resolve to directly — by sweeping the whole province rather than by resolving to that specific town.

**Cache the sitemap, don't refetch it per scope.** The sitemap itself is ~700KB of XML for 1,737 URLs — `_municipios_for_provincia` fetches it (index + child, 2 requests total) at most once per 24h, module-level, shared across every scope/provincia in a sweep. `<lastmod>` on every real entry sampled during #190's spike was the same stale date despite `<changefreq>daily</changefreq>` — corroborating that this document doesn't need checking more than once a day.

**Verify derived URLs actually return listings before trusting the pattern** — the property_web_scraper lesson (a prior connector shipped selectors that only matched hand-authored fixture HTML, not anything real): #190 live-fetched `sevilla/dos-hermanas` (9 real listings), `malaga/mijas` (20, the per-page cap), and `sevilla/san-nicolas-del-puerto` (0 — a real, well-formed empty page, not a block) before trusting the sitemap-derived URL shape.

**`discovers_full_inventory` stays `False` even after this change.** Sweeping more municipalities doesn't fix the per-municipality 20-cap, and nothing on a Solvia search page states a total — `ng-state` carries no result-count key, and no `resultados`/`total` string appears in the rendered markup either (checked directly against a real page, not assumed). 20 may be the entire stock for a small municipality or a truncated slice for a busy one, with no signal distinguishing the two.

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

**The second shared defence: `scoped_text(node, keep=..., drop=...)`.** Three connectors independently hit the same bug before it was promoted into the shared helper (issue #141): a listing page renders a *"similar properties"* carousel whose cards carry their **own** price/m²/room figures in the same page text, so any unscoped regex over `soup.get_text()` can silently attribute a neighbouring property's numbers to the subject. Vivantial read `310.000 €` off a neighbour instead of the subject's `288.000 €` (PR #139); Solvia's price fallback had the same latent exposure (PR #138); Servihabitat hit it live on ref `60645658`, an 80 m² / 230.000 € listing whose page text also contains a neighbour's `48m 2 ... 190.000 €` (PR #141).

Two independent defences, usable together:

- `keep="#some-container"` — scope to the subject-property container so nothing else is even considered. The stronger option where such a container exists. Returns `None` when the selector misses, so a `first_present` chain falls through to a whole-page attempt rather than silently yielding `""`.
- `drop=(".carousel", ".related-rail")` — remove known-contaminating subtrees before flattening. The fallback for pages with no clean subject container.

It never mutates the caller's tree (`drop` works on a copy), because a shared helper that silently `decompose()`d the caller's soup would be a trap for the next connector.

**Two testing lessons that came with it**, both worth copying:

1. *Give the neighbour card different values from the subject, in every field you extract.* Servihabitat's fixture deliberately carries 48 m² / 3 hab. / 2 baños / 190.000 € / energy A against the subject's 80 m² / 2 hab. / 1 baño / 230.000 € / energy E. Identical values make the regression untestable.
2. *Assert the mechanism, not only the outcome.* A value assertion can pass by accident when the subject simply appears first in document order. Also assert that the scoped text does **not** contain the neighbour's figures at all.


**When starting a new connector** (see issue #79 for pisos.com/Habitaclia), check the matching `config/scraper_mappings/<locale>_<site>.json` file first for field locations — but verify every selector/regex/JSON-path against a real, live page before trusting it. Their own `expectedExtractionRate` field is a useful signal of how much to trust a given mapping (Idealista 0.75, Fotocasa 0.70, Habitaclia 0.60, pisos.com 0.45 — the lower end reads as thin/speculative, not battle-tested) — but even a high rate doesn't excuse skipping this project's own feasibility-spike discipline (robots.txt check + live sample requests, documented in the implementing PR) established by the Fotocasa/Milanuncios tasks (#12/#15).

## Idealista: a capture-only connector (issue #75)

Idealista is the one connector that never makes a live network request at all — task 1.4's feasibility spike already found it returns an immediate CAPTCHA/bot-detection wall to every direct HTTP request, and property_web_scraper hits the identical wall (their own automated-fetch path explicitly refuses this site). The answer both projects landed on: capture rendered HTML a human's own browser already loaded, and parse that instead of fetching anything.

**`browser-extension/`** is a fork of `chrome-extensions/property-scraper/` from the local `property_web_scraper` reference clone (MIT, attribution in `browser-extension/NOTICE.md`) — the content script (page-HTML capture on message) is used verbatim; the popup/background/options/manifest are trimmed for a single-deployment personal tool (no haul/multi-tenant/API-key machinery, host permissions scoped to Idealista + the owner's own dashboard host instead of ~18 international portals).

**`etl/connectors/idealista.py`** is a real `Connector` subclass with a twist: `scope_key()` always returns `None`, so the orchestrator's normal profile-driven sweep (`run_all_connectors`) skips it every single run without ever calling `discover()`/`fetch_detail()` (both raise defensively if somehow called anyway — see the module docstring). It's still registered in `register_all()` so `CONNECTORS` stays "every known site," but its real entry point is `normalize()`, called directly by `etl/capture.py`.

**Why a queue table, not a synchronous call**: the dashboard (Node/TypeScript, `POST /api/extension/capture`) and this connector's parsing logic (Python, sharing `etl/connectors/extraction.py`'s fallback-chain helper with Fotocasa/Milanuncios) run in separate containers with no shared filesystem or RPC channel — and issue #75 explicitly requires a future automated Idealista connector, if one ever becomes viable, to share one source of truth with this capture path rather than a second, drifting TypeScript reimplementation. `extension_capture` (`etl/schema/init.sql`) is the same "signal via a Postgres row" pattern this project already uses for `etl_manual_trigger`. Flow: the dashboard inserts a `pending` row and returns immediately; `etl/capture.py`'s `run_capture_poll_loop` (started in its own thread alongside the hourly connector scheduler, `etl/main.py`) picks it up on a ~10s interval, runs `IdealistaConnector.normalize()` against the captured HTML, and persists via the exact same `etl.orchestrator._upsert_canonical_listing()` an automated connector's fetch uses — no special-cased bypass, so dedup/hard-filtering/the dashboard see it identically to any other listing. The extension's popup polls `GET /api/extension/capture/[id]` for the result.

**Idealista's mapping is less certain than Fotocasa/Milanuncios's**, and honestly so: `idealista_mapping.py`'s module docstring and inline comments document exactly which fields are grounded in a real (if archival, not independently live-verified — this connector has no way to fetch a fresh page itself) captured sample vs. best-effort (property type from title-text keyword matching, no structured typology field found; `energy_rating` investigated and left `None` — a single sample wasn't enough to confirm which CSS class actually encodes the letter grade vs. static styling). `lat`/`lon` ARE available — from the `center` param of the embedded Google Static Maps URL (`config.multimediaCarrousel.map.src`), not from a structured coordinates field the way Fotocasa/Milanuncios expose one — so the dedup engine's `address_coords` signal does apply to captured Idealista listings, contrary to an earlier version of this connector's incorrect conclusion (Opus review, PR #87). Revisit the remaining best-effort fields once real captures via the extension are available to check against.
