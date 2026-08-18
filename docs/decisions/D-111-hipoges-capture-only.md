---
id: D-111
title: Hipoges ingests via guided browser-extension capture, selectors an unvalidated draft pending the owner's first real capture
date: 2026-08-18
group: Data / connectors
rule: 'Hipoges ingests via a capture-only connector (`etl/connectors/hipoges.py`) mirroring idealista/aliseda/altamira; detail-URL shape is grounded in the site''s public Angular route table, but every DOM selector is an UNVALIDATED DRAFT hard-gated by `_SELECTORS_CALIBRATED` (False) — `normalize()` writes only external_id/url/status/listing_kind/OG title+description until the owner''s first real capture flips it.'
---

# D-111: Hipoges ingests via guided browser-extension capture, selectors an unvalidated draft

*Decided: 2026-08-18*

**Context**: D-075 established that Hipoges (`realestate.hipoges.com`) is not
respectfully crawlable — every sanctioned enumeration channel (the sitemaps
its own `robots.txt` advertises, the same-host GET asset API) returns an
app-level 403 "No tiene permisos suficientes" to an honest client, and the
only responsive channel is an internal `POST /api/assets/map` DTO this
project will not fuzz (D-033's Cimenta2 stop condition). D-075 named
capture-only (issue #75) as the route but did not write the connector; this
decision is that connector being built, not a reversal of D-075.

**Re-verified live 2026-08-18**, 12 days after D-075's original spike, plain
GET with an honest identifying User-Agent, no spoofing, no probing beyond
public pages:

- `GET /robots.txt` -> HTTP 200, permissive (`User-agent: * / Allow: /`),
  advertises `Sitemap: /sitemap.xml`.
- `GET /sitemap.xml` -> HTTP 200, a sitemap INDEX listing
  `page_es_sitemap.xml` / `activo_es_sitemap.xml` (+ pt/gr/it siblings).
- `GET /page_es_sitemap.xml` -> **HTTP 403** "No tiene permisos suficientes
  para acceder a esta ruta".
- `GET /activo_es_sitemap.xml` -> **HTTP 403**, identical message.
- `GET /` -> HTTP 200, but a bare Angular SPA shell with no server-rendered
  listing content (meta/OpenGraph tags and hreflang alternates only) — the
  same shape as Idealista/Aliseda's `www` hosts.

The wall is unchanged. No `POST /api/assets/map` probing, DTO
reverse-engineering, or User-Agent spoofing was attempted, per D-075/D-033.

**Decision**:

1. **`etl/connectors/hipoges.py` mirrors idealista.py/aliseda.py/altamira.py
   exactly.** `scope_key()` always returns `None` (the orchestrator's
   profile-driven sweep never calls it); `discover()`/`fetch_detail()` raise
   `ConnectorError` as a defensive invariant; `normalize()` is the real entry
   point, called by `etl/capture.py` on a `RawListing` built from HTML a
   human's own browser rendered and the extension POSTed to
   `/api/extension/capture`. Registered in `etl/connectors/__init__.py` and
   `etl/capture.py`'s `_CAPTURE_CONNECTORS` (host `realestate.hipoges.com`)
   / `EXTENSION_CAPTURE_PORTALS`; mirrored in the dashboard's
   `lib/worklist.ts` `CAPTURE_PORTALS` and the extension's
   `manifest.json`/`detect.js`/`observe-search-url.js`/`capture-search-url.js`
   (manifest bumped 0.14.3 → 0.14.4 for the new `host_permissions` entry,
   same convention as D-037/#510). `listing_kind="agency"` — Hipoges is a
   multi-fund REO servicer, same as every other batch connector in this
   family.

2. **The detail-URL shape is GROUNDED, not guessed — a first for this
   capture-only family.** Unlike Aliseda/Altamira, whose detail-URL shape
   started as a pure guess (D-019/D-027), Hipoges' `main-*.js` and its lazy
   `chunk-*.js` siblings are the client-side Angular bundle the site ships to
   every visitor's browser — a public static asset, the same thing "view
   source" gets you, not an API call. Its literal `path:` route table
   (read from that public bundle) gives: a detail page is
   `/<lang>/detail/<id>` or `/<lang>/<investment>/detail/<id>`, optionally
   suffixed `/contact-received` or `/unavailable` on the same id; a
   search/listing page is `/<lang>/(sale|rent)/<typology>/<country>/<town>`
   or the `area`/`countries`/`map`/`point` variants. `etl/listing_detect.py`
   and `browser-extension/detect.js` (+ its dashboard mirror
   `lib/observed-search-url.ts`) both encode this shape, pinned by the same
   shared-fixture-table discipline D-079 established. The `:investment`
   segment and the exact `sale`/`rent` URL tokens (inferred from the site's
   own public `assets/i18n/es.json` key names, not observed on a live URL)
   remain unconfirmed — the passive search-URL observer
   (`observe-search-url.js`) is deliberately PERMISSIVE for Hipoges (any
   non-detail, non-home path), same posture as Altamira's #510 corpus-building
   approach, since the search grammar itself is not yet confirmed.

3. **Every DOM/CSS selector below the URL layer is an UNVALIDATED DRAFT.**
   No real Hipoges capture exists: the detail page is Angular-rendered, a
   plain GET returns the empty shell above, and the browser extension could
   not capture this host until this connector existed to receive it — a
   genuine chicken-and-egg problem, same shape as Aliseda's original state
   before issue #266's real captures. `hipoges.py`'s `normalize()` uses
   OpenGraph meta tags for title/description (grounded only in the
   observation that the home page carries rich OG tags, not confirmed for a
   detail page), a best-effort `[class*="price"]`/`[class*="precio"]`
   selector guess for price, and text-mining regexes for surface/rooms/baths
   guarded by a best-effort "similar properties" contamination-drop (the
   exact neighbour-bleed bug class `etl/connectors/extraction.py`'s
   `scoped_text` docstring documents from Vivantial/Solvia/Servihabitat). A
   selector miss degrades to `None`, never a fabricated value.

   **Hardened after the #548 review (C2):** labeling was not enough — an
   uncalibrated `[class*="price"]` guess landing "top of the feed" as a
   fabricated below-market bargain (via D-057's boost, D-098's price-history
   adoption, or a silent D-059 mis-filter) is a real, invisible-without-SQL
   failure mode, not a hypothetical one. `hipoges.py`'s
   `_SELECTORS_CALIBRATED` module constant (`False`) now HARD-GATES every
   draft-derived field: while it is `False`, `normalize()` returns `None`/`()`
   for price/m²/rooms/bathrooms/reference_code/photo_urls/property_type/
   operation regardless of what the draft selectors find — only
   `external_id`/`url`/`status`/`listing_kind` and the OpenGraph
   `title`/`description` are ever written. `raw_extra.selectors_calibrated`
   reads that same constant, so it is a live reflection of what actually
   happened, not a separate claim that could drift from the code. The draft
   extractor functions themselves stay fully implemented and unit-tested
   (`TestDraftExtractors`/`TestCalibratedWiring` in
   `test_connector_hipoges.py`) so flipping the one constant, once #547's
   real capture lands, is genuinely a one-line change. `etl/capture.py`
   additionally retains the captured `html` on the `extension_capture` row
   (instead of the normal null-on-`'done'` behavior) for exactly as long as
   `selectors_calibrated` reads `False`, so #547's own plan — pull the real
   HTML back out of the database to build real fixtures — is actually
   possible; without this, `normalize()` never raising meant every capture
   reached `'done'` with its HTML already discarded.

   Tests (`etl/tests/test_connector_hipoges.py`) run against a SYNTHETIC,
   explicitly-labeled-fabricated fixture
   (`etl/tests/fixtures/hipoges_detail_SYNTHETIC.html`) — they prove the
   parser logic behaves as intended, nothing about whether the selectors
   match the real site.

4. **Calibration is a tracked follow-up, not silently deferred.** [Issue
   #547](https://github.com/alvarolobato/inmo-tool/issues/547) is filed: load
   the unpacked extension, open one or two real Hipoges detail pages, capture
   them, preserve the captures as real fixtures (replacing the synthetic
   one), and correct every DRAFT selector against them — the same path
   issue #266 walked for Aliseda.

**Alternatives rejected**:
- *Reverse-engineering `POST /api/assets/map` to get real listing HTML/JSON
  without a human capture*: rejected — exactly the probing D-075/D-033
  refused; unchanged here.
- *Waiting for a real capture before writing any connector code*: rejected —
  the extension can't capture a host it doesn't support, so the connector
  must exist first; the Aliseda precedent (D-037) already established that
  shipping honestly-labeled draft selectors and gating trust on a follow-up
  capture is the right sequencing, not a shortcut.
- *Guessing DOM selectors with the same confidence as the (mostly guessed)
  Aliseda/Altamira launch selectors*: rejected — those were later shown
  wrong or incomplete against real captures (#266/#271) even with more
  grounding than this connector has; marking Hipoges even more conservatively
  (explicit `selectors_calibrated` flag, synthetic-not-trimmed fixture) keeps
  that honesty visible in both code and data.

**Rationale**: This is the minimal honest realisation of "capture-only is the
route" (D-075): a working ingestion path for Hipoges the moment the owner
captures a real page, with every unverified assumption clearly labeled so
nobody — human or agent — later mistakes a guess for ground truth. The
URL-shape grounding (reading the site's own public route table instead of
guessing) is a genuine improvement over the Aliseda/Altamira precedent this
connector otherwise mirrors, and is called out specifically so it is not
conflated with the DOM-selector guesses that remain exactly as uncertain as
those connectors' launch state was.

**See**: [issue #207](https://github.com/alvarolobato/inmo-tool/issues/207)
(original Hipoges investigation), [issue #547](https://github.com/alvarolobato/inmo-tool/issues/547)
(calibration follow-up), [D-075](D-075-hipoges-walled-enumeration-capture-only.md)
(the walled-enumeration finding this builds on), [D-037](D-037-aliseda-guided-capture.md)
(the capture-only + draft-selector precedent this mirrors),
[D-027](D-027-altamira-not-viable-akamai-block.md) (the WAF-block ->
capture-path precedent), [D-033](D-033-cimenta2-not-viable-guest-api-overexposure.md)
(the stop-probing condition), [D-079](D-079-runresults-classification-and-scope.md)
(the shared-fixture discipline `listing_detect.py`/`detect.js` follow),
`etl/connectors/hipoges.py`, `etl/connectors/hipoges_mapping.py`,
`etl/tests/test_connector_hipoges.py`, `etl/tests/fixtures/hipoges_detail_SYNTHETIC.html`.
