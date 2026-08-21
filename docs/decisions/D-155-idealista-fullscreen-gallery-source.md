---
id: D-155
title: Idealista photos come from fullScreenGalleryPics, not the carousel preview
date: 2026-08-22
group: Data / connectors
rule: "Idealista photos come from `fullScreenGalleryPics` (array order, skip `isPlan`), not the 3-item `multimediaCarrousel` preview. Flag `photo_gallery_truncated` under declared total."
---

# D-155: Idealista photos come from `fullScreenGalleryPics`, not the carousel preview

*Decided: 2026-08-22*

**Context**: Every idealista listing in production stored exactly 3 photos
(3,263 listings, average 2.8, 100% at <= 3) while fotocasa averaged 27 —
issue #625, escalated by the owner. The first investigation concluded this
was a capture-side/site limitation: Idealista's `config.multimediaCarrousel`
object embeds only a fixed 3-item preview, so "the photos are simply not in
the HTML we get" and retrieving them would need a browser-extension change
to open the full-screen gallery before snapshotting the DOM (issue #654,
and D-145 as proposed on the still-open PR #655).

That conclusion was wrong, and it was wrong because it was reached without a
real detail-page sample — only a *search*-page capture was available at the
time, and the detail page has a different shape.

D-150's config-driven HTML retention made a real one available. Production
`extension_capture` id 3627 — an idealista detail page, 437,460 bytes of
retained HTML, captured through the ordinary extension flow with no gallery
interaction of any kind — contains **all 20 of the listing's multimedia
items** (18 photos + 2 floor plans) in a second inline object the connector
was not reading: `fullScreenGalleryPics`. The carousel's 3-item preview and
its sibling `totalMultimedias` (`[{"type":"PICTURE","total":18},...]`) sit in
the same page. Parsed before the fix: 3 photos. After: 18.

So this was a parser defect the whole time. No extension change, no
gallery-expanding click, and no extra page visit is needed.

**Decision**:

1. `etl/connectors/idealista.py` reads the complete gallery from the inline
   `fullScreenGalleryPics` array. `config.multimediaCarrousel`'s PICTURE
   group is the FALLBACK only — it is a 3-item preview on a real detail page
   and must never again be treated as the full set. og:image remains the
   last-resort fallback below both.
2. **Order is array order.** Do not sort on the entries' own
   `absolutePosition`: on the real capture that field is **not a position
   for 2 of the 20 entries** — the two most recently added items carry
   their own 10-digit `multimediaId` there, where a 1-18 index belongs. An
   ascending sort would have produced the same order on that particular
   sample, so this is not a claim that sorting visibly breaks it today; it
   is that the field does not mean what its name says, and any ordering
   derived from it rests on an assumption the page has already violated
   twice. Array order is the gallery order, and the first entry is the
   cover shot the candidate feed shows.
3. **Floor plans are excluded via the entry's `isPlan` flag**, not via a URL
   shape check — on the real capture the plans sit on the same
   `id.pro.es.image.master` bucket as the photos, so nothing in the URL
   distinguishes them.
4. **Store the `imageDataService` (.jpg) URL exactly as the page emits it.**
   That is the unsuffixed `WEB_DETAIL` rendition (1500px on the sample), not
   the carousel's `WEB_DETAIL-M-L` (600px, measured in #582). Never rewrite a
   URL into a size variant that has not been observed resolving; here no
   rewrite is needed because the page hands out the large one directly.
   Prefer the `.jpg` over its `imageDataServiceWebp` sibling — jpg is what
   every other connector stores and what the photo-hash fetcher is exercised
   on.
5. **Dedup photos on the rendition-independent
   `id.*.image.master/xx/xx/xx/NNNN` path, not the full URL.** The same photo
   appears in both objects at different renditions and extensions; a raw-URL
   key stores it twice. An unrecognised URL shape falls back to exact-URL
   dedup — never looser.
6. `fullScreenGalleryPics` is a **JS object literal, not JSON**: it mixes
   unquoted identifier keys among quoted ones. Quote the bare keys before
   `json.loads`, and do it string-aware so a caption or URL containing `:`
   or a brace is never rewritten. Do not regex the URLs straight out of the
   raw HTML — that loses the `isPlan` discrimination and the ordering.
7. **Never let the gallery parse fail silently.** Every failure mode of the
   full-gallery read returns an empty tuple and falls through to the
   carousel preview, which reproduces this exact bug and is
   indistinguishable from a genuine 3-photo advert. `normalize()` therefore
   compares the parsed count against the page's OWN declared photo total
   and records the result in `raw_extra` as
   `photo_gallery_declared_total` + `photo_gallery_truncated`, logging a
   warning when short. The expected count is parsed independently of the
   gallery, from **two** sources so a rename of either one alone leaves the
   check armed: `multimediaCarrousel.totalMultimedias`' PICTURE total and
   `len(picturesWithoutPlans)` (both 18 on capture 3627). `truncated` means
   *fewer than declared* — parsing MORE (the carousel fallback can
   contribute a photo the gallery array lacks) is not a truncation and must
   not be flagged as one. When the page declares no total at all, both keys
   are **omitted**, so "we checked and it is fine" is never confused with
   "we had nothing to check against".

**Alternatives rejected**:

- *Extension change to open the full-screen gallery before snapshotting*
  (issue #654's plan): unnecessary. The data is already in the snapshot the
  extension takes today. Adding a click-and-wait step would have added real
  risk — Idealista sits behind a CAPTCHA/bot wall that the batch flow is
  deliberately paced around (D-043) — to retrieve something already in hand.
- *Rewriting the carousel's `WEB_DETAIL-M-L` segment to `WEB_DETAIL`*
  (#582's proposed D-020-class fix): not needed on the primary path any more,
  since `fullScreenGalleryPics` emits `WEB_DETAIL` natively. #582's backfill
  of already-stored 600px URLs is still outstanding and unaffected.
- *Sorting by `absolutePosition`*: see decision 2 — it is not a position for
  every entry, even though on capture 3627 it happens to sort to the same
  order.
- *Dedup on `multimediaId`*: works for both objects today but breaks the
  moment a URL arrives without an id field alongside it. The URL-derived key
  needs nothing but the URL.
- *Flagging truncation from `multimediasTotalSlides`* (PR #655's approach,
  now closed): that field is on the **search** page. On capture 3627, a real
  detail page, `multimediasTotalSlides` occurs 0 times and `totalMultimedias`
  occurs once — so a flag read from it can never fire in production. #655's
  tests passed only because its hand-built fixtures used the search-page key.
  The useful half of that PR — the flag itself — is folded in here against
  the field the detail page actually carries.
- *Shipping the gallery fix with no completeness check at all* (this PR as
  first submitted): rejected in review. The original defect survived two
  investigations and needed a production data audit to find, precisely
  because it degraded quietly. Five realistic page changes were tried
  against capture 3627 — key renamed, trailing comma, one single-quoted
  value, `isPlan: undefined`, `imageDataService` renamed — and all five
  silently produced 3 photos again.

**Rationale**: The bug survived two investigations because both reasoned
about the detail page from a search-page sample. The general lesson is
already this project's rule (calibrate against a real capture, don't guess) —
what D-150's retention added was the ability to actually follow it. Recording
the specific shape here means the next agent reads `fullScreenGalleryPics`
instead of rediscovering that the carousel is a preview.

**Impact on dedup**: `match_ratio` is the fraction of the *smaller* photo
set, so a 3-photo idealista listing fully contained in a 30-photo fotocasa
listing scored a perfect 1.0 on 10% of the evidence, feeding D-137's
auto-merge rule. Idealista listings re-captured after this change carry full
sets, so that rule's *measured* false-positive rate on idealista-involving
pairs changes. Flagged for whoever owns D-137; not changed here.

**Backfill**: existing idealista listings keep their 3 photos until their
next capture. No SQL backfill is possible — the extra photos were never
stored, and the HTML they came from is retained only for captures taken
since D-150.

**Supersedes**: D-145 as proposed on PR #655 — never merged, withdrawn with
that PR. Its rule text said the truncation "is not a parser defect", which
capture 3627 disproves outright: the 18 photos were in the captured HTML the
whole time.

**See**: `etl/connectors/idealista.py` (`_photo_gallery`,
`_gallery_from_fullscreen`, `_js_object_literal_to_json`, `_photo_identity`,
`_declared_photo_total`),
`etl/tests/fixtures/idealista_sample_detail_full_gallery.html`,
`etl/tests/test_connector_idealista.py::TestFullScreenGallery` and
`::TestGalleryTruncationFlag`,
issues #625 / #654 / #582, closed PR #655, D-150 (capture HTML retention),
D-137 (photo-hash auto-merge), D-020 (Milanuncios CDN URL-variant rewrite).
