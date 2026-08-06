---
id: D-061
title: Diglo (Banco Santander REO) connector — buscador-driven, publishes coordinates
date: 2026-08-05
group: Data / connectors
rule: 'Diglo (Santander REO, #117) connector targets `digloservicer.com` (NOT `diglo.com` — a hearing-aids retailer); discovers via the paginated province BUSCADOR (`/venta-pisos/<province>?page=N`), NOT sitemap.xml (found stale — #378); `discovers_full_inventory=True` with an unrecognised-page-0 guard; fetch_detail treats a 302-to-root as withdrawn; `rate=12`, `listing_kind=agency`. First batch REO connector to publish lat/lon; no cadastral/postal.'
order: 15
---

# D-061: Diglo (Banco Santander REO) connector — buscador-driven, publishes coordinates

*Decided: 2026-08-05 · Discovery route corrected 2026-08-06 (issue #378)*

## Correction (2026-08-06, issue #378): sitemap → province buscador

The original decision below made Diglo **sitemap-driven** on the belief that
`sitemap.xml` was the site's complete, single-request enumeration. A
connector-health analysis then found Diglo ingesting **0 priced / all grade F**
on live data, and a re-verification (honest UA, 2026-08-06) showed why: **the
sitemap is badly STALE.** 5 of 6 randomly-sampled residential detail URLs from
it **302-redirect to the homepage** (withdrawn listings); the live
homepage/buscador links ~915 currently-active listings whose reference codes
**are not in the sitemap at all**. So the sweep returned mostly dead URLs, and
`fetch_detail` silently followed each 302 to the homepage and parsed *that*
(whose `utag_data` is the empty placeholder) — a priceless, fieldless "active"
listing.

**Corrected decision**: discovery now paginates the **province buscador**
(`/venta-pisos/<province>?page=N`, `?page`-paginated to exhaustion), which is
server-rendered and returns the province's whole active stock across every
property type — every card links a LIVE (HTTP 200) detail URL. `fetch_detail`
additionally guards the residual case: a request that ends up redirected to the
site root is a listing withdrawn between discovery and fetch, raised as
`ListingUnavailableError` (a clean skip), never parsed as a homepage. The
`discovers_full_inventory=True` guard changes from "empty/unrecognised sitemap"
to "page 0 that doesn't look like a results page". The parsing decision below
(utag_data / drupalSettings / .product-print-sheet, carousel isolation) was
verified still correct against a fresh live page and is unchanged — except
`m2_built` now reads BOTH the print-sheet and the description (a description-only
"239,00 metros cuadrados" page previously dropped it). Everything below this
section is the original 2026-08-05 record, kept for archaeology.

---

*Decided: 2026-08-05*

**Context**: Issue #117 (part of the #132 bank/fund REO batch) asked for a
connector against Banco Santander's own REO portal, named as
`digloservicer.com`. A live feasibility spike on 2026-08-05 (identifying
User-Agent, slow spaced requests) found:

- **Domain**: `digloservicer.com` resolves, HTTP 200, no WAF challenge. Its
  `RealEstateAgent` JSON-LD self-describes as "el nuevo portal inmobiliario
  del Grupo Banco Santander". A name-collision trap: `www.diglo.com` is a
  DIFFERENT entity — a US hearing-aids retailer (an `Allow: /` sitemap of
  `/hearing-test` / `/shop-by-brand` pages). The connector must point at
  `digloservicer.com`, never `diglo.com`.
- **robots.txt**: a stock Drupal file — only `/core/`, `/profiles/`,
  `/README.txt` disallowed; every listing path allowed; advertises
  `Sitemap: https://digloservicer.com/sitemap.xml`. No Incapsula/Akamai wall
  (unlike Sareb #121 / Altamira #122).
- **Discovery shape**: the province search pages render only ~6 cards
  server-side (the rest via Drupal Views AJAX), but the national
  `sitemap.xml` is a single document (2,743 `<loc>`, ~987 property detail
  URLs) with each property's type/province/municipality/reference-code in
  the URL slug (`/venta-pisos/madrid/madrid/efe0000200053`). Sitemap-driven
  discovery is both the sanctioned and the far cleaner route.
- **Subject data**: three embedded server-rendered sources — the page's own
  `window.utag_data` analytics blob (the SECOND, populated one; the first is
  an empty `{}` placeholder) for price/city/province/type/reference/date;
  `drupalSettings` JSON (`yera_producto_lat`/`yera_producto_lon`) for real
  coordinates; and the `.product-print-sheet` block + description paragraph
  for the built/useful surface split and room/bath counts.
- **Carousel trap**: the page's `.listing-info` cards are the "inmuebles
  similares" carousel and carry NEIGHBOURS' price/m²/rooms — the same
  contamination Servihabitat/Vivantial/Solvia each hit. utag_data and the
  `.product-print-sheet` scope avoid it; photos are scoped by the subject
  refcode in the Google-Storage CDN path.

**Decision**: Ship `etl/connectors/diglo.py` + `diglo_mapping.py` as a
sitemap-driven connector against `digloservicer.com`, scoped per-province by
filtering the national sitemap (province is the third-from-last URL segment,
ASCII-folded to match the gazetteer's `Place.province`). `discovers_full_
inventory = True` (single-request complete national enumeration, permissive
robots, cross-checkable per-province counts — the BuildingCenter #118 /
Cimenta2 #136 shape), guarded by `discover()` RAISING rather than returning
`[]` on an empty or unrecognised sitemap so a fetch glitch can't read as a
mass withdrawal. `rate_limit_per_minute = 12` (conservative, low-traffic
servicer). Residential filter to `pisos` + `casas`. `listing_kind = "agency"`
(Santander servicer, never a private seller). Born disabled (#100).

**Diglo is the first REO connector in this batch to publish lat/lon** —
Servihabitat, Solvia and Vivantial all lack coordinates, so issue #16's
`address_coords` dedup signal can finally fire for a servicer source.

**Fields confirmed absent** (asserted None in tests so a future site change
surfaces): `referencia catastral` (unlike Solvia), property postal code (the
only 5-digit code on the page is Santander's HQ), IBI/community-fee costs.

**Alternatives rejected**:
- *`diglo.com`* — wrong entity (hearing-aids retailer). Would have ingested
  garbage.
- *Province search-page scraping* — only ~6 server-rendered cards per page;
  the rest need Drupal Views AJAX. The sitemap gives the whole catalogue in
  one request.
- *Reading the property from JSON-LD* — the page's JSON-LD is corporate only
  (its address is Santander's HQ). The subject data lives in `utag_data`.

**Rationale**: Sitemap + embedded-JSON is the most stable extraction path
(survives markup changes), matches the batch's cleanest connectors, and
respects a permissive-but-explicit robots posture with conservative pacing.

**See**: `etl/connectors/diglo.py`, `etl/connectors/diglo_mapping.py`,
`etl/tests/test_connector_diglo.py`, issue #117, tracking issue #132,
D-023 (BuildingCenter national-sweep), Servihabitat #115 (sitemap template).
