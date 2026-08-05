---
id: D-068
title: Escogecasa (Abanca REO) map-search connector on escogecasa.es
date: 2026-08-06
---

# D-068: Escogecasa (Abanca REO) map-search connector on escogecasa.es

*Decided: 2026-08-06*

**Context**: Issue #135 (part of the #132 bank/REO batch) asked for a
connector against Abanca's own REO portal, and explicitly told the spike to
**confirm the canonical domain**. Live feasibility spike (2026-08-05, honest
identifying User-Agent, requests spaced apart, none assumed):

- **Domain**: the issue named `escogecasa.com`, but that host no longer
  resolves — authoritative DNS **SERVFAIL** from Google `8.8.8.8` AND
  Cloudflare `1.1.1.1` (a decommissioned domain, not a local glitch). The
  live canonical domain is **`escogecasa.es`** (Apache/Debian, HTTP 200, no
  WAF, no CAPTCHA — reCAPTCHA appears only on contact/save-search forms).
- **robots.txt** (`escogecasa.es/robots.txt`, 200) is permissive:
  `User-agent: * / Allow: /`, disallowing only `/nogooglebot/` and
  `/print_inmueble/`. Every listing/detail path a connector needs is allowed.
- **Data channel**: a legacy server-rendered Java app (JSESSIONID,
  ISO-8859-1) whose map search results are injected into an iframe target.
  The results loader `POST /buscador/cargar_resultados.jsp` (map form:
  `lat`/`lng`/`zoom` + bbox `lat_min`/`lat_max`/`lng_min`/`lng_max`,
  `tgs=1`=VIVIENDAS, `srtp=1`, `pag`) returns JavaScript calling
  `parent.createMarker(id, lat, lon, 'subtipo - precio', '<card html>',
  estado)` once per result — a rich discovery payload carrying **real
  lat/lon**, subtipo, built surface, price, detail URL and a photo per
  listing. The detail page is server-rendered; every SUBJECT field sits in a
  `dato_`-prefixed element (`dato_precio`, `dato_habs`, `dato_banos`,
  `dato_sup_util`, `dato_sup_cons`, `dato_referencia`, `dato_cp` = postal
  code, `dato_direccion`, `dato_anyocons` = year built, energy-cert title,
  `li_ascensor`, `capa_descripcion`).

**Decision**: **Connector built** — `etl/connectors/escogecasa.py` +
`escogecasa_mapping.py`, born disabled (#100).

- `discover(scope)` translates the scope's `center`+`radius_km` into a
  bounding box (`bbox_from_center`) and POSTs the results loader, parsing
  every `createMarker(...)`. The `scope.geography` free-text escape hatch is
  parsed as a `"lat,lon[,radius_km]"` triple (this connector is
  coordinate-native).
- **`discovers_full_inventory = False`**: a single bbox is capped at ~100
  markers and `pag` does not extend past it (live-verified — an all-Spain
  bbox returned 103 markers on page 0 and 0 on pages 1–3). A partial,
  zoom-capped sweep must never drive withdrawal detection (the Fotocasa
  lesson). `discover()` raises rather than returns `[]` when the first page
  doesn't look like the loader (broken action / markup change), but treats a
  legitimately empty box (rural scope, no Abanca stock) as `[]`.
- `discovered_prices()` is wired up (the createMarker label carries each
  listing's price — a free, verified discovery-time signal).
- `fetch_detail`/`normalize` read the SUBJECT via the `dato_`-prefixed
  classes, which is itself the subject scope: the "inmuebles similares"
  carousel uses the *un-prefixed* classes (`habs`/`bans`/`superficie`/
  `precio`/`referencia`), so reading only `dato_*` sidesteps the
  carousel-contamination trap Diglo/Servihabitat/Vivantial each hit. Photos
  are filtered to the subject's internal id in the CDN path.
- **Coordinates come only from the search createMarker payload** (the detail
  page has none) — stashed at `discover()` and merged in `normalize()`.
  Escogecasa is the batch's **third** REO connector to publish lat/lon (after
  Diglo D-061 and Unicaja D-064), enabling issue #16's address_coords dedup.
- `rate_limit_per_minute = 12`, `listing_kind = "agency"` (Abanca-owned
  stock, never a private seller — load-bearing for #16's phone rule),
  `operation = "sale"`. Publishes postal code and year built (richer than
  Diglo/Unicaja). No referencia catastral (asserted None in tests).

**Alternatives rejected**:
- *Driving the SEO results URL `/comprar/viviendas/<term>/<lat>/<lng>/`
  directly.* It renders an empty JS shell; the cards are injected by the
  iframe loader only after a bbox POST — so the loader is the real channel.
- *`discovers_full_inventory = True` by tiling many small bboxes to beat the
  ~100 cap.* Not done: the scope model is one center+radius box per sweep;
  claiming full inventory off a capped box would mass-false-positive
  withdrawals. False is the honest value.

**Rationale**: Genuinely additive inventory — Abanca's own ex-Novagalicia
stock, concentrated in Galicia and the northern coast, geographically
complementary to the Madrid/Levante-weighted fleet, and NOT consolidated onto
any existing connector's source (unlike Kutxabank→Servihabitat, D-069). Rich
per-listing data (coords + price at discovery, postal code + year built at
detail) on a permissive, server-rendered, un-walled site.

**See**: `etl/connectors/escogecasa.py`, `etl/connectors/escogecasa_mapping.py`,
`etl/tests/test_connector_escogecasa.py`, issue #135, D-061 (Diglo), D-064
(Unicaja), D-069 (Kutxabank overlap).
