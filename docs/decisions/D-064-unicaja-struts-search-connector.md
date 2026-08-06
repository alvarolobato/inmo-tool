---
id: D-064
title: Unicaja Inmuebles connector — Struts search pagination + card/detail merge
date: 2026-08-05
group: Data / connectors
rule: 'Unicaja Inmuebles (GIA REO, #119) connector targets `unicajainmuebles.com`; no sitemap — paginate `listadoPromocion.do` (`tipoInmueble=0` VIVIENDA, `tipoOperacion=1` COMPRA, `provincia=<INE code>`) to the last page. Rich search cards carry the postal code; stash them in `discover()` and merge with the detail page (coords/baths/photos). `discovers_full_inventory=True`, `rate=12`, `listing_kind=agency`. Publishes lat/lon; no cadastral/energy.'
order: 16
---

# D-064: Unicaja Inmuebles connector — Struts search pagination + card/detail merge

*Decided: 2026-08-05*

**Context**: Issue #119 (part of the #132 bank/REO connector batch) asked for a
connector against Unicaja Banco's own REO portal, operated by its servicer
Gestión de Inmuebles Adquiridos, S.L. (GIA). Live feasibility spike
(2026-08-05, identifying User-Agent, slow requests):

- `unicajainmuebles.com` resolves (www → apex 301), HTTP 200, **no** WAF /
  CAPTCHA / JS-only wall (unlike Sareb D-026 / Altamira D-027 / Caja Rural
  Central's Radware wall).
- robots.txt is a Cloudflare "content-signals" file with **no**
  `User-agent`/`Disallow`/`Sitemap` directives at all — nothing disallowed,
  and **no sitemap** (`/sitemap.xml` 404s). So the Diglo/Servihabitat
  sitemap-sweep shape does not apply.
- It is a server-rendered Java/**Struts** app (`*.do` actions), not a JSON/SPA
  site — no `__NEXT_DATA__`/`utag_data` blob. Data lives in the rendered HTML.
- **Search** (`listadoPromocion.do`, the pagination form's own action) renders
  up to 10 richly-structured result **cards** per page (`label.titulo` /
  `label.valor` pairs) carrying provincia, municipio, **código postal**, tipo,
  superficie construida, habitaciones, reference code and a description.
  Pagination is next-only (no total count in markup).
- **Detail** (`fichainmueble.do?referencia=<ref>`) adds coordinates
  (server-injected `var coordX`/`var coordY` JS — coordX=lat, coordY=lon),
  bathrooms, useful surface, the full street title and the photo gallery. The
  "Viviendas cercanas" carousel is AJAX-loaded (`listaInmueblesCercanosAJAX.do`)
  so it is **absent** from the static HTML — no carousel-contamination trap.
- The **postal code is on the search card, not the detail page** (verified on
  3 real listings). No `referencia catastral`, no energy-rating letter (the
  certificate is a pop-up image, frequently "Incidencia").

**Decision**: Build `etl/connectors/unicaja.py` + `unicaja_mapping.py`.

- `discover(scope)` resolves the scope to a numeric **INE province code**
  (via `province_to_ine_code`, a table folding gazetteer names *and* the
  site's own labels *and* bilingual aliases — "Bizkaia"/"VIZCAYA",
  "Coruna"/"A CORUÑA", "Illes Balears"/"BALEARES" all resolve), then paginates
  `listadoPromocion.do` with `tipoInmueble=0` (VIVIENDA = residential) +
  `tipoOperacion=1` (COMPRA = sale) until a page yields no new reference or a
  short (<10) page. External_id is the bare reference code.
- Each discovered card is **stashed on `self._cards`** (rebuilt each
  `discover()`), the same "stash at discovery, read per-listing" pattern the
  base class endorses for `discovered_prices()`. `fetch_detail` reads it to
  recover the **postal code** the detail page omits (plus province/city/
  description fallbacks); `normalize` merges card + detail, preferring the
  detail page for price/coords/baths/useful-surface/photos.
- `discovers_full_inventory = True` (a full province pagination genuinely
  enumerates every active residential sale listing), guarded by `discover()`
  **raising** on a first page that doesn't look like a results page — but
  returning `[]` for a legitimately empty province (a results-page container
  with no cards). `rate_limit_per_minute = 12`. `listing_kind = "agency"`
  (institutional, load-bearing for #16's phone-corroboration rule).
- Second REO connector in the batch (after Diglo D-061) to publish real
  lat/lon → #16's `address_coords` dedup signal fires for it. `cadastral_ref`
  and `energy_rating` left `None`, asserted in tests so a site change surfaces.
- Born disabled via `sync_connector_registry` (#100); registered in
  `register_all()`.

**Alternatives rejected**:
- *Detail-page-only (Diglo shape), postal_code = None.* Rejected: the site
  publishes the postal code on the card and #119/#76 explicitly want it — the
  card-stash merge costs one small coupling for a real dedup-relevant field.
- *Override `discovered_prices()` from the card price.* Rejected: the card
  price renders inconsistently (some cards show only "Compra*" with no
  figure), so it is not a reliable discovery-time signal — the base class
  says only override this once the field is verified present and reliable.
  Price comes from the detail page, which always carries it.
- *Filter residential in-memory only, or trust the server category alone.*
  Kept both: search with `tipoInmueble=0` (server-side residential) AND a
  belt-and-braces per-card `is_residential` guard, so a garage/solar can
  never enter a residential-investment sweep even if the category widens.

**Rationale**: Matches the batch's crawl-respect discipline (permissive
robots, identifying UA, conservative rate, honest full-inventory guards) and
the connector contract, while extracting the fullest honest field set the
site offers — including coordinates and postal code that most batch portals
don't publish together.

**See**: `etl/connectors/unicaja.py`, `etl/connectors/unicaja_mapping.py`,
`etl/tests/test_connector_unicaja.py`, issue #119, tracking issue #132,
[D-061](D-061-diglo-santander-sitemap-connector.md) (Diglo, the sibling
lat/lon-publishing REO connector), `docs/skills/connectors.md`.
