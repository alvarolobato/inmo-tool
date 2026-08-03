# Spanish municipality gazetteer (`es_places.csv`)

Backs `etl/connectors/geography.py`'s point -> municipality/province
resolution (issue #169). Loaded once at import time; no network dependency
at runtime.

## Provenance

- **Source**: [GeoNames](https://www.geonames.org/) country dump for Spain
  (`ES.zip`) plus `admin2Codes.txt`, both from
  <https://download.geonames.org/export/dump/>.
- **License**: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  This file is a filtered/reshaped derivative of GeoNames data,
  redistributed under the same license — attribution: "Contains data from
  GeoNames (https://www.geonames.org/), CC BY 4.0."
- **Fetched**: 2026-08-03.
- **Regenerate with**: `scripts/build-es-gazetteer.py` (see that file's
  docstring for the exact commands). Re-run it whenever GeoNames refreshes
  municipality data, or a resolution bug turns out to be a stale/wrong
  upstream coordinate — this is a mechanical download-and-run, not a
  re-curation exercise, which is the whole point of vendoring a real
  dataset instead of hand-typing city coordinates (see issue #169's
  history: a 4-entry, then a larger but still hand-curated table, both hit
  the same "someone has to remember to add the next city" ceiling).

## Coverage

8,124 rows, one per Spanish municipality (a small number of provincial/
regional capitals — e.g. Sevilla — have no independent GeoNames "ADM3"
record and are included instead via their admin-capital record; see the
build script's docstring for the exact feature-code selection and why).
Every provincial capital and every municipality GeoNames tags as a
third-order administrative seat is present — this is not a hand-picked
subset by population threshold. (Row count dropped from 8,248 in PR #177
round 3 — see "Existence dedup key" below; every dropped row was a
duplicate of a still-present municipality, never a real place lost.)

One upstream data-quality fix is applied (not area curation — see the
build script's `_NAME_OVERRIDES_BY_GEONAMEID`): GeoNames' own ADM3 record
for Sevilla (geonameid 6361046) carries the English exonym "Seville" as
its name/asciiname, unlike literally every other populous Spanish
municipality checked (which differ from their asciiname only by accent
stripping, e.g. "Málaga" -> "Malaga"). Left as-is, this record would not
have collided with the separate "Sevilla"-named PPLA record for the same
city, so the gazetteer would have silently carried both "sevilla" and
"seville" as distinct entries — and any point `nearest_place()` resolved
to "seville" would miss every connector's `_CITY_SLUGS` table (all keyed
on the Spanish "sevilla"), reintroducing issue #169's silent-zero-coverage
bug for one of the two markets the owner named explicitly. Corrected to
"sevilla" by geonameid before dedup.

Columns: `name` (ascii, lowercased — e.g. `estepona`), `lat`, `lon`,
`province` (ascii, e.g. `Malaga`), `population`, `feature_code` (the
GeoNames code the row came from, for traceability), `geonameid` (GeoNames'
own stable id, for looking a row up on geonames.org if a coordinate looks
wrong).

**Existence dedup key (PR #177 round 3)**: which rows survive as one
municipality is now keyed by GeoNames' `admin3 code` (Spain's real
per-municipio INE code), not `(name, province)` text as originally built.
GeoNames' own `asciiname` column is occasionally internally inconsistent
for the exact same accented name — e.g. Güevéjar's ADM3 row asciinames
itself "Gueevejar", its PPLA3 row (identical accented name, same admin3
code) asciinames itself "Guevejar" — a diaeresis-transliteration glitch,
not a legitimate alternate name (15 admin3 codes measured in the current
dump). Keying dedup by `(name, province)` text let one real municipality
split into two gazetteer rows over this — one of them a name no
connector's `_CITY_SLUGS`-equivalent table will ever hold, and
`nearest_place()`'s population credit deterministically picked whichever
duplicate happened to carry the higher reported population, which was the
mangled name in every measured case. The surviving row's NAME is now also
computed by the script itself (`_fold_ascii`, a plain Unicode NFKD
decompose + combining-mark strip on the accented `name` field) rather than
trusting GeoNames' own `asciiname` column verbatim, so this can't
resurface on a future GeoNames refresh either.

**Coordinate preference (PR #177, refined in round 3)**: which (name,
province) key survives is decided by existence dedup above; the LAT/LON
that surviving row carries is a separate decision handled by
`_pick_coordinate` in the build script. GeoNames' plain `ADM3` row is a
reference point for the *administrative division's boundary*, not
necessarily anywhere near where the population actually is — measured up
to 8.27km off for Madrid, 7.47km for Mijas. When a locality-type record
(`PPLC`/`PPLA`/`PPLA2`/`PPLA3`/`PPLA4`, or a plain `PPL` fallback) exists
for the exact same municipality (matched by `admin3 code`, never by
name/province text) AND its name plausibly matches the municipality's own
(round 3: a rural municipio's admin3 code can carry dozens of
differently-named hamlets, e.g. Talayuela's also carries "Pueblonuevo de
Miramontes", a real but different, 20.9km-away settlement — matching by
admin3 code alone is necessary but not sufficient for a safe coordinate
override), its coordinate is used instead, picking the closest such
candidate to the ADM3 reference point when several tie (round 3: this tie
was previously broken by raw GeoNames dump row order, non-deterministic
under a dump refresh and responsible for shipped errors up to 158.8km) —
`feature_code`/`geonameid` in this file then reflect that locality row,
not the ADM3 one, even though the municipality's name/province/population
still come from ADM3. See `_pick_coordinate`'s docstring in
`scripts/build-es-gazetteer.py` for the full matching logic and the exact
measured offsets.

## What this file is NOT

It does not encode any connector's URL/query vocabulary (a Fotocasa city
slug, a Solvia province path segment, a Servihabitat sitemap slug). That
translation is deliberately per-connector — see each connector's own
`_CITY_SLUGS`/`_PROVINCE_SITEMAP_SLUGS`-equivalent table and
`docs/architecture/connectors.md`. This file only answers "what
municipality and province is this point in", never "what does site X call
it".
