---
id: D-023
title: BuildingCenter connector sweeps the entire national catalogue and filters in-memory (no server-side geography/category filter works)
date: 2026-08-04
group: Data / connectors
rule: BuildingCenter talks to `apifrontend.buildingcenter.es` directly; `discover()` sweeps the whole catalogue and filters in-memory — no server-side filter param works.
order: 33
---

# D-023: BuildingCenter connector sweeps the entire national catalogue and filters in-memory

*Decided: 2026-08-04*

**Context**: Issue #118, the next Andalucía-build candidate on #132's ranking
after both #123 Aliseda (D-019) and #126 Haya (D-021) turned out not
buildable. `#132`'s standing spike order (step 0: does the domain still
serve its own site; step 1: byte-diff two pages; step 2: find the real API
and check its own robots.txt; step 3: overlap-sample before building; step
4: sitemap/partitions; step 5: measure the rate) was followed in full.

**Findings, live-verified 2026-08-04, honestly identified UA
(`inmo-tool/0.1 ...`), requests spaced 2-3s apart, none retried**:

1. **Step 0 — domain check**: `https://www.buildingcenter.es/` resolves,
   HTTP 200, own domain, zero redirects. Unlike Haya, a real site exists
   here.
2. **Step 1 — byte-diff**: `/`, `/sitemap.xml`, `/es/compra/viviendas/
   sevilla` and `/es/compra/viviendas/malaga` are all byte-for-byte
   identical (MD5 `7e70eab507c3b6f8ed70f77f767c2f7a`, 18,517 bytes) — a
   bare client-rendered Angular "Public Store" SPA shell with zero
   server-rendered content, the same shape D-019 found for Aliseda. The
   original #118 spike's "results pages look client-side-rendered" flag
   was correct.
3. **Step 2 — real API + its own robots.txt**: the shell's own
   `<meta name="occ-backend-base-url" content="https://apifrontend.
   buildingcenter.es">` (a static tag in the already-fetched HTML — no
   runtime JS execution) names the real backend directly.
   `apifrontend.buildingcenter.es/robots.txt` is a plain HTTP 404 (a real
   Tomcat "Not Found" page, not a WAF interstitial) — **no robots.txt
   published at all**, a different, more permissive shape than Aliseda's
   `laravel.` host's explicit `Disallow: /` (D-019's decisive blocker).
   Nothing is declared off-limits.
4. **Step 3 — overlap sample**: a 5-listing live sample of Solvia's own
   Sevilla search results (`solvia.es/es/comprar/viviendas/sevilla`,
   already an ingested connector, D-018), cross-checked against
   BuildingCenter's Sevilla-province catalogue, found **1 exact match**:
   street "Doctor Barraquer" / "Dr. Barraquer", municipality Los Palacios
   y Villafranca, price 90.815 € to the euro on both sides, 3 bedrooms
   both sides (BuildingCenter code `60540896`, Solvia id
   `182624-221244`). BuildingCenter is **not** 100%-redundant with Solvia
   the way Haya turned out to be (D-021) — genuine partial overlap,
   genuine additive stock alongside it.
5. **Step 4 — sitemap/partition**: `www.buildingcenter.es/sitemap.xml` is
   itself just the same Angular shell, not real XML — no usable sitemap.
   Reverse-engineering the shell's own statically-served, robots.txt-
   `Allow: /.js`'d bundle (`main-*.js` — a plain HTTP fetch of a JS file
   the site already declares crawlable, not runtime execution of it)
   found the real endpoint: `GET apifrontend.buildingcenter.es/rest/v2/
   publicPortal/products/search?fields=...&currentPage=N&pageSize=M`.
   **No query/filter parameter tried had any effect** — `query`, `q`
   (using the site's own observed facet-string encoding), `channel`,
   `provinceCode` all left `pagination.totalResults` and the returned
   products completely unchanged; only `currentPage`/`pageSize` work. A
   full sweep (22 pages of 100 + an 8-item last page) returned exactly
   2,108 unique product `code`s with zero duplicates and zero gaps,
   matching the server's own `pagination.totalResults` precisely.
   `GET .../public/products/{code}?fields=FULL` is the detail endpoint
   (`FULL` is a real SAP Commerce Cloud field-set keyword, confirmed live
   to return every field this connector reads, including per-listing
   `latitude`/`longitude`, `price`, and a full Registro de la Propiedad
   citation — `idufir`, `tomeNumber`/`bookNumber`/`pageNumber`/
   `registerNumber`/`registerPopulation` — though NOT a `referenciaCatastral`
   field, which exists in the site's bundle only as an authenticated
   internal-search filter, not a public field).
6. **Step 5 — rate measured**: the full sweep plus ~20 additional
   exploratory requests ran at roughly one request per 3 seconds (20/min)
   with zero errors, zero soft-blocks, fast (~0.2-0.4s) responses
   throughout. No attempt was made to find a faster ceiling.
7. **A real, non-obvious gotcha found live**: `latitude`/`longitude`
   arrive in **two different string formats**, and — unlike a first
   guess — the format is **not** determined by which endpoint you asked.
   A single national list-scope sweep has both plain sign-prefixed decimal
   (`"+040.2296000"`, 1,335 of 2,108 products) and Spanish-locale
   comma-decimal (`"37,160099"`, 767 of 2,108) at once, e.g. product
   `60540896`'s own list-scope record is comma-decimal while
   `00295250`'s list-scope record (same sweep) is plain-decimal. The
   detail endpoint was comma-decimal on every one of 3 samples checked,
   but that is not a rule the list scope obeys. `parse_coordinate` in
   `etl/connectors/buildingcenter_mapping.py` is one tolerant function
   used for both scopes (detect a comma, treat it as the decimal point;
   otherwise parse as-is) rather than two endpoint-keyed parsers that
   would each be quietly wrong roughly a third of the time.

**Andalucía volume** (national catalogue, category `101` "Viviendas"
only): **759 nationally**, Sevilla province (postal prefix `41`) **53**,
Málaga province (postal prefix `29`) **5**. The original #118/#132 spike's
"Málaga plausibly comparable-or-better [than Sevilla]" guess does not hold
up against a real, complete count — Málaga is a fraction of Sevilla's
volume, not comparable. Sevilla's 53 corroborates (does not exactly match
— different query scope) the original spike's Google-cache-sourced "57".

**Decision**: **Build BuildingCenter as `etl/connectors/buildingcenter.py`
+ `buildingcenter_mapping.py`**, talking to `apifrontend.buildingcenter.es`
directly as a plain JSON REST API — never to the `www` Angular shell.
`discover()` pages through the **entire published national catalogue**
(no server-side geography/category filter works, per step 4's findings)
and filters to category `101` + the requested scope **in-memory**,
computing real per-listing distance (haversine against `scope.center`)
rather than snapping to a municipality centroid, since this connector — a
first for this project — has genuine per-listing coordinates to filter by.
`discovers_full_inventory = True` on positive evidence: the sweep's own
product count matched the server's declared total exactly, with zero
duplicates and zero gaps. `cadastral_ref` is left `None` (the public API
does not expose `referenciaCatastral`); `idufir` (a real but different
Spanish registry identifier) is captured in `raw_extra` instead of being
misrepresented as a cadastral reference. `rate_limit_per_minute = 20`,
mirroring the measured, successful pace and Solvia's own
single-servicer-courtesy default rather than the framework's 30/min.

**Alternatives rejected**:
- Building against the `www.buildingcenter.es` Angular shell with a
  JS-executing headless browser at runtime: out of scope (issue #1 §15 —
  no JS-executing headless browser as part of connector operation, only a
  one-time human reconnaissance session would have been permissible, and
  was not even needed here since the real endpoint was found via a plain
  static-asset fetch).
- Treating `apifrontend.buildingcenter.es`'s missing `robots.txt` as
  equivalent to Aliseda's `laravel.` host: rejected — an explicit
  `Disallow: /` (Aliseda, D-019) is a different, stronger signal than a
  plain 404 for a file that was never published; the two are not the same
  category of evidence.
- Two endpoint-keyed coordinate parsers (`parse_list_coordinate` /
  `parse_detail_coordinate`): tried first, found wrong against a full
  2,108-product sweep (mixed formats within list scope itself) before any
  code shipped — replaced with one tolerant `parse_coordinate` used
  everywhere.
- Skipping the connector because of the confirmed Solvia overlap: rejected
  — a single confirmed match in a 5-listing sample is evidence of partial,
  not total, overlap (contrast D-021's Haya, a 100%-redundant domain-level
  redirect). The remaining ~52 Sevilla and ~4 Málaga Viviendas listings in
  this sample are not shown to be duplicates.

**Rationale**: Follows the spike discipline #132 established across three
consecutive candidates (D-019, D-021, this one) — check the shell, find
the real data source, check that host's own permission signal, sample
overlap, and only then decide sitemap/partition strategy. BuildingCenter
is the first of the four to actually clear every gate: real site, real
unblocked API, confirmed-partial (not total) Solvia overlap, and a
genuinely complete, unauthenticated national sweep with no crawl-budget
ceiling any prior connector in this batch has had.

**See**: issue #118, #132 (tracking issue), `docs/skills/connectors.md`,
[D-018](D-018-solvia-sitemap-partitioning.md) (Solvia, the connector this
one partially overlaps),
[D-019](D-019-aliseda-not-viable-disallowed-api.md) (Aliseda, not
buildable),
[D-021](D-021-haya-merged-into-solvia.md) (Haya, not buildable).
