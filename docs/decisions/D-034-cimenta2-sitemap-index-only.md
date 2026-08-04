---
id: D-034
title: Cimenta2 ships as a sitemap-index-only connector — existence and reference code, never detail
date: 2026-08-04
---

# D-034: Cimenta2 ships as a sitemap-index-only connector — existence and reference code, never detail

*Decided: 2026-08-04*

**Context**: Issue #136. [D-033](D-033-cimenta2-not-viable-guest-api-overexposure.md)
established that Cimenta2's property *detail* is reachable only through a
misconfigured Salesforce guest endpoint that returns the asset object's
entire internal field set — the bank's acquisition cost and appraisal
value, live offer-negotiation state, and schema fields for an owner's tax
ID, telephone and IBAN. That verdict stands in full and is not reopened
here: **the endpoint must not be used, for any field, under any scoping.**
The defect is being disclosed to Cajamar.

D-033 also rejected a second, separate option — *"Building the connector on
the sitemap alone"* — as insufficient, reasoning that reference codes plus
geography slugs "cannot populate a `listing` row or feed #16's dedup
signals". This decision revisits **only that bullet**, because two of its
three premises turned out to be false when checked against the code rather
than reasoned about in the abstract, and because the owner subsequently
asked for the discovery half specifically.

**Decision**: Ship `etl/connectors/cimenta2.py` as a **sitemap-index /
discovery-only** connector. It reads the public, robots-allowed
`ga-activo` sitemap and nothing else. `fetch_detail()` performs **no
network request at all** — it returns what `discover()` already parsed out
of the URL slug. No future change may give this connector a detail-fetch
path; the sanctioned route to real detail is the browser-extension capture
path (issue #75).

It populates `external_id` (the 18-character Salesforce record id), `url`,
`reference_code` (#72), `operation='sale'`, `status='active'` and
`listing_kind='agency'`. Everything else — price, all surfaces, rooms,
photos, description, address, coordinates, property type, city, province,
postal code, cadastral reference — is **null**, because the only source for
each is the D-033 channel.

**Why D-033's "sitemap alone" bullet was revisited, point by point:**

- *"Cannot populate a `listing` row"* — false. `listing.current_price` is
  nullable (`etl/schema/init.sql`), and a real-Postgres round-trip test
  proves a price-less, coordinate-less Cimenta2 row persists through the
  actual schema.
- *"Cannot feed #16's dedup signals"* — false, though narrowly. The
  `reference_code` signal is reachable, and 3,915 of the 3,917 published
  codes clear its `_MIN_CODE_LENGTH`. It is genuinely capped at the
  uncorroborated tier — see below.
- *"Reference codes plus geography slugs"* — the geography half was
  correct, and is in fact worse than D-033 assumed. See the measurement
  below.

**What was measured, not assumed** (live, 2026-08-04, honest UA, no
evasion, all against public robots-allowed surfaces):

- The `ga-activo` sitemap publishes **3,917 assets**, shaped
  `/inmuebles/s/ga-activo/<18-char record id>/<reference code>`. All 3,917
  match that shape; 3,917 distinct record ids pair 1:1 with 3,917 distinct
  reference codes, zero duplicates on either side. The `-weekly` sitemap
  variant is **not** a delta — it returned a byte-identical 556,639-byte
  body with the same 3,917 URLs, which is what makes it a safe fallback
  rather than a quietly partial one.
- **Asset URLs carry no geography and no property type whatsoever.** The
  original plan for this connector was to mine `city`/`province`/
  `property_type` out of the sibling `inv-expediente` (490 URLs) and
  `ga-agrupacion` (551 URLs) sitemaps, whose slugs look like
  `chalet-antas-almeria`. Parsing all 490 expediente slugs against the
  repo's own gazetteer (`etl/connectors/geodata/es_places.csv`) resolved a
  province for only **307/490 (63%)** and a municipality for only
  **216/490 (44%)**. The residue is not a tuning problem: municipality and
  province run together with no separator in real slugs
  (`rusticaciezamurcia`, `nave-en-librillamurcia`,
  `sant-carles-de-la-rapitatarragona`); some expedientes span two provinces
  at once (`naves-huelva-y-madrid`, `rusticas-varios-castellon-y-valencia`),
  making any single extraction arbitrary rather than merely absent; and
  many are internal portfolio codes or bare marketing names with no
  geography at all (`pm-9757-202-pisos-y-garaj-rsd-fairways-atarfe`,
  `trafalgar`, `triton`, `troya`, plus the test records
  `expediente-prueba`, `prueba-proyecto-vivienda`).
- Decisively, **an expediente is a case file covering many assets**
  ("promocion finalizada 24 viviendas", "44 fincas", "202 pisos y garaj"),
  not a property. Ingesting one as a `property` row would assert that 202
  flats are a single dwelling. And **no public URL carries a key linking an
  expediente to the assets inside it** — that join exists only behind the
  D-033 endpoint. So the geography-bearing sitemaps cannot even *enrich*
  the 3,917 assets. They are not ingested at all.

**On price — the owner asked for it from any source other than the
endpoint. Both possibilities were checked:**

1. *Any public price surface?* **No, verified.** A public detail page was
   fetched over plain HTTP — the ordinary URL, not the Aura RPC, the same
   second-step check D-023 established for BuildingCenter. 65,096 bytes,
   `<title>Inmuebles</title>`, exactly two `<meta>` tags (CSP, viewport).
   Counted in the raw body: `og:price` 0, `product:price` 0,
   `application/ld+json` 0, `itemprop` 0, `schema.org` 0, `precio` 0,
   `EUR` 0, `€` 0 — and also the asset's own reference code 0, any
   municipality 0, `catastral` 0, `latitude`/`longitude` 0. Sitemap
   entries carry `<loc>` + `<lastmod>` only; `sitemap-view-1.xml` holds one
   URL (the site root); the WordPress RSS feed returns HTTP 200 with **zero
   `<item>` elements**. D-033 separately confirmed `?_escaped_fragment_=`
   returns a byte-identical shell.
2. *Cross-portal dedup inheritance.* **This is the answer.** A Cimenta2
   asset is often the same physical property a servicer or agent also lists
   on a portal already ingested here. When the dedup engine links the two
   `listing` rows onto one `property`, the price is already present —
   supplied by the other connector, from a source that publishes it. Hence
   the connector's obligation is to emit the strongest publicly derivable
   dedup key, which is `reference_code`, and it does.

   **Its honest ceiling**: `reference_code.evaluate` upgrades to
   `decision="merge"` only on coordinate/size/price proximity, and to its
   middle tier only on a shared `contact_raw`. This connector publishes
   none of those four fields by construction, so a Cimenta2 match always
   lands at `decision="suggest"`, confidence 0.500 — a pending row a human
   confirms, never an automatic merge. That is a safety property: a bare
   5-digit code is exactly the kind of value two unrelated portals could
   share by coincidence. Price inheritance is therefore human-in-the-loop.
   Whether Cajamar's codes actually recur on consumer portals is
   **unverified** — the connector is born disabled, so no row exists yet to
   cross-check — and is deliberately not claimed.

**`discovers_full_inventory = True`, justified rather than defaulted**:
`discover()` reads the complete asset sitemap in one request — no
pagination, no result cap, no relevance sort — so an asset that stops
appearing has genuinely been delisted. The Fotocasa failure mode (a
partial, relevance-sorted page-1 sweep that must set this `False` or
mass-false-positive withdrawals) does not apply, but its *consequence* is
taken seriously: `discover()` raises rather than returning an empty list
both when the response contains no `<loc>` entries at all (an error page or
interstitial) and when it contains many `<loc>` entries of which none match
the asset URL shape (a URL-scheme change). Those two guards are what make
the attribute safe, and both are fixture-tested.

**Alternatives rejected**:

- *Leaving Cimenta2 unbuilt, per D-033's original verdict.* Rejected by the
  owner's explicit request, and on the merits: a complete, current index of
  3,917 Cajamar-owned assets with stable per-asset reference codes and
  canonical URLs is exactly the worklist the #75 capture path needs, and is
  the only way "did Cajamar delist this asset" can be answered at all.
- *Ingesting expedientes/agrupaciones to obtain city/province/type.*
  Rejected on the 44%/63% measurement above, on the concatenation and
  multi-province cases that would produce silently *wrong* geography rather
  than missing geography, and most of all because those records are
  multi-asset case files, not properties. This is the "wrong guess
  presented as data" `docs/skills/connectors.md` warns against.
- *Requesting only the ~15 publicly displayed fields from the guest
  endpoint.* Rejected in D-033 and not reopened — the reason a guest can
  read the price field is the same misconfiguration that exposes the IBAN
  field.
- *A per-scope `scope_key()`.* Rejected: the asset URLs carry no geography
  and the sitemap accepts no query parameters, so there is nothing to
  resolve a point to and no way to filter server-side. Every resolvable
  scope collapses to one `"national"` key so that N active profiles cause
  one sitemap sweep per run rather than N identical ones.
- *Calling `throttle()` in `fetch_detail()`.* Rejected: it issues no
  request, and the orchestrator does not acquire the limiter around
  `fetch_detail` (the connector's own call is the pacing mechanism). Doing
  so would serialise 3,917 zero-request calls at 20/min, turning a
  two-request sweep into a ~3-hour run.

**Known limitation, stated so it is not mistaken for a bug**: with no
coordinates, these properties **cannot match any search profile**.
`dashboard/lib/filtering/scope-query.ts` opens every profile's geography
stage with `property.lat IS NOT NULL AND property.lon IS NOT NULL AND
<haversine> <= radius`. Cimenta2 rows will not appear in candidates, the
map, or scoring until detail arrives from the #75 capture path or from a
dedup-linked twin. The connector is born disabled (#100) regardless.

**See**: [issue #136](https://github.com/alvarolobato/inmo-tool/issues/136),
[D-033](D-033-cimenta2-not-viable-guest-api-overexposure.md) (the spike this
builds on; its endpoint verdict is unchanged),
[D-023](D-023-buildingcenter-national-sweep-connector.md) (the
check-the-real-host second step, reapplied here to the detail page),
[issue #72](https://github.com/alvarolobato/inmo-tool/issues/72)
(reference code), [issue #75](https://github.com/alvarolobato/inmo-tool/issues/75)
(browser-extension capture path), [issue #76](https://github.com/alvarolobato/inmo-tool/issues/76)
(superset schema fields), [issue #100](https://github.com/alvarolobato/inmo-tool/issues/100)
(born disabled), `etl/connectors/cimenta2.py`,
`etl/tests/test_connector_cimenta2.py`.
