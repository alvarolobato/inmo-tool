---
id: D-018
title: Solvia discover() partitions by municipality via the site's own sitemap
date: 2026-08-03
group: Data / connectors
rule: Solvia `discover()` resolves a scope to a provincia only, then sweeps every municipality page the site's own sitemap lists for it (cached 24h). `discovers_full_inventory` stays `False`.
order: 25
---

# D-018: Solvia discover() partitions by municipality via the site's own sitemap

*Decided: 2026-08-03*

**Context**: Issue #190. Solvia's search pages render exactly 20 detail
links server-side per municipality, with no working query-string
pagination (`?pagina=2`/`?page=2` return byte-identical page-1 results;
real pagination goes through the robots-disallowed `/api/`). Before this
change, `discover()` resolved a scope to the ONE municipality its centroid
was nearest to, so a sweep saw at most 20 listings total — and a town like
Dos Hermanas, 12km from Sevilla's centroid, needed its own table entry to
be reachable at all, no matter how a profile was configured.

This work was cut from `main` (`c3a1263`) before issue #177 merged the
real 8,124-municipality gazetteer (`resolve_place`/`Place`, replacing the
old 4-entry `CITY_CENTROIDS`/`nearest_city`). By the time this PR (#205)
merged, #177 was already on `main`, having independently added Dos
Hermanas/Estepona/Marbella as their own per-municipality entries in
Solvia's `_CITY_SLUGS` table (keyed by `Place.name`) — meaning the
gazetteer alone *can* now resolve a Dos-Hermanas-centered scope directly,
to within 0.18km (`test_geography.py::TestDosHermanasRegression`). That
doesn't make this sitemap-sweep decision moot: the gazetteer only helps a
profile whose centroid happens to land near a town *already in* Solvia's
own per-municipio table. The sitemap sweep below solves the general case —
any provincia's full municipality list, regardless of which single point a
profile's radius happens to center on — so the merged design keeps both:
`resolve_place` answers "what provincia is this scope about" (see
`_PROVINCE_SLUGS`, now keyed by `Place.province` rather than `Place.name`
since only the provincia matters once the sweep covers every municipio in
it), and this sitemap sweep answers "what's everywhere in it."

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
- Relying on `etl.connectors.geography.resolve_place`/`Place` (issue #177's
  gazetteer) alone, without the sitemap sweep, on the theory that adding
  enough individual municipio entries to `_CITY_SLUGS` (the way #177 itself
  did for Dos Hermanas/Estepona/Marbella) would eventually cover every town
  worth reaching: rejected because it doesn't scale past however many towns
  someone thinks to add by hand — the acceptance criterion (a
  Sevilla-area profile reaches Dos Hermanas even though nobody named it) is
  exactly the case a per-town table structurally cannot solve, no matter
  how comprehensive the underlying gazetteer gets. The sitemap sweep
  reaches every one of a provincia's 43-44 municipios without a human
  ever adding a row for each.
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
