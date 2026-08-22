# Connectors skill

How to build a listing-site connector against the `Connector` contract from `etl/connectors/base.py` (issue #11, Phase 1.3). Read this before writing a second/third connector (task 2.1 onward) — it exists specifically so that work doesn't start from scratch reading `etl/connectors/fotocasa.py` cold.

## The contract, in practice

A connector implements three methods (`discover`, `fetch_detail`, `normalize`) and declares a few class attributes (`name`, `rate_limit_per_minute`, `circuit_breaker_*`, `discovers_full_inventory`). The framework (`etl/orchestrator.py`) owns everything else: rate limiting, circuit breaking, persistence, run/result bookkeeping, and (conditionally — see below) withdrawal detection. A connector never touches the database directly and never rate-limits itself beyond calling the `throttle` callback it's given.

`discover` should be cheap — it returns a list of `external_id` strings, nothing more. `fetch_detail` does the expensive full-page fetch for one id. `normalize` is pure (no I/O) and maps whatever `fetch_detail` returned into `CanonicalListingVersion` — every field the canonical schema (`etl/schema/init.sql`, `property`/`listing` tables) has a column for. Anything the site publishes that doesn't map cleanly to a canonical column goes in `raw_extra` (JSONB) rather than being dropped — a later phase might want it even if today's schema doesn't have a slot.

## Feasibility spike first — always

Before writing a single line of parsing code for a new site: check `robots.txt`, make a handful of slow, honestly-identified test requests, and confirm the site doesn't wall off automated access behind bot-detection (DataDome, PerimeterX, Cloudflare challenge pages, etc.). Idealista was the original default target for task 1.4 and failed this spike immediately — every request got a 403 CAPTCHA challenge from `captcha-delivery.com` regardless of User-Agent, robots.txt notwithstanding. That's a hard no: bypassing it means CAPTCHA-solving or a JS-executing headless browser, both out of scope per issue #1 §15 (this is a personal tool, not a scraping operation). Fotocasa passed the same spike — robots.txt allows the needed paths, and real requests returned normal server-rendered HTML.

Document the spike's outcome in the implementing PR, even when the answer is "yes, proceed" — the next person shouldn't have to redo the investigation to find out it was actually checked.

## Embedded JSON is primary; CSS selectors are a fallback, not an either/or (issue #77)

Many modern real-estate sites (Fotocasa included) server-render a full JSON blob into the page — look for a `<script type="application/json" id="...">` tag, or `window.__SOMETHING__ = {...}` inline script, before reaching for CSS-selector-based HTML scraping. It's far more stable (survives markup/styling changes that would break a selector) and gives you structured data (typed fields, nested objects) instead of text you'd have to re-parse. `etl/connectors/fotocasa.py`'s `_extract_initial_props` is the worked example: find the tag by its `id` attribute (don't assume attribute order in a regex — HTML doesn't guarantee it), take everything to the next `</script>`, `json.loads` it.

When a fetch returns that JSON shape but a *different* one than expected (different page template, a "listing no longer available" page, a soft bot-block/interruption page), raise `ConnectorError` rather than returning partial/garbage data — this is the same fail-loud principle as a robots.txt/structural change: better to have the run fail loudly (counted by the circuit breaker) than to silently ingest wrong data. `fotocasa.py` hit exactly this in the wild during the Phase 1.4 feasibility spot-check: 2 of 5 sampled real listings parsed cleanly with full field coverage, 1 returned what looks like a rate-limit/soft-block response with no `__initial_props__` tag — correctly raised, correctly countable, not silently swallowed.

**"Embedded JSON, no fallback" was the house pattern through Phase 2 — it's no longer the recommendation as of issue #77.** Comparing against `property_web_scraper`'s mapping for the same site (`config/scraper_mappings/es_fotocasa.json` in the local reference clone — see [`docs/architecture/connectors.md`](../architecture/connectors.md#reusing-property_web_scraper--the-reference-project-for-this-domain)) showed their extraction treats embedded JSON as the *primary* strategy but keeps a CSS-selector *fallback* for exactly the fields most likely to shift shape on a site redesign (room/bathroom counts, surface area, price). Fotocasa's `normalize()` previously read each of these fields from exactly one JSON path with zero recovery if that key ever got renamed — a real gap, not a hypothetical one, adopted into `etl/connectors/extraction.py`'s `first_present(*getters)` helper (try each getter in order, first non-empty result wins) plus per-connector fallback getters.

**Verify selectors live before trusting a reference mapping — a real example, not a hypothetical caveat.** property_web_scraper's own `.re-DetailHeader-*` selectors for Fotocasa (last checked by them 2026-02-20) no longer match *anything* on the live site as of this connector's own live spot-check (2026-08) — Fotocasa migrated to a Tailwind-utility-class design system with no semantic BEM classes left at all. The working replacement selectors in `fotocasa.py` (`_icon_stat_text`/`_price_fallback_text`) are anchored on SVG `data-title` icon identifiers instead (e.g. `svg[data-title="double_bed"]`'s parent `<li>`) — these survived the exact redesign that broke the reference project's selectors, on the theory that an icon's *meaning* attribute is more redesign-resistant than a layout utility class, but that's a theory to keep re-verifying, not a law. Do not copy a reference-mapping selector into a new connector without checking it against a real live page first, the same feasibility-spike discipline this file already asks for at the discover()/fetch_detail() level.

**One page can carry two objects for the same data — a truncated preview and the complete set. Check for the second one before concluding the data isn't there (issue #654, [D-155](../decisions/D-155-idealista-fullscreen-gallery-source.md)).** Every idealista listing stored exactly 3 photos for months. Two separate investigations concluded the captured HTML simply didn't contain more, and issue #654 was filed to change the *browser extension* to click the gallery open before snapshotting. It was a parser bug: `config.multimediaCarrousel` is a fixed 3-item above-the-fold preview, and `fullScreenGalleryPics` — a second inline object in the same page, holding all 20 items — was never read. Two things generalise. First, when an object looks suspiciously capped (a round number, identical across every listing), grep the raw HTML for the *content* you're missing (here: distinct image ids) before blaming the capture; if the count in the HTML exceeds the count you parsed, it is your parser. Second, the wrong conclusion was reached twice because both passes reasoned about a **detail** page from a **search**-page sample — the two templates carry different objects under different key names (the search page's per-listing blob reports totals in `multimediasTotalSlides`, the detail page in `totalMultimedias`). Calibrate against a capture of the page shape you are actually parsing; `etl.retain_capture_html_for` ([D-150](../decisions/D-150-config-driven-capture-html-retention.md)) exists to get you one.

**Not every inline object is JSON.** `fullScreenGalleryPics` is a JS object literal with unquoted identifier keys mixed among quoted ones (`{"isPlan":false,hoverText:"...",imageDataService:"..."}`) — `json.loads` rejects it outright. Quote the bare keys first, string-aware so a caption or URL containing `:` or a brace is never rewritten (`_js_object_literal_to_json` in `idealista.py`). Reaching for a regex over the raw HTML instead is the tempting shortcut and it loses exactly what you need: per-item flags (`isPlan`, which is the only thing separating floor plans from photos there) and ordering.

**If the page states how many items it has, check your parse against it — otherwise the next key rename reinstates the bug silently (issue #654, [D-155](../decisions/D-155-idealista-fullscreen-gallery-source.md) rule 7).** A layered extraction (`preferred source` → `fallback` → `last resort`) fails *softly* by design: the preferred source returns nothing and the fallback quietly answers instead. That is the right runtime behaviour and the wrong observability story — for idealista, every way the full-gallery read can break (key renamed, a trailing comma or a single-quoted value making `json.loads` reject the literal, a boolean emitted as `undefined`, the URL field renamed) lands back on the 3-item carousel preview with no exception, no log line, and nothing to distinguish it from a genuine 3-photo advert. Sites very often publish their own count next to the data (`totalMultimedias`, `picturesWithoutPlans`, a result-count header). Parse it **independently of the items themselves**, compare, and put the answer somewhere queryable (`raw_extra.photo_gallery_truncated`) plus a warning log. Prefer two independent count sources when the page offers them, so renaming one does not disarm the check along with the parse. Test it by mutating a real capture into each degradation and asserting the flag fires — a flag with no failing-path test is decorative.

## robots.txt shapes what you can implement, not just whether you can start

Read the *whole* file, not just the top-level `Disallow: /`. Fotocasa's robots.txt disallows deep pagination (`/*/l/2*` through `/*/l/39*`) and bare single-segment city paths (`/*/madrid/*`, exact `/madrid/` substring — a hyphenated slug like `madrid-capital` is fine, no literal `/madrid/` substring). This directly constrains `discover()`: the Fotocasa connector only fetches page 1 of search results and does not paginate, which caps how many listings one `discover()` call finds. That's a real, documented scope limit, not an oversight — don't "fix" it by paginating past what robots.txt allows.

## Don't fabricate precision you don't have

If a site gives you a coded bucket (Fotocasa's `antiquity` field is "more than N years," not a literal construction year) or an ambiguous heuristic-only signal (Fotocasa's `clientTypeId` looked promising for particular-vs-agency classification, but a real sampled listing had `clientTypeId=3` attached to an obviously corporate name — see `etl/connectors/fotocasa_mapping.py`'s `infer_listing_kind` for the sturdier signal actually used, `clientUrl` containing `/inmobiliaria-`), don't map it into a canonical field that implies more certainty than you have. Leave the canonical field `None` and keep the raw value in `raw_extra`. A `None` is honest; a wrong guess presented as data is worse than missing data, because downstream code (scoring, dedup, display) will trust it.

## Withdrawal detection only runs for connectors that see their whole inventory

`etl.orchestrator._reconcile_missed_discoveries` tracks a `missed_discovery_count` per listing and marks `withdrawn` (with a `listing_status_event`) after `_WITHDRAWAL_THRESHOLD` (currently 3) consecutive `discover()` sweeps that don't include it — but only when the connector's `discovers_full_inventory` class attribute is `True` (the default). `run_connector` skips this reconciliation entirely for a connector that sets it `False`, before any miss-counting happens.

**This is not a noise-tolerance mechanism — set it correctly, don't rely on the default.** A first instinct might be "pagination noise or a transient hiccup is what the 3-miss threshold is for," but that's only true when `discover()` genuinely enumerates the connector's active inventory for its scope. Fotocasa is the counterexample this attribute exists because of: `discover()` only reads page 1 of search results (robots.txt disallows pagination), and a live check found a single geography (madrid-capital) has 11,000+ real listings sorted by relevance, not a stable order — meaning any active listing can drop off page 1 between sweeps for reasons that have nothing to do with whether it's still for sale. Treating that absence as "3 misses = withdrawn" would corrupt real inventory, not smooth over noise. Fotocasa sets `discovers_full_inventory = False` for exactly this reason (`etl/connectors/fotocasa.py`).

Only set `discovers_full_inventory = True` (or rely on the default) when your connector's `discover()` actually covers everything active in its scope — full pagination through a complete result set, an API that returns the whole inventory, etc. If you can't honestly claim that, leave it `False`; your listings just won't auto-transition to `withdrawn` from absence alone until a future mechanism confirms removal some other way. See [docs/architecture/connectors.md](../architecture/connectors.md) for the framework-level detail.

## The other withdrawal path: verifying a stale listing by asking the site (issue #643, D-157)

A partial-coverage connector can never prove absence by sweeping — but it can
ask about one listing at a time. That is what the orchestrator's
**stale-verification pass** (`verify_stale_listings`) does, and it is why
fotocasa (4.346 activos, 0 retirados nunca) has a withdrawal path at all.

The rule that governs it, and everything else in the withdrawal family, is
[D-157](../decisions/D-157-evidence-not-time-for-withdrawal.md): **elapsed time
may only nominate a candidate; only evidence from the source may change a
status.** Elapsed time on a partial, operator-paced ingest measures *our*
scheduling, not the portal's inventory.

To opt a connector in:

1. Set `supports_stale_verification = True` — and only if
   `fetch_detail(external_id)` makes a REAL request for that id. A connector
   whose `fetch_detail()` re-reads a stash `discover()` filled this run
   (`fotocasa_rental`, `pisos`) raises `ListingUnavailableError` for "not in
   the last discover() payload", which during verification means "we never
   looked", not "it is gone". Such a connector either overrides
   `verify_listing()` with a real stored-URL fetch (pisos does) or stays
   opted out (fotocasa_rental does, explicitly, against its parent's `True`).
2. Implement `verify_listing()` — usually one line delegating to
   `verify_via_fetch_detail()`, which reuses your own detail path, so
   verification can never disagree with the fetch loop about what a page means
   and an alive listing comes back fully refreshed.
3. Optionally implement `retired_page_signature()` — **only** if the portal
   publishes a marker on its own retired-listing page that you have seen live.
   Never invent one: a false positive marks a live listing withdrawn. An
   unparseable/empty 200 is the *soft-block* signature, never a retired page.
   404/410 alone already works, so an absent signature costs nothing.

What each of the three sale portals actually does, spiked live 2026-08-22
against ids taken from production's oldest-`last_seen_at` actives:

| portal | missing detail page | 200-served retired page? | signature |
|--------|--------------------|--------------------------|-----------|
| fotocasa | HTTP **404**, redirecting to the search page with `?propertyNotFound` | not observed | `retired_page_signature` on the `propertyNotFound` URL marker — a second line of defence in case that landing page is ever served with a 200, since its own `__initial_props__` would otherwise normalize as if it were the listing |
| milanuncios | HTTP **404** (tiny redirect-to-home body) | not observed | **none, deliberately** — see the Milanuncios section below |
| pisos | HTTP **404** (`<title>404</title>`) | not observed | no retired signature; instead a positive ALIVE marker (`features__feature`, 7 on a served listing, 0 on the 404 page), because pisos verification never reaches `normalize()` |
| idealista | n/a — capture-only, never fetched (D-081) | **yes**, the notice the owner reads as "lo sentimos, este anuncio ya no está publicado" | the notice SENTENCE in the page's visible text, guarded by the absence of the advert's own markup AND by the reference/size/rooms the notice itself prints matching the listing being captured (D-159) — the only capture-path signature so far |

The same spike is the best available argument for why a soft block must change
nothing: of two stale milanuncios ads checked, one served the real page and the
other served the "Pardon Our Interruption" GeeTest wall with HTTP 200.

### The capture path has a THIRD outcome above both of these: `blocked` (issue #692, D-160)

Everything above is about the *crawl* path. On the **capture** path (the
browser extension POSTing a page a human's browser fetched), the portal can
serve an anti-bot **challenge at the listing URL itself** — so a batch capture
of `/inmueble/<id>/` captures the wall, not the advert. Idealista did exactly
this during the #683 re-capture drain.

A challenge page and a retired-advert notice are **both field-less**, so the
ordering is load-bearing and is evaluated *before* `normalize()`:

| rank | condition | outcome | listing | worklist row |
|---|---|---|---|---|
| 1 | `challenge_page_signature()` matched | `blocked` | untouched | **stays `pending`** |
| 2 | `retired_page_signature()` matched | `withdrawn` | marked withdrawn | retired to `stale` |
| 3 | zero substantive fields | `failed` | untouched | consumed → `failed` |

Rank 3 is *safe* for a challenge (it writes nothing to the listing) but wrong,
and **not inert**: `_mark_failed` calls `_correlate_worklist(..., "failed",
...)`, which flips the `capture_worklist` row out of `pending` and drops the
page from the drain pool. A page the portal refused to serve us must keep its
place in the queue, `requeue_rank` and all.

**To add a portal's challenge wording**, edit `CHALLENGE_PHRASES` in
`etl/soft_block.py` **and** the identical table in
`browser-extension/detect.js` — a test pins the two byte-comparable, so
editing one fails the build until you edit the other. Rules for an entry:

- It must be the **portal's own voice about the visitor's request behaviour**,
  accent-folded and lowercased. Two distinct phrases must co-occur before the
  page counts as a challenge; one alone is quotable by a seller's description.
- **Never anything per-visit** — not the visitor's IP, not the challenge UUID.
  Both are personal data and this is a public repo; tests enforce it.

**Gotcha that cost this project a whole drain**: `detect.js`'s
`detectBlockSignals` corroborates every signature with
`!isRenderReady(doc, portal)`. A *text-rich* challenge page (~490 chars of
prose under a `<main>`) clears `isRenderReady`, so the corroboration threw
away a correctly-matched DataDome marker and the batch never halted. A
signature for a wordy interstitial must set `selfCorroborated: true` and carry
its own, narrower corroboration instead.

**Diagnosability — retain what you cannot explain**: a capture at or below
its portal's measured field-count floor (`_ANOMALY_FIELD_FLOOR`, per-portal,
default 0) keeps its HTML regardless of the retention config (D-150). Without
this, a field-less page is unclassifiable forever after — which is how 33
production Idealista rows ended up byte-identical in the database, one of them
a confirmed withdrawal and the rest unknowable.

The rule is *unexplained*, not *empty*. A **classified** outcome — a
recognised retirement notice, a recognised challenge — **drops** its HTML: we
know what it was and the evidence is already recorded. Only pages nothing
could account for are kept. Get this backwards and retention fills with pages
you already understand; and note it is self-correcting the right way round —
a reworded wall stops being classified, so the sample you need to fix the
phrase table shows up exactly when the table is broken.

### The capture path can carry a signature too (issues #690 and #691, D-159)

`retired_page_signature` was built for the stale-verification pass, which
fetches. Idealista never fetches — but the owner's browser does, and
`etl/capture.py` runs `normalize()` on whatever it captured. So the same hook
works on the capture path, with no request and no WAF exposure: `normalize()`
checks the signature first and raises `ListingUnavailableError`, which
`_process_one` catches (**before** the generic `ConnectorError` branch — it is
a subclass, so the ordering is load-bearing) and turns into `withdrawn` +
`listing_status_event.evidence`.

Five lessons from that work worth carrying to the next capture-only portal:

1. **A capture-only connector's `normalize()` must be able to refuse.** Before
   #690, Idealista's could not: every field is optional, so a non-advert page
   of any kind parsed "successfully" into an all-`None` listing that the
   capture pipeline dutifully persisted — creating 18 phantom listings, erasing
   22 real photo galleries (`_update_existing_listing` COALESCEs scalars but
   assigns `photo_urls` unconditionally), and pushing `last_seen_at` forward on
   listings that were provably gone. If your connector's `normalize()` cannot
   return "this is not an advert", it will eventually persist something that
   isn't one. Add a zero-substantive-fields guard that raises a plain
   `ConnectorError`.

   (The 40 production rows that exposed this — the count as of 2026-08-22
   08:28 UTC; it grows while the #683 drain runs, see D-159 — are "non-advert
   pages" and no more: they share one byte-identical stored footprint —
   `fields_extracted = 3`, no photos, the site-wide `<title>` — one is a
   confirmed withdrawal and
   others may be anti-bot challenge pages, and the retained data cannot
   separate the two, because the HTML is discarded once a capture is
   processed.)
2. **Keep the two outcomes strictly separate.** The recognised notice →
   `ListingUnavailableError` → status change. Anything else unreadable →
   `ConnectorError` → no write at all. Never let the second collapse into the
   first: "I can't parse this" is not "it's gone" (D-157), and a portal behind
   a WAF serves plenty of pages you can't parse.
3. **Recognising the notice is not the same as identifying the listing.** A
   portal's notice page is generic chrome: near enough the same shell for every
   dead advert. On the *fetch* path that gap does not exist — the verifier
   asked for one URL and got one answer — but on the capture path the page
   arrives from a browser nobody controls, so "this page says an advert is
   gone" has to be upgraded to "this page says *your* advert is gone" before it
   may change a row. Look for what the notice prints about the advert it
   replaced: Idealista's carries «Referencia del anuncio», which is the same id
   the URL carries, plus the headline size/rooms. Require the reference; treat
   a *stated* figure that disagrees as a veto, but a *missing* one as no
   information — absence is not a mismatch, or the first reworded notice
   silently kills the channel.
4. **Read the date off the page, not off the clock.** Idealista prints "El
   anunciante lo dio de baja el DD/MM/YYYY". Stamping
   `listing_status_event.observed_at` with `NOW()` instead invents however many
   days sat between the advert dying and the owner happening to open it
   (twelve, in the page that prompted #691). Sanity-check what you parse — nonexistent
   dates, future dates, absurdly old ones — and fall back to the capture time,
   which is at least honestly "when we saw this". A wrong date is worse than no
   date, because afterwards it looks exactly like a right one. And run one
   more sanity check the connector cannot: reject a stated date earlier than
   the row's own `last_seen_at`. That asserts the advert was dead on a day we
   have a record of seeing it alive — believability is relative to what *we*
   observed, so that check belongs where the database is.
5. **A refusal guard must never count a value that has a site-wide
   fallback.** This is the one the #691 review caught, and it had silently
   disabled the whole fail-safe. Idealista's `description` falls back to
   `og:description`, which is the same site-wide blurb on every page the
   portal serves. A page with zero real fields therefore still had a
   non-`None` `description`, the zero-substantive-fields guard never fired,
   and a merely *reworded* notice reproduced the full corruption — including
   overwriting a real advert description with the blurb, since
   `_update_existing_listing` COALESCEs that column. If a field has a
   chrome-level fallback, capture the selector-derived value in its own local
   and put **that** in the guard; the merged value is still fine as the
   returned field. Test it with the fallback PRESENT in the fixture —
   deleting the meta tag to make the test pass hides the defect.

Two mechanics for lessons 3 and 4: the comparison against stored data needs the
database, and connectors do not get one. Return the parsed notice values from
the optional `Connector.retired_notice_facts()` hook (a `RetiredNoticeFacts`,
which `retired_page_signature` should then delegate to so the two can never
disagree about whether a page is a notice) and let `etl/capture.py` do the
comparing. And record everything the notice stated into
`listing_status_event.evidence`, including the final asking price — no other
part of this project captures what an advert wanted when it died.

Two things to get right when opting a connector in:

* **`verify_via_fetch_detail()` reads `raw.raw["html"]`** to run your
  signature. If your `fetch_detail()` returns a parsed payload without that
  key (milanuncios returns `{"url", "props"}`), the signature can never fire.
  The helper now raises rather than silently passing an empty string, but the
  real fix is to return the page HTML alongside whatever you parsed — add the
  two in the same change, never the signature alone.
* **`stale_verification_budget_per_run`** is a per-connector ceiling on the
  global `etl.stale_verification_budget_per_run`, applied as a `min()` so the
  global 0 remains a kill switch. Set it when your portal's measured detail
  budget is tight: verification appends extra detail fetches to *every* hourly
  run, and unlike a within-run budget overrun, a soft block that lasts longer
  than the run interval poisons the *next* run's `discover()` too. Milanuncios
  sets 2 and its rental subclass 1 (D-017/#179: ~5 fetches, then 60+ minutes).

## Skip-if-seen: the fetch-budget policy (issue #143)

`etl/orchestrator.py`'s fetch loop used to call `fetch_detail()` for every id `discover()` returned, every run, unconditionally. That's invisible at ~30 ids and a blocker at ~1,500 (Fotocasa's zone-partitioned sweep, issue #65) — 1,500 ids at 3 req/min is ~8h against an hourly schedule. `_should_skip_fetch` (called once per discovered id, inside `run_connector`) decides whether a listing already known from a prior run is worth re-fetching this run.

**The policy, in order — each check is a reason to fetch regardless of how the others would have decided:**

1. Never fetched before → always fetch. A `listing` row without a real detail fetch yet (the browser-extension capture path, issue #75) must not be mistaken for "recently fetched".
2. `min_refetch_interval_seconds <= 0` → always fetch. **This is the default for every connector.** Skip-if-seen is opt-in per connector, not a global switch — see below for why.
3. Stored `current_price` is `NULL` → always fetch. A core field never captured is worth backfilling, not leaving empty behind a staleness window.
4. An unconfirmed price observation exists (the latest `listing_price_history.observed_at` is newer than `last_fetched_at`) → always fetch, however fresh the listing otherwise looks. This is the re-anchored (D-098) guard against skip-if-seen's central risk: silently no longer detecting a price drop (issue #1 §10, issue #34). It supersedes D-070's old "discovery price ≠ stored price" trigger, which went silent once the observed price became `current_price`. See `Connector.discovered_prices()` below.
5. Otherwise: skip only once `min_refetch_interval_seconds` has genuinely elapsed since the last real fetch.

Two further checks sit *before* the numbered list above (they override every reason): the **accepted-property exemption** (#436, always fetch) and the **list-price capture optimization** (#435, decide from the list price) — both documented in their own subsections below.

**Per-connector, not global — because the economics are per-connector.** `Connector.min_refetch_interval_seconds` (class attribute, default `0` = always fetch, same as every connector's original behaviour) is the lever. A connector opts in by setting it non-zero, with a documented reason for the chosen window — see `fotocasa.py`, the first (and, as of this issue, only) connector to do so. Operators can override it per connector without a code change via `connector_config.min_refetch_interval_seconds` (`NULL` = no override, falls back to the class attribute) — same override-vs-class-default pattern issue #99 established for `filters.rooms`.

**Discovery-time price is a real, verifiable signal — check it live, per connector, don't assume it exists or is reliable.** Some sites embed a structured, machine-readable price in the very search-results page `discover()` already fetches to find ids — reading it costs nothing extra. `Connector.discovered_prices() -> dict[str, Decimal]` (default: `{}`, meaning "no signal") is how a connector supplies it: override `discover()` to stash whatever price data it parses on `self`, then return it from `discovered_prices()`, called by the orchestrator right after `discover()` returns.

- **Fotocasa: confirmed real, wired up.** `initialSearch.result.realEstates[].rawPrice` in the same `__initial_props__` blob `discover()` already fetches (for both the baseline city page and every zone page). Live-verified 2026-08-03 against two real pages: the full `id`/`rawPrice` set matched the connector's own href-extracted external_ids exactly (0 mismatches on either page), and a sampled listing's search-page `rawPrice` matched its independently-fetched detail-page price exactly. This is why `fotocasa.py` is the one connector with `min_refetch_interval_seconds` set (24h — real-estate prices/statuses don't typically move sub-daily, and the discovery-price gate forces an earlier re-fetch whenever one actually does).
- **Milanuncios: investigated, NOT shipped.** Its `discover()` already parses `adListPagination.adList.ads[]` for `id`; the trimmed test fixtures (per this project's "trim to only what the parsing code reads" fixture convention) show each `ad` carrying `category`/`sellerType`/`origin` but no price field. A live re-check of the real site (same 2026-08-03 session as Fotocasa's verification) hit a `noindex`/"Pardon Our Interruption" bot-block page instead of real search results — not retried, per issue #1 §15's good-neighbor discipline. So there is no live evidence either way for this connector's real `ad` shape, unlike Fotocasa's confirmed `rawPrice`. It stays at the base default (`discovered_prices()` returns `{}`, `min_refetch_interval_seconds` stays `0`) — a wrong guess here would be worse than no signal, since `_should_skip_fetch` would trust it. Revisit once a real fetch succeeds.

**Never assume a reference connector's price-reliability finding transfers to a new site.** Verify independently, the same feasibility-spike discipline this file already asks for at the discover()/fetch_detail() level — a discovery-page price field existing on one site says nothing about whether another site has one, or whether it's accurate if it does.

**Observability**: `connector_run_results.skipped_count` (a run row's listings left unfetched this run — distinct from `connector_runs.connectors_skipped`, issue #99's *whole-connector* disabled count) plus a per-listing INFO log line (`"Connector %s: skipping fetch_detail for external_id=%s — %s"`, reason included) is what lets an operator tell "skipped, unchanged" apart from "never fetched" by inspection. That per-listing line is real but not, on its own, something an operator actually reads line-by-line at scale — a full Fotocasa sweep can emit up to ~1,300 of them in one run. What's actually skimmable in a log stream is the per-scope aggregate INFO line `run_connector` also emits (`"Connector %s: skip-if-seen skipped %d/%d discovered listings this scope (fetched %d, errors %d)"`, PR #175); the per-listing lines remain for when someone needs to grep a specific `external_id`'s reason, not as the primary observability signal.

## List-price capture optimization: deep-capture only new/changed (issue #435, D-099)

Built on `discovered_prices()`: where a connector exposes a live-verified list-page price, don't re-open the detail page for a listing whose price the list already confirms is unchanged. `_should_skip_fetch` (before the numbered skip-if-seen checks) decides, for any listing carrying a list price this run:

- **NEW** (never fetched) → always deep-capture (the first pass is always a full detail read — description, photos, all fields).
- **price CHANGED** — a material move (≥1%) vs stored `current_price`, *including* a >60% suspect — → deep-capture this same pass, recording the authoritative price (a suspect is confirmed by the authoritative fetch, which re-applies D-098's sanity band).
- **price UNCHANGED** (sub-1% move) → **skip the deep read** — we already have the detail, and the list confirms the price is stable. This supersedes the staleness window (reason 5) and the history-anchored net (reason 4) for list-price listings; reason 4 still governs listings with no list price (e.g. a capture-path observation the fetch budget never reached).

The big win is Auto continuous mode (#434): a cycle no longer re-opens hundreds of unchanged detail pages.

**Per-connector coverage** (opt-in by construction — mirrors `discovered_prices()`):

| Connector | List price exposed? | Capture optimization |
|-----------|---------------------|----------------------|
| **Fotocasa** (sale) | Yes — `rawPrice`, live-verified (D-070/D-098) | **Active** — unchanged listings skipped, new/changed deep-captured |
| Milanuncios, pisos.com, Habitaclia, Unicaja, Cimenta2, BuildingCenter, bank portals, … | No (`discovered_prices()` == `{}`) | **Falls back to full capture** every pass |
| Browser-extension / worklist capture path | No per-listing list price (sitemap-driven) | Full capture |

**Counters**: `connector_run_results.skipped_unchanged_count` (list-price optimization skips) sits next to `fetched_count` (deep-captured new/changed) and `skipped_count` (skip-if-seen staleness) — the "sin-cambio vs deep-capturados" split. A per-scope INFO line (`"#435 capture optimization skipped %d/%d discovered listings this scope as unchanged (deep-captured %d new/changed)"`) is the skimmable signal.

## Accepted/'en seguimiento' properties are always full-read (issue #436, D-099)

An accepted property (latest feedback = `accept`, matched in an active profile — D-096's tracked working set) is **never skipped** — not by skip-if-seen, not by the #435 optimization. `_should_skip_fetch` checks `is_accepted` first and always fetches. The run materialises the exempt set once via `_accepted_property_ids(conn)` (a cheap, few-row query, keyed on `property_id`, shared across every connector/scope) and threads it into `run_connector`. This keeps the properties the owner is actively tracking maximally up to date (price, status, every field) on every pass, at the cost of a handful of extra fetches per run.

**`listing.last_seen_at` vs `listing.last_fetched_at`**: these used to be the same moment by construction (every discovered id was always fetched). Skip-if-seen breaks that equivalence — `last_seen_at` now means "last confirmed present in a `discover()` sweep" (updated for every discovered id, fetched or skipped, via `etl.orchestrator._update_last_seen_for_discovered`), while `last_fetched_at` means "last time `fetch_detail()`+`normalize()` actually ran" (what `_should_skip_fetch` gates on). Don't conflate them when adding a new consumer of either column.

## Every container start/restart used to be a live scrape — now gated (issue #172)

`etl/orchestrator.py run_scheduler_loop` runs every registered connector immediately on startup, before the first hourly sleep — combined with `restart: unless-stopped` in `docker-compose.yml`, that used to mean every `docker compose up`, every crash-restart, and every `docker compose restart etl` sent real requests to every connector's live site right away, not just once an hour, with no rate-limiter memory surviving the restart (`RateLimiter`/`CircuitBreaker` are constructed fresh per `run_all_connectors` call). A crash-loop — a bad deploy, an unhandled exception during startup, anything that makes the container restart every few seconds to a few minutes — used to hammer every connector's site on every single attempt. Nobody decides to do that; that's what makes it dangerous, especially once the REO-batch connectors (some already behind edge-level WAFs) are in the registry alongside a fragile one.

**The guard**: `etl.orchestrator.should_skip_immediate_sweep(conn, min_restart_sweep_interval_seconds)` checks `connector_runs` for the most recently *completed* run (`status IN ('success','partial','failed')` — a still-`'running'` row, including one `_reconcile_stale_runs` hasn't cleaned up yet, doesn't count as a completion). If one finished less than `min_restart_sweep_interval_seconds` ago, the sweep is skipped entirely — logged at WARNING, with the elapsed time and threshold — and the caller waits for the next scheduled interval instead. `run_all_connectors_respecting_restart_guard` wraps this decision around `run_all_connectors`; `run_scheduler_loop` and `etl/main.py`'s `--once` (full-sweep) path call it instead of `run_all_connectors` directly.

- **Threshold**: `etl.min_restart_sweep_interval_seconds` (config key / `ETL_MIN_RESTART_SWEEP_INTERVAL_SECONDS` env var), default 900s (15 min) — long enough to absorb a real crash-loop, short enough that a genuine multi-hour-down restart still sweeps immediately almost always. `0` disables the guard outright (an explicit operator opt-out).
- **Not applied to a named single-connector run.** `ps connector run <name>` is a deliberate, targeted operator action — `etl/main.py` routes it through the plain `run_all_connectors`, never the guard. Only a full sweep (`ps connector run` with no name, or the scheduler loop) is gated.
- **A normal restart after a genuine gap still sweeps immediately** — the guard only fires when the *previous* completed run is suspiciously recent, not on every restart.

If you're adding a new connector with an aggressive rate limit or a fragile source, this guard is why you no longer need to personally remember not to restart the container repeatedly while debugging something unrelated — but it's a safety net for an *unattended* crash loop, not a reason to be careless about deliberate, rapid manual re-runs during development (each of those still counts as "a completed run finished recently" for the *next* unattended restart).

## Second worked example: Milanuncios — where it differs from Fotocasa

Task 2.1 (#15) added Milanuncios specifically because it's a general classifieds site, not a real-estate specialist — higher private-seller density (17/41 sampled Madrid listings, feasibility spike) than a professional-listing-heavy site like Fotocasa, which matters for task 2.2's phone-in-description dedup signal (4/17 of those private listings had a real number embedded in free text). Structural differences a third connector implementer should expect, not assume are universal:

- **Double-encoded embedded JSON, not single.** Fotocasa's `<script type="application/json">` tag contains a bare JSON object. Milanuncios' `window.__INITIAL_PROPS__ = JSON.parse("...")` wraps the payload as a JSON *string literal* — the argument to `JSON.parse` is itself escaped JSON text, so extraction needs two `json.loads` passes (unescape the string literal, then parse the result). Don't assume "embedded JSON" always means one decode step; check what's actually between the markers before writing the extraction regex/scanner.
- **Explicit structured field beats a URL/name heuristic, when the site gives you one.** Fotocasa has no reliable structured "is this a private seller" field, so `fotocasa_mapping.py`'s `infer_listing_kind` has to heuristic-match on a URL pattern. Milanuncios publishes `ad.sellerType.isPrivate` as a literal boolean — use it directly, no inference needed. Always check for a direct field before reaching for a heuristic; heuristics are a fallback, not a default approach.
- **`valueFormatted` vs. raw `value` in an attributes array is a real, repeatable trap.** Milanuncios' `ad.attributes` entries carry both a raw `value` (e.g. `"353"`) and a human-formatted `valueFormatted` (e.g. `"353 m²"`) for the same attribute. Using the formatted string for a numeric field silently produces `None` from a `Decimal()`/`int()` parse failure caught too broadly — this happened during implementation (`m2_built` came back empty on a real listing) before the fix (`milanuncios_mapping.py` has two lookup functions, `attribute_value` for display-oriented fields like floor, `attribute_numeric_value` for anything going into a numeric column). Check which shape you're reading before assuming a field parses cleanly.
- **Cross-site syndication is a real, already-existing dedup case, not a hypothetical.** Some Milanuncios listings carry `origin.provider = "fotocasa_pro"` — Milanuncios and Fotocasa are both Adevinta-group properties and syndicate some professional listings between them. Task 2.2's dedup engine will see genuine cross-site duplicates on day one of running both connectors together, independent of any private-seller cross-posting behavior.

**Issue #179 (2026-08-03) partially resolved this, issue #66's core case remains open.** A real soft-block page was captured live during #179's rate measurement — a GeeTest CAPTCHA challenge with a stable, checkable signature (`"Pardon Our Interruption"`, `noindex, nofollow`, `#captcha-box`; trimmed into `milanuncios_sample_soft_block_page.html`). `MilanunciosSoftBlockError` (a `ConnectorError` subclass — the circuit breaker still counts it identically) now fires specifically when that signature is present. What's still unresolved: a removed/expired ad page. Nobody has yet captured a real one to compare against — it may or may not share the soft-block signature above, and until a live sample exists, anything missing `__INITIAL_PROPS__` *without* the confirmed soft-block markers still raises the generic `ConnectorError`, folded into circuit-breaker error accounting the same conservative-but-imprecise way as before. Resolve once a connector has accumulated a real removed-ad hit to know what that page actually looks like, and consider mapping a confirmed removal to `listing_status_event` status `withdrawn` directly rather than counting it as a connector error at all. **Still open as of issue #643 (2026-08-22)**: a fresh live spike found only that a *nonexistent* `/x/x-<id>.htm` answers a clean HTTP 404 — which D-049 already handles — and that one of two genuinely stale ads served the CAPTCHA wall. No 200-served "anuncio caducado" page has been captured yet, so milanuncios deliberately ships **no** `retired_page_signature` (D-157): a signature built on "the props are missing" would map a rate-throttle straight to `withdrawn`.

**Issue #179 rate finding, worth knowing before touching this connector's pacing again**: `rate_limit_per_minute` was 20 by analogy to a Fotocasa default that no longer exists; production was tripping the circuit breaker every run. Measured live rather than guessed: 20/min AND 6/min both fail identically (~5 `fetch_detail` successes, then a soft-block lasting 60+ minutes) — a 3.3x slower pace made zero measurable difference, ruling out the entire 6-20/min range but not pinning the exact safe floor. Shipped at `rate_limit_per_minute = 2`, deliberately below Fotocasa's independently-measured 3, not equal to it. Full write-up: `docs/architecture/connectors.md`'s "Milanuncios: a worked example of measure, don't copy" section and [D-017](../decisions/D-017-milanuncios-rate-measurement.md).

**Photo URLs need a CDN `?rule=` parameter you won't find in the JSON (issue #206).** `ad.images` gives bare `<host>/images/ads/<uuid>` paths with no query string — but one of the two hosts these resolve to (`images.milanuncios.com/api/v1/ma-ad-media-pro/images/<uuid>`, a size/crop-transform proxy) 404s `"Rule parameter not Found"` without an explicit `?rule=<preset>` appended, live-confirmed both ways. The site's own rendered `<img>` tags always carry this parameter; the embedded JSON never does — a general lesson beyond this one field: don't assume a JSON payload URL is complete just because it starts with a valid host/path, check what the site's *own rendered markup* actually requests before trusting a JSON-sourced URL is fetchable as-is. Full write-up: `docs/architecture/connectors.md`'s Milanuncios photo-CDN section and [D-020](../decisions/D-020-milanuncios-photo-cdn-rule-parameter.md).

**That fix only covered new ingests — pre-existing rows needed a backfill (issue #210).** `normalize()` only runs at ingest, so the ~795 photo URLs already stored before #206/#209 deployed were untouched (0% carried the rule parameter). A one-off `etl/schema/init.sql` migration backfills them, reusing `add_photo_rule_if_missing` (hoisted to module level in `etl/connectors/milanuncios.py`) as the single source of truth for the rule string — the migration's SQL is pinned against it by a DB-backed equivalence test rather than trusted to stay in sync by hand. General lesson: a connector-layer fix to `normalize()` never touches rows written before it shipped — check whether a backfill is needed any time a bug like this is found. See [D-022](../decisions/D-022-milanuncios-photo-backfill-migration.md).

## BuildingCenter: a client-rendered shell with an *unblocked* API behind it (issue #118)

Worth reading before assuming "client-rendered SPA shell" always means Aliseda's outcome (D-019, not buildable). BuildingCenter's `www.buildingcenter.es` is the exact same failure shape at step 1 — every route (`/`, `/sitemap.xml`, any search results page) is a byte-identical Angular "Public Store" shell with zero server-rendered content. The difference is what step 2 found: the shell's own `<meta name="occ-backend-base-url">` tag (a static value already present in the fetched HTML — no runtime JS execution needed) names the real backend, `apifrontend.buildingcenter.es`, and **that host publishes no `robots.txt` at all** (a plain 404) rather than Aliseda's explicit `Disallow: /`. Two shells that look identical at step 1 can resolve completely differently at step 2 — always check the real host's own robots.txt before concluding "not buildable" from the shell alone. See [D-023](../decisions/D-023-buildingcenter-national-sweep-connector.md).

**No server-side filter parameter worked, so `discover()` sweeps everything.** Every plausible filter tried against the real search endpoint (`query`, `q` with the site's own observed facet-string syntax, `channel`, `provinceCode`) left the result set completely unchanged — only `currentPage`/`pageSize` do anything. Rather than give up or guess at an untested filter shape, `discover()` pages through the entire published national catalogue (2,108 products, 22 pages) every call and filters to category + scope in-memory. This turned out to be a genuine positive: the sweep's own count matched the server's declared total exactly, with zero duplicates and zero gaps — more complete coverage than any other connector in this batch (Solvia's 20-per-page cap, Fotocasa's page-1-of-many), earning `discovers_full_inventory = True` on real evidence, not the class default.

**A coordinate-format gotcha that would have been easy to ship wrong.** The natural hypothesis — "list-scope responses use one format, detail-scope responses use another" — is false. A single list-scope search response has BOTH plain sign-prefixed decimals (`"+040.2296000"`) and Spanish-locale comma-decimals (`"37,160099"`) for different products at once (1,335 vs. 767 of 2,108 in a full sweep), not determined by which endpoint you called. `buildingcenter_mapping.parse_coordinate` is one tolerant function (detect a comma, treat it as the decimal point) used for both scopes, verified against the full sweep rather than the handful of samples that would have supported the wrong endpoint-keyed hypothesis. General lesson: when a plausible "format depends on X" hypothesis explains your first few samples, check it against the *whole* dataset before writing two code paths around it — a few more samples here would have shipped a parser that silently misparsed roughly a third of list-scope coordinates.

**Registry citation, but not a cadastral reference.** The public detail endpoint publishes a full Registro de la Propiedad citation (`idufir`, `tomeNumber`/`bookNumber`/`pageNumber`/`registerNumber`/`registerPopulation`) — but `referenciaCatastral` exists in the site's own JS bundle only as a filter on an *authenticated* internal cooperator/agent search, never as a field on the public product representation. `idufir` is captured in `raw_extra`, not mapped onto `cadastral_ref` — a different Spanish identifier presented as the wrong one would be exactly the "wrong guess presented as data" `CanonicalListingVersion`'s own docstring warns against. Worth checking on every future servicer connector: "does this site publish *a* registry identifier" and "is it *specifically* referencia catastral" are two different questions, and the first answer being yes doesn't make the second one yes for free.

## Cimenta2: the backend answered, and that was the problem (issue #136)

The counterpart to BuildingCenter above, and the reason "check the real host's robots.txt before concluding not-buildable" is a necessary step but not a sufficient one. Cimenta2 (`cimenta2.com`, Cajamar) reaches step 2 in better shape than BuildingCenter did: **both** hosts publish permissive `robots.txt` files (the main site's is literally `Disallow:` with an empty value), the Salesforce Experience Cloud backend (`inmuebles.cimenta2.com`) publishes a **same-day-current sitemap enumerating 3,917 assets** with a per-property reference code right in the URL slug, and nothing anywhere returns a 403, a CAPTCHA, or a challenge. `discover()` would have been trivial and genuinely complete — the sitemap-driven shape that makes Servihabitat and Vivantial the two flawless connectors in this repo.

It still isn't buildable, and the failure is at a step none of the earlier spikes reached. Detail pages are contentless Lightning shells (no JSON-LD, no embedded record JSON, no component tree, and the documented non-spoofing `?_escaped_fragment_=` prerender parameter returns a **byte-identical** response — verified, not assumed). The only channel that yields data is Salesforce's internal Aura RPC, and a single guest probe came back with the asset object's **entire internal field set** — the bank's acquisition cost and appraisal value, live offer-negotiation state, and schema fields for an owner's tax ID, telephone and IBAN — none of which the site displays. That's a guest field-level-security misconfiguration, not a published API.

**Three transferable lessons:**

1. **A permissive `robots.txt` is not consent to take whatever an endpoint returns.** It answers "may a crawler request this path", not "is this data published". When those two answers diverge, the second one governs. This is the first site in the batch where the stop condition is our own restraint rather than the site's refusal — and it will not be the last, because Salesforce/ServiceNow/low-code community portals are common in this sector and guest FLS is a routine thing to get wrong.
2. **Scoping the request to the fields you're comfortable with does not fix it.** The tempting move is to ask only for the ~15 fields the site publicly displays. Rejected in D-033: the reason a guest can read the *price* is the same misconfiguration that exposes the *IBAN*, so the narrow request is still built on a permission bug — and still breaks the day it's fixed.
3. **Stop probing the moment you can answer the question.** One record per object type was enough to characterise feasibility. Don't sample "a few more to be sure" once the finding is clear, and don't commit the endpoint path, framework tokens, action descriptor, probe script, captured response, or any real value into this public repo. D-033 documents the verdict without publishing a working recipe; match that.

If a portal like this turns out to be worth having, the browser-extension capture path (#75) is the right route and a genuinely good fit rather than a fallback — it captures what the site actually *renders* to a human, which is the public field subset by construction.

**A fourth shape, added after the spike: the discovery-only connector ([D-034](../decisions/D-034-cimenta2-sitemap-index-only.md)).** The spike's verdict on the *endpoint* stands unchanged — it must not be used, for any field, under any scoping. But "the detail channel is off-limits" and "there is nothing worth building" are two different conclusions, and `etl/connectors/cimenta2.py` now ships as the second: it reads the public sitemap, records that 3,917 Cajamar-owned assets exist with their reference codes and URLs, and its `fetch_detail()` makes **no network request at all**. Four things generalise to the next portal in this shape:

1. **Check what the schema actually permits before declaring a connector impossible.** D-033 rejected the sitemap-only build partly because it "cannot populate a `listing` row" — but `listing.current_price` is nullable, and a real-Postgres round-trip proves a price-less, coordinate-less row persists fine. An architectural claim about a schema is cheap to verify and was wrong here; verify it rather than reasoning about it.
2. **Measure a slug-parsing plan before committing to it.** The plan was to mine `city`/`province`/`property_type` from the sibling `inv-expediente` sitemap, whose slugs look reassuringly structured (`chalet-antas-almeria`). Parsed against this repo's own gazetteer, all 490 resolved a province only **63%** of the time and a municipality **44%** — because municipality and province run together with no separator (`rusticaciezamurcia`), some records span two provinces at once (`naves-huelva-y-madrid`), and many are portfolio codes or marketing names (`trafalgar`, `troya`, `expediente-prueba`). Worse, those records are multi-asset *case files*, not properties, with no public key linking them to the assets inside. A sample of six slugs would have looked fine; the full parse is what showed it wasn't.
3. **"No detail fetch" needs an explicit no-throttle decision.** The orchestrator does not acquire the rate limiter around `fetch_detail` — the connector's own `throttle()` call is the pacing mechanism. A zero-request `fetch_detail` that calls `throttle()` anyway would serialise 3,917 no-ops at 20/min and turn a two-request sweep into a ~3-hour run.
4. **A full-inventory claim on a single-document sweep needs two guards, not one.** `discovers_full_inventory = True` is honest here (one request, no pagination, no cap), but `discover()` must raise rather than return `[]` both when the response has no `<loc>` entries (an error page) *and* when it has many that none of the parser recognises (a URL-scheme change). Either silent `[]` reads as "the whole catalogue was withdrawn".

Price, in this shape, comes from **cross-portal dedup inheritance**, not from the connector: emit the strongest publicly derivable dedup key (here `reference_code`) and let a linked twin on a portal that *does* publish a price supply it. Know that ceiling before promising it — `reference_code.evaluate` needs coordinate/size/price proximity to reach `decision="merge"`, so a connector publishing none of them is permanently capped at the uncorroborated 0.500 *suggestion* tier, i.e. human-confirmed rather than automatic.

## Unicaja: a server-rendered Struts search, and the field that's on the card but not the detail page (issue #119)

The first REO connector in the #132 batch that is **neither** a sitemap sweep (Diglo/Servihabitat/Cimenta2) **nor** a JSON/SPA backend (BuildingCenter) — `unicajainmuebles.com` is a classic server-rendered Java/**Struts** app (`*.do` actions) with no `__NEXT_DATA__`/`utag_data` blob and **no sitemap** (`/sitemap.xml` 404s). Discovery paginates the search action `listadoPromocion.do` (the pagination form's own target: `definitionName=busqueda`, `tipoInmueble=0` = VIVIENDA/residential, `tipoOperacion=1` = COMPRA/sale, `provincia=<INE code>`, `pagina=<n>`), walking pages until one yields no NEW reference or a short (<10) page — pagination is next-only, there is no total-count element to read. Three transferable lessons:

- **The province filter is a numeric INE code, and the gazetteer's name isn't always the site's name.** Unicaja's `provincia` `<select>` uses INE codes (29=Málaga). The gazetteer's `Place.province` gives an ASCII name that *differs* from the site's own label for several provinces ("Bizkaia" vs. "VIZCAYA", "Coruna" vs. "A CORUÑA", "Illes Balears" vs. "BALEARES", "Castello" vs. "CASTELLÓN"). `unicaja_mapping.province_to_ine_code` folds both vocabularies plus bilingual aliases to one code table, keyed by an accent-stripped lowercase form. When a site filters by a coded province, build the name→code table from the site's own `<select>` (authoritative) and key it so a name from *either* the gazetteer or the site resolves — don't assume the two spell provinces the same way.

- **A field can be on the search card and NOT on the detail page — check both, and merge.** Unicaja's search-result cards are richly structured (`label.titulo`/`label.valor` pairs: provincia, municipio, **código postal**, tipo, superficie, habitaciones, reference, description), and the **postal code appears on the card but not on the detail page** (verified on real listings). The connector stashes each card on `self._cards` during `discover()` (rebuilt each call) and `fetch_detail` reads it back to recover the postal code — the same "stash at discovery, read per-listing" pattern the base class documents for `discovered_prices()`. `normalize` merges card + detail, preferring the detail page for price/coords/baths/useful-surface/photos. Don't assume the detail page is a superset of the search card; a dedup-relevant field (#76's `postal_code`) can live only on the card.

- **es-ES uses `.` for BOTH thousands (in prices) and decimals (in surfaces) — on the same page.** Unicaja renders the price as `169.400,00 €` (dot=thousands, comma=decimal) but surfaces as `53.23 m2` / `169.0m2` (dot=**decimal**). A single "strip all dots" parser silently 10-100×'s one of them. `unicaja_mapping` keeps two functions — `parse_es_price` (drop everything from the comma, remove thousands dots) and `parse_es_surface` (integer part before the dot). Check which convention a numeric field uses before reusing a number parser across fields on the same site (the same class of trap as Milanuncios' `value` vs `valueFormatted`).

Also worth noting for the batch: the detail page's "Viviendas cercanas" carousel is **AJAX-loaded** (`listaInmueblesCercanosAJAX.do`), so it is absent from the static HTML — the carousel-contamination trap Diglo/Servihabitat/Vivantial each scoped around does not exist here. And a batch-adjacent spike result: **Ibercaja** (#127) has no standalone portal at all (its `ibercajainmuebles.*` domains don't resolve) — its REO stock is listed on Solvia (`solvia.es?esOrigenProducto=IBERCAJA`, already ingested), so no connector was written (D-065, same shape as Haya→Solvia D-021).

## pisos.com and Habitaclia: two generalist portals, opposite shapes (issue #79)

Two mainstream Spanish portals added as a scope expansion (issue #79). Both passed the feasibility spike; both are built; both had a reference mapping (`es_pisos.json` / `es_habitaclia.json`) that was wrong about them in a different way. Read before adding a third generalist portal.

- **pisos.com (`pisos.py`, D-071, revised by D-141) is search-payload-primary, PLUS one detail fetch per listing for reference/agency only** (the D-066 shape for every other field — `discover()` stashes each card, `fetch_detail()` reads price/rooms/baths/m²/floor/coordinates/photos from that stash with no extra request). The search-results page is far richer than the reference mapping's 0.45 extraction rate implied: each `.ad-preview` card carries price (`contact-box[data-ad-price]`), rooms/baths/m²/floor (`.ad-preview__char`), title/subtitle/description, the detail URL (`data-lnk-href`, first token = property type), photos, AND a per-card `<script type="application/ld+json">` (keyed by the same `@id`) with `geo.latitude`/`geo.longitude` + locality. The detail page has NO JSON-LD and is poorer for every one of those fields — but issue #628 found it's the ONLY place `reference_code`/`contact_raw` live (`features__feature` labelled "Referencia:" / `owner-info__name`), so `fetch_detail()` now makes one real request per listing purely to recover those two, degrading to search-card-only on a failed request. **A low reference-mapping extraction rate is a reason to re-spike, not skip — it can be stale pessimistically.**

- **Habitaclia (`habitaclia.py`, D-072) is discover + bespoke-HTML detail fetch, and the "Adevinta owns both so the payload resembles Fotocasa's" hypothesis is FALSE.** Habitaclia is an older ASP.NET `.htm` stack with `*DTO` inline-JS objects — no `__initial_props__`, no shared code, and (contrary to `es_habitaclia.json`'s every-field-via-`jsonLdPath`) NO JSON-LD on the live page at all. lat/lon exist only on the detail page as `VGPSLat`/`VGPSLon` in a StreetView config (regex-matched), so a detail fetch is required (unlike pisos.com). Price is read from the subject `.price` element, scoped away from the `.sim-price` similar-listings carousel (the same contamination trap Vivantial/Servihabitat/Solvia hit); rooms/baths/m² from the "Distribución" `<article>`; reference from the "Referencia del anuncio" line; type/city from the URL slug. The `captcha` strings on the page are a Google reCAPTCHA-enterprise badge for the phone-reveal flow, not a wall. **Shared corporate ownership does not imply a shared front-end stack — check the real payload.**

Both: page-1-only (`discovers_full_inventory=False`), `operation="sale"`, `listing_kind=None` (no confirmed particular/agency signal), guarded `discover()` that raises on an empty/broken page, born disabled (#100).

## Registration

Add your connector class to `etl/connectors/__init__.py`'s `register_all()` function — a single `.append(...)` line. Don't register at import time (a module-level `CONNECTORS.append(...)` in `etl/connectors/__init__.py`) — see that file's docstring for why that creates a circular import with `etl.orchestrator`. `register_all()` is called once, explicitly, from `etl/main.py`, after `etl.orchestrator` is already fully imported.

## Testing

No live network calls in the test suite — save fixture HTML/JSON (trimmed to what the parsing code actually reads, with a comment noting it's a trimmed/synthetic reconstruction of a real page observed on a given date, not a literal full-page dump) and monkeypatch the HTTP call. See `etl/tests/test_connector_fotocasa.py` and its `etl/tests/fixtures/fotocasa_sample_*.html` fixtures for the pattern. Orchestrator-level behavior (price-history append, withdrawal detection) is tested against real Postgres in `etl/tests/test_orchestrator.py` using `DummyConnector` (`etl/tests/fixtures/dummy_connector.py`), not the real site connector — that suite doesn't need network access either.

## Known-good cross-site matched pair, for task 2.2's dedup engine

Issue #15 (Phase 2.1) called for identifying a real cross-site duplicate (the same property listed on both Fotocasa and Milanuncios) so the dedup engine (task 2.2) has a concrete example to build against. A live sweep of both connectors during that task found none — page-1-only discovery on each connector over a small sample, so the odds of a real overlap turning up by chance were low. That's an honest, expected outcome of a small live sample, not a gap to paper over.

Instead, `etl/tests/fixtures/fotocasa_sample_detail_dedup_pair.html` and `etl/tests/fixtures/milanuncios_sample_detail_dedup_pair.html` describe the same **fictional** property (Trafalgar/Chamberí, Madrid, ~70m²) on both sides, deliberately with a realistic small cross-site price difference (285000€ vs. 279000€) rather than an exact match, and the same phone number embedded in both free-text descriptions — the actual phone-in-description dedup signal from issue #1 §6. `etl/tests/test_connector_cross_site_dedup_fixtures.py` proves both connectors' `fetch_detail`/`normalize` produce matching size, close-but-not-equal price, and the shared phone number from these two fixtures. Task 2.2 should point its own signal-matching tests at this pair as a known-good "these ARE the same property" reference, rather than depending on whatever real data happens to be sitting in the database on a given day.
