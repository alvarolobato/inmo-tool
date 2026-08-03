---
id: D-011
title: Solvia discover() partitions by municipality via the site's own sitemap
date: 2026-08-03
---

# D-011: Solvia discover() partitions by municipality via the site's own sitemap

*Decided: 2026-08-03*

**Context**: Issue #190. Solvia's search pages render exactly 20 detail
links server-side per municipality, with no working query-string
pagination (`?pagina=2`/`?page=2` return byte-identical page-1 results;
real pagination goes through the robots-disallowed `/api/`). Before this
change, `discover()` resolved a scope to the ONE municipality its
centroid's nearest known city named (`_PROVINCE_SLUGS`/`nearest_city`
covers only Madrid/Sevilla/Barcelona/Valencia), so a sweep saw at most 20
listings total — and a town like Dos Hermanas, 12km from Sevilla's
centroid but never itself a resolvable geography, was unreachable no
matter how a profile was configured.

`robots.txt` disallows only `/api/` and `/ajax/`, and publishes
`Sitemap: https://www.solvia.es/sitemap.xml`. Its `sitemap_comprar_
viviendas.xml` child lists one `<loc>` per municipality search page
(`.../es/comprar/viviendas/<provincia>/<municipio>`) — 1,737 nationally,
live-verified 2026-08-03: 43 under `sevilla`, 44 under `malaga` (both v1
markets), including `sevilla/dos-hermanas` as its own entry. Each renders
its own 20 server-side, confirmed distinct from neighbouring municipios
(Dos Hermanas: 9 real listings; Mijas: 20; San Nicolás del Puerto, a
~250-inhabitant village: 0, still a well-formed page).

**Decision**: `SolviaConnector.discover()` resolves a scope down to a
**provincia** only (not a specific municipio), then sweeps every
municipality page the sitemap lists for that provincia, unioning detail
links across all of them. `scope_key()` follows suit — two scopes naming
different municipios in the same provincia now dedupe to one crawl target,
since they cover the identical set of pages. The sitemap itself (index +
one child, ~700KB of XML) is fetched at most once per 24h
(`_SITEMAP_CACHE_TTL_SECONDS`), cached module-level, and shared across
every scope/provincia in a sweep — not refetched per scope. A single bad
municipio page doesn't abort the sweep (tolerated up to 3 consecutive
failures, mirroring Fotocasa's zone-sweep pattern, #65); every municipio
in the sweep failing does raise, so a soft-block can never look like a
provincia with zero listings.

`discovers_full_inventory` stays `False`. Sweeping more municipalities
does not change the fact that each one is still capped at 20 with no
readable total anywhere on the page (`ng-state` carries no result-count
key on a search page; no `resultados`/`total` string in the rendered
markup either — checked directly, not assumed).

`rate_limit_per_minute` (20) is unchanged — Solvia showed no soft-block
signature during this issue's own live verification (real municipio-page
fetches at the existing pace), unlike Milanuncios (#179). The real cost
increase is request count: a province sweep is now `len(municipios)`
requests instead of 1 (43 for Sevilla, 44 for Málaga) at the same pace —
roughly 2-2.5 minutes per province, stated here rather than silently
absorbed.

**Alternatives rejected**:
- Depending on `etl.connectors.geography.resolve_place`/`Place` (a real
  per-municipality gazetteer) to resolve a scope directly to
  `dos-hermanas`: not available — that API is mid-rebase on PR #177, not
  on `main`, and `geography.py` is off-limits while that PR is in flight.
  Provincia-level resolution from the existing `nearest_city` turns out to
  be sufficient, because the sitemap itself supplies every municipality
  within the resolved provincia — no per-town gazetteer is needed for this
  fix specifically.
- Keeping the free-text `geography="provincia/municipio"` escape hatch
  pinned to a single municipio (its pre-#190 behaviour): rejected because
  it would leave the free-text path and the real center-based path with
  different, inconsistent coverage — and the acceptance criterion (a
  Dos-Hermanas-area profile must see Dos Hermanas listings) requires the
  whole-province sweep regardless of how the scope was expressed.

**Rationale**: The site publishes the exact partition list a scraper would
otherwise have to guess at or reverse-engineer — the same manoeuvre as
Fotocasa's zone partitioning (#65), except here the subdivision list comes
from the site's own sitemap instead of parsed neighbourhood links.
Sweeping the whole province is what actually solves the acceptance
criteria: a per-municipio gazetteer alone would still only resolve one
named town per scope, not reach a town nobody's profile happens to name
directly.

**See**: [issue #190](https://github.com/alvarolobato/inmo-tool/issues/190), `etl/connectors/solvia.py`, `etl/tests/test_connector_solvia.py`, [D-005](D-005-numeric-vs-uuid-keys.md) (schema), the Fotocasa zone-partitioning precedent in `docs/architecture/connectors.md`.
