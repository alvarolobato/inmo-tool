---
id: D-145
title: Idealista photo-gallery truncation is site-side, not a parser bug — detect and flag it
date: 2026-08-21
group: Data / connectors
rule: "Idealista's captured detail-page `multimediaCarrousel.multimedias` is a site-truncated preview, not a parser defect (issue #625). `normalize()` reads the sibling `multimediasTotalSlides` count and flags `raw_extra.photo_gallery_truncated`/`photo_gallery_total_available` when it exceeds what's embedded, instead of silently treating a partial gallery as complete. Getting the rest of the gallery needs a future browser-side capture change — not attempted here (no real detail-page HTML to verify a selector against)."
---

# D-145: Idealista photo-gallery truncation is site-side, not a parser bug — detect and flag it

*Decided: 2026-08-21*

**Context**: Issue #625 (and the owner directly: "los anuncios de idealista
solo cargan 3 fotos, eso es un fallo, arréglalo") — 100% of 3,263 production
idealista listings have <=3 photos (avg 2.8), against fotocasa's 27 on the
same corpus at the same measurement.

The task was to determine whether this is (A) a parsing/filtering defect —
the captured HTML carries 20+ photos and `_gallery_from_carousel` drops
them — or (B) a capture-side/site-behaviour limit — the captured HTML itself
only ever carries ~3.

`etl/capture.py` nulls out `extension_capture.html` once a calibrated
connector's capture reaches `status='done'` (idealista is calibrated), so no
production detail-page HTML survives for a `done` capture. Three `failed`
idealista rows do retain HTML (production `extension_capture` id 10, 121,
160) — all three are SEARCH-page captures (the pre-#292 "no capture-capable
connector recognizes this URL" era), not detail pages. `extension_capture`
id 10 is the exact same row this connector's fixture/comments already cite
as the source of the `multimediaCarrousel` JSON schema — but it was cited as
if it proved the DETAIL page's structure, when it's actually a SEARCH page.

Parsing that real id-10 HTML: `listingMultimediaCarrousels` (the search
page's plural, per-listing map) holds, for every one of its 30 listings, a
`multimedias[type=PICTURE].content` array capped at exactly 3 items — and a
sibling field, `multimediasTotalSlides: [{"type":"PICTURE","totalSlides":
13}, ...]`, reports the real count (13 in the sample checked). The existing
connector code and its test fixture read `multimedias` only; they never
looked at `multimediasTotalSlides` at all, and the fixture's "10 PICTUREs"
sample embellished the real per-listing preview size (3) into a number that
happened to make the existing test pass without ever exercising this gap.

A single, honest, rate-limited, non-evading GET to a real idealista detail
page (`https://www.idealista.com/inmueble/112340146/`, a real production
listing URL, default curl UA, robots.txt-allowed path) was attempted to
settle whether the DETAIL page's own (singular) `multimediaCarrousel`
object has the same 3-item cap or genuinely embeds the full gallery. It
returned an immediate `403` from DataDome (`server: DataDome`,
`x-datadome: protected`) — consistent with the module's existing "hard
CAPTCHA/bot-detection wall on every direct request" documentation. No
further attempt was made (no anti-bot evasion, no header spoofing, per
issue #1 §15).

**Decision**: Given (a) the parser is proven correct when given a complete
JSON object (the pre-existing 10-photo fixture test already demonstrates
`_gallery_from_carousel` returns everything present, not a fixed cap), (b)
real production evidence proves Idealista's own carousel data model embeds
only a 3-item PICTURE preview with the true count carried separately, and
(c) 100% of live listings landing at exactly <=3 is the signature of a fixed
site-side preview window, not organic variance — this is judged Cause B
(capture-side/site limitation), not Cause A (parser drops items). Direct
confirmation on the DETAIL page's own object specifically is blocked by
DataDome and not obtainable respectfully.

`_gallery_from_carousel` now returns `(photo_urls, total_available)`,
reading the PICTURE entry of `multimediasTotalSlides` alongside
`multimedias`. `normalize()` sets `raw_extra["photo_gallery_truncated"] =
True` and `raw_extra["photo_gallery_total_available"] = N` whenever
`total_available > len(photo_urls)`; the key is absent when the gallery is
known-complete or completeness is unknown (no `totalSlides` field at all —
older markup, or a soft-blocked page). `photo_urls` itself is unchanged —
it still only ever reports what's genuinely embedded in the capture, never
fabricated.

This does **not** retrieve more photos. Getting the rest requires a
browser-side capture change (triggering Idealista's full-gallery view in
the owner's own authenticated browser session before the extension
snapshots `outerHTML` — not a new HTTP request WE make, so robots.txt's
`Disallow: /*multimediaNumber=2` through `20` doesn't apply the way it
would to an automated crawler). That change needs real detail-page DOM to
calibrate a selector against, which isn't available (DataDome blocks a
direct fetch, and the extension purges HTML for calibrated connectors).
Filed as issue #654 for the owner to seed with one real capture, following
the same "selectors unvalidated until a real capture confirms them" pattern
as D-111 (Hipoges).

**cimenta2** (0.0 avg photos, 100% of 3,917 listings): NOT the same cause.
`etl/connectors/cimenta2.py::normalize()` hard-codes `photo_urls=()`
unconditionally — a deliberate design decision (D-033/D-034/D-035): this
connector's only data path is a narrowly whitelisted, injected detail
endpoint that was scoped down specifically to avoid the PII/confidential
overexposure that made the guest API D-033 rejected in the first place, and
photo_urls was never in that whitelist. Nothing to fix; left as-is.

**servihabitat** (avg 1.0, 191 listings): NOT the same cause either.
`_photo_urls()` reads `json_ld["image"]` with an `og:image` fallback — a
different extraction mechanism entirely (no embedded carousel object, no
truncation field). Servihabitat's live crawl is not blocked (confirmed
`200` responses using the connector's own existing identifying UA,
`inmo-tool/0.1 (personal real-estate research tool; ...)`, one request each,
several seconds apart — the connector's own documented spike methodology).
Two independent real listing pages were fetched and both show the site's
own `product-carousel-main-view`/`main-carousel` DOM block containing
exactly ONE distinct `<img>` — the JSON-LD extraction matches what the site
itself renders. Most plausible explanation: these REO/distressed listings
genuinely carry minimal photography on the source site. Left as-is; not
enough signal to justify a fix, and the two samples checked show the
current extraction is already correct against the real DOM.

**Dedup implication (flagged, not acted on)**: `match_ratio` is computed
over the SMALLER photo set, so `ratio == 1.0` means subset containment. A
3-photo idealista listing whose 3 photos all appear in a 30-photo fotocasa
listing scores a perfect 1.0 on 10% of the evidence — this feeds D-137's
auto-merge rule directly. Once real detail-page galleries grow (post the
follow-up browser-side fix), the *measured* behaviour of that auto-merge
rule changes — whoever owns D-137 should re-measure rather than discover it
later. D-137 itself is NOT modified here.

**Backfill**: Not possible. The truncation flag requires
`multimediasTotalSlides`, which was never captured or stored for any
existing listing (HTML is purged post-parse for a calibrated connector, and
the flag itself didn't exist before this change) — there is no historical
data to recompute it from. Existing idealista listings pick up the flag
(and, once the browser-side fix lands, more photos) only on their next
capture. No SQL backfill is possible or proposed.

**Alternatives rejected**:
- *Retry the direct fetch with a "more browser-like" header set* — rejected
  as anti-bot evasion, explicitly out of scope (issue #1 §15).
- *Speculatively add a DOM-click-to-expand-gallery step to the browser
  extension* — rejected: no real detail-page DOM exists to verify a
  selector against, and this codebase's own review history (four reviews
  this week per the task brief) treats an unverified selector wired into a
  production capture path as a decorative fix, not a real one. Filed as a
  follow-up requiring the owner's own capture instead (mirrors D-111).
- *Treat 100%-at-<=3 as organic and leave it alone* — rejected: fotocasa
  on the identical corpus averages 27; the uniformity (100% capped, not
  "usually low") is inconsistent with organic variance.

**Rationale**: Ship the honest, verifiable half now (detect and surface
truncation from data already present in every capture, tested both red and
green against a fixture built from a real production capture's schema) and
be explicit that the photo-count half of the fix needs a real sample this
agent cannot obtain respectfully — rather than guessing a browser-side
selector that would look fixed in a PR diff and do nothing in production.

**See**: issue #625, issue #654 (follow-up, browser-side capture), D-033,
D-034, D-035 (cimenta2), D-111 (Hipoges — same "selectors unvalidated
until a real capture" pattern), D-137 (auto-merge rule this affects the
measured behaviour of, not modified here), `etl/connectors/idealista.py`
(`_gallery_from_carousel`, `IdealistaConnector.normalize`),
`etl/tests/test_connector_idealista.py`.
