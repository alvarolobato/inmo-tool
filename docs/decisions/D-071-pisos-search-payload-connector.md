---
id: D-071
title: pisos.com is a search-payload-primary connector (no detail fetch)
date: 2026-08-06
group: Data / connectors
rule: 'pisos.com IS buildable: `PisosConnector` is search-payload-primary (no detail fetch) — each `.ad-preview` search card carries price+rooms+baths+m²+floor+type-via-URL and a per-card JSON-LD block with lat/lon+locality. `operation="sale"`, guarded discover() raises on 0 cards, page-1-only (`discovers_full_inventory=False`), born disabled. Reject `es_pisos.json` (0.45, no coords) as a source of truth.'
order: 27
---

# D-071: pisos.com is a search-payload-primary connector (no detail fetch)

*Decided: 2026-08-06*

> Note: originally drafted as D-069, but D-068/D-069/D-070 were concurrently
> claimed by parallel connector-batch PRs (#344/#343/#345); renumbered to D-071
> at review to resolve the collision.

**Context**: Issue #79 (a scope expansion beyond the original Fotocasa/
Milanuncios target set) asked to evaluate pisos.com (Vocento) as a new
connector, spike-first. The `property_web_scraper` reference mapping
(`es_pisos.json`) was documented as thin (extraction rate 0.45, empty
`reference`/`images`, no embedded-JSON strategy) and explicitly not to be
trusted as a shortcut. A fresh feasibility spike (2026-08, honest UA) found:
robots.txt (HTTP 200) allows the `/venta/...` search and `/comprar/...`
detail paths; the search page returns a clean HTTP 200 (~280 KB, no
DataDome/PerimeterX/Cloudflare/CAPTCHA) and — crucially — is far richer than
`es_pisos.json` implied. Each `<div class="ad-preview" id="{id}">` search
card carries a raw numeric price (`contact-box[data-ad-price]`), rooms/baths/
m²/floor (`.ad-preview__char`), title/subtitle/description, the detail URL
(`data-lnk-href`, whose first token IS the property type), and photos; plus
one per-card `<script type="application/ld+json">` block (keyed by the same
`@id`) with `geo.latitude`/`geo.longitude` and locality/region. All fields
the platform needs — price, m², type, rooms, **lat/lon**, url, address —
come from the search page. The DETAIL page, by contrast, carries NO JSON-LD
and is bespoke, strictly poorer for this purpose (live-checked).

**Decision**: Ship `etl/connectors/pisos.py` (+ `pisos_mapping.py`) as a
**search-payload-primary** connector, the same shape as
`FotocasaRentalConnector` (D-066): `discover()` fetches ONE search page,
parses every card + its JSON-LD into a stashed record, and returns the ids;
`fetch_detail()` returns the stashed record with **no network request**;
`normalize()` maps it to canonical with `operation="sale"` and lat/lon from
the JSON-LD. `discover()` RAISES on zero parsed cards (guarded — a markup
change or block page must not read as mass withdrawal). Page-1 only, so
`discovers_full_inventory = False`. Property type is mapped from the URL
slug token (`piso`/`duplex`/`casa_adosada`/…); `listing_kind` is left `None`
(no live-confirmed particular/agency signal — the card's logo presence was
not verified against a labelled example). Born disabled via the generic
`connector_config.enabled = false` seed (#100).

**Alternatives rejected**:
- *Trust `es_pisos.json` as-is*: rejected per the issue — it has no
  coordinates, no reference, no images, extraction rate 0.45, and its CSS
  selectors are stale/unverified. A fresh spike found a much richer real
  payload it never described.
- *discover() + per-listing detail fetch (the Fotocasa sale shape)*:
  unnecessary and worse — the detail page is poorer (no JSON-LD, no
  coordinates in a cleaner form) and a per-listing crawl adds an anti-bot
  surface for zero field gain.
- *Guess `listing_kind` from the card logo*: rejected per the "don't
  fabricate precision" rule — plausible but unverified; kept as a
  `has_agency_logo` flag in `raw_extra` for a future verified pass.

**Rationale**: One request per scope per run is the minimal, best-neighbour
footprint, and it still yields the full canonical field set including the
platform-critical lat/lon. Mirroring the already-reviewed D-066 shape keeps
the connector small and legible.

**See**: `etl/connectors/pisos.py`, `etl/connectors/pisos_mapping.py`,
`etl/tests/test_connector_pisos.py`, `etl/tests/fixtures/pisos_sample_search.html`,
issue #79, D-066 (the search-payload template), docs/skills/connectors.md,
docs/architecture/connectors.md.
