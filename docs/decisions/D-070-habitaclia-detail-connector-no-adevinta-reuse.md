---
id: D-070
title: habitaclia is a bespoke detail-fetch connector — no Adevinta/Fotocasa reuse
date: 2026-08-06
---

# D-070: habitaclia is a bespoke detail-fetch connector — no Adevinta/Fotocasa reuse

*Decided: 2026-08-06*

> Note: decision IDs D-060–D-068 were being claimed by parallel connector-batch
> agents when this was written; this file took the next free id it could see
> (D-070). Expect a renumber at review if it collides.

**Context**: Issue #79 asked to evaluate habitaclia.com (Spain's #4 portal)
as a connector, and specifically flagged that habitaclia is **Adevinta-owned
like Fotocasa**, so "its payload may resemble Fotocasa's — check for reuse".
The `property_web_scraper` reference mapping (`es_habitaclia.json`) maps
every field via `jsonLdPath` (schema.org JSON-LD). A fresh feasibility spike
(2026-08, honest UA) found:
- robots.txt (HTTP 200) allows the base search page (`viviendas-<slug>.htm`)
  and the detail page (`/comprar-...-i<id>.htm`); it disallows only
  query-string filters (`*pag=`, `*ordenar=`, …) and ajax endpoints.
- Both pages return clean HTTP 200 server-rendered HTML. The `captcha`
  strings are a Google reCAPTCHA-enterprise badge for the phone-reveal flow,
  NOT a wall gating page access.
- **The Adevinta-reuse hypothesis is FALSE.** habitaclia is a classic, older
  ASP.NET `.htm` stack with `*DTO` inline-JS config objects — NO
  Fotocasa-style `__initial_props__` blob, and no code path is shared.
- **The reference mapping's JSON-LD strategy is stale.** The live detail
  page carries NO JSON-LD at all. Fields are read from bespoke HTML; the
  coordinates live only in a StreetView config object as `VGPSLat`/`VGPSLon`.
- The search page has ids + a price/characteristics card but **no per-listing
  coordinates** — lat/lon (the platform-critical field) exists only on the
  detail page.

**Decision**: Ship `etl/connectors/habitaclia.py` (+ `habitaclia_mapping.py`)
as a **discover + fetch_detail** connector (NOT search-payload-only, unlike
pisos.com/D-069, because coordinates require the detail page): `discover()`
fetches one `viviendas-<slug>.htm` search page, extracts each
`/comprar-...-i<id>.htm` link, stashes the full detail URL keyed by id (the
id alone can't rebuild the slug-bearing URL — the "stash at discovery, read
per-listing" pattern from `unicaja.py`), and RAISES on zero links (guarded).
`fetch_detail()` fetches the stashed detail URL. `normalize()` reads the
subject `.price` **scoped away from the `.sim-price` similar-listings
carousel** (the contamination trap the connectors skill documents), the
"Distribución" `<article>` (rooms/baths/surface), the "Referencia del
anuncio" line, and `VGPSLat`/`VGPSLon` for coordinates; property type + city
come from the URL slug. `operation="sale"`, page-1 only so
`discovers_full_inventory = False`, `listing_kind = None` (no confirmed
signal). Born disabled (#100).

**Alternatives rejected**:
- *Reuse Fotocasa's `_extract_initial_props` / mapping*: impossible — there
  is no `__initial_props__` blob on habitaclia. The shared owner does not
  imply a shared stack.
- *Follow `es_habitaclia.json`'s `jsonLdPath` extraction*: rejected — the
  live page has no JSON-LD; the reference mapping is stale.
- *Search-payload-only (the pisos.com/D-069 shape)*: rejected — the search
  page has no coordinates, and this source's value is its geolocated
  listings, so a detail fetch is required.

**Rationale**: The spike confirmed a real, non-walled, buildable source; the
one field that matters most (lat/lon) forces a detail fetch, which the
connector does one listing at a time under its own rate limiter. Recording
the Adevinta-reuse and stale-JSON-LD findings prevents the next agent from
re-testing the same false hypotheses.

**See**: `etl/connectors/habitaclia.py`, `etl/connectors/habitaclia_mapping.py`,
`etl/tests/test_connector_habitaclia.py`,
`etl/tests/fixtures/habitaclia_sample_{search,detail}.html`, issue #79,
D-069 (pisos.com, the same batch), docs/skills/connectors.md,
docs/architecture/connectors.md.
