---
id: D-146
title: Hipoges connector selectors calibrated against one real capture — flip _SELECTORS_CALIBRATED True, single-observation confidence
date: 2026-08-21
group: Data / connectors
rule: 'Hipoges `_SELECTORS_CALIBRATED` is True: price/m2/rooms/bathrooms/reference/photos/property_type/operation/city/province are grounded in ONE real capture (RARE-04347, #547) — SINGLE-OBSERVATION confidence, re-verify against a second listing before trusting fully. Floor and energy_rating stay uncalibrated (ambiguous single-sample risk); OG meta was proven generic site branding, not per-listing content.'
---

# D-146: Hipoges connector selectors calibrated against one real capture

*Decided: 2026-08-21*

**Context**: D-111 shipped `etl/connectors/hipoges.py` with every DOM
selector an unvalidated draft, hard-gated by `_SELECTORS_CALIBRATED = False`
(Opus review, PR #548, C2) — no real Hipoges capture existed, so the site's
actual markup was unknown. `etl/capture.py` retained the raw HTML of any
`selectors_calibrated=False` capture specifically so a future real capture
could be pulled back out and used to build real fixtures (D-111, PR #548,
C3). Issue #547 is that follow-up: the owner captured `RARE-04347` four
times via the browser extension (2026-08-21), and `etl_capture` rows
3614-3617 held the retained HTML — pulled read-only from production
Postgres (`ps prod psql app`), never re-fetched live, per the read-only
policy this whole capture-only connector family exists to honor.

**What the real capture found — several of the draft's grounding
assumptions were wrong, not just unconfirmed:**

- **OpenGraph meta is generic site branding, not per-listing content.**
  `og:title`/`og:description` on the real detail page read "Venta y
  alquiler de inmuebles al mejor precio | Hipoges" / "Encuentra aquí las
  mejores oportunidades..." — the same text a home page would carry,
  confirmed independently by the DB's own `extension_capture.title` column
  (populated from that exact OG title, not "Piso en venta en urbanización
  Maria Teresa Leon"). The draft's "OG-meta-only, deliberately not an
  h1-guess" design (PR #548, C2) was the right call given no real page
  existed to check against, but the real page proves OG is useless for
  either field. Both are now DOM-first (a real `<h1>`, the real description
  paragraph) with OG meta only as a last-resort fallback.

- **No element on the real page carries a `price`/`precio` CSS class** —
  the draft's entire price selector (`[class*="price" i], [class*="precio"
  i]`) matched ZERO elements. The real price is a `<span>` with the exact
  text "Precio" followed by a sibling `<span>` holding the value — a
  label/value-sibling pattern.

- **m²/rooms/bathrooms are never a contiguous "84 m²" text run** — the
  draft's regex-over-flattened-body-text approach (`_M2_RE`/`_ROOMS_RE`/
  `_BATHS_RE`) could never have matched. The real markup renders the number
  and its unit label as separate sibling `<span>`s inside an
  `<init-feature-card>` custom element. Replaced with a structural reader
  that matches the card by label keyword and returns its first numeric
  span — not a fixed position, since the real page renders the (uncalibrated)
  energy-grade card's value/label spans in the OPPOSITE order between its
  mobile and desktop variants (both rendered at once by Angular SSR,
  CSS-hidden per breakpoint).

- **The real "similar properties" contamination is a custom element, not a
  CSS class.** The draft's `_CONTAMINATION_SELECTORS`
  (`[class*="similar" i]` etc., PR #548 C1) matched ZERO elements on the
  real page — the actual rail is `<init-asset-detail-related-assets
  id="others">`, containing `<init-similar-card>` elements each carrying a
  DIFFERENT property's own price/m²/rooms/baths/photo. Every calibrated
  extractor now scopes to the real per-section component tag
  (`init-asset-detail-main-info`/`-features`/`-description`/`-details`/
  `-gallery`) FIRST, which structurally excludes the related-assets sibling
  on its own; the corrected tag/id are kept in
  `_CONTAMINATION_SELECTORS` as a second layer of defense for the
  class-based fallback paths only.

- **City/province are extractable** — previously hardcoded `None` ("not
  extractable without a real capture"). The header renders one combined
  "<municipio>, <provincia>" string in a `<span>` right after a
  geolocation-pin `<img alt="Location icon">`. Added to the calibrated
  gate (was not previously part of it at all, since it was hardcoded
  outside the `if`/`else`).

- **Property type has an explicit structured source now**: the "Detalles
  del Inmueble" panel renders label/value pairs ("Tipo de propiedad" /
  "Piso") as two sibling `<span>`s — used as the primary source, with the
  title-keyword match kept as fallback.

**Deliberately left uncalibrated** despite being visible on the real page:

- **Energy rating** (a "G" letter grade in a 4th feature card): real
  Spanish REO portals sometimes show a placeholder instead of a real grade
  when no certificate exists (`altamira.py`'s "en trámite" case is the
  precedent for exactly this trap) — one sample can't distinguish "real G"
  from "no-cert placeholder rendered as G". Not wired into `normalize()`.
- **Floor** ("Planta: 2da Planta" in the same details panel): a free-text
  Spanish ordinal that would need guessed parsing to become a floor
  number — the "don't fabricate precision" trap
  (`docs/skills/connectors.md`) on a single sample. Not extracted.
- **Full street address**: still genuinely absent from the page — only
  city/province plus an urbanización/development name folded into the
  title text, no dedicated address field to read.

**URL shape**: the real captures independently reconfirmed the base case
D-111 already recorded from the site's public route table
(`/<lang>/detail/<id>`, no `:investment` segment, no `/contact-received` or
`/unavailable` suffix) — all 4 were `https://realestate.hipoges.com/es/
detail/RARE-04347`. The `:investment` segment and both suffixes remain
exactly as unconfirmed as before; this capture simply never exercised them.

**Decision**: `hipoges.py`'s `_SELECTORS_CALIBRATED` module constant flips
from `False` to `True`. `normalize()` now writes price, m2_built, rooms,
bathrooms, reference_code, photo_urls, property_type, operation, city, and
province from real, capture-grounded selectors; title/description are
DOM-first with OG-meta fallback (reversed from D-111's OG-only design).
`floor`, `energy_rating`, `address`, `lat`/`lon`, `postal_code`,
`m2_plot`, `features`, `cadastral_ref`, and `has_elevator`/`year_built`
remain `None` — either genuinely absent from the page or deliberately left
uncalibrated per the risk notes above.

**This is SINGLE-OBSERVATION confidence, not "validated" in the sense a
multi-sample connector earns.** One property (RARE-04347: a tenanted,
84m², 3-bed, 2-bath flat in Estepona, Málaga), one servicer template, one
listing state. A different property type (a plot, a garage, a building), a
rental listing, or a future Hipoges redesign could all break these
selectors silently — the `_SELECTORS_CALIBRATED` gate protects against
*never having checked*, not against *generalizing wrong from one sample*.
Re-verify against a second, structurally different capture before treating
this connector's output with the same confidence as a connector calibrated
against dozens of live samples (Fotocasa, Milanuncios).

**Fixture**: `etl/tests/fixtures/hipoges_detail_SYNTHETIC.html` (a fully
fabricated fixture, never matched real markup) is removed —
`etl/tests/fixtures/hipoges_detail_RARE-04347.html` replaces it, trimmed
from the real ~358-369 KB capture (`extension_capture` ids 3614-3617,
byte-identical modulo tracking/cookie noise) down to the load-bearing tag
names and class attributes every calibrated selector reads, with the
lead-gen contact form, the real Hipoges call-center phone number, and all
tracking/cookie markup scrubbed (no PII of any kind was present — Hipoges
is a REO servicer with no private-seller contact info — but the form/phone
carried no test value either, so they are simply not there).

**Alternatives rejected**:
- *Keep the gate `False` and just fix the draft selectors in place*:
  rejected — the whole point of #547 is that a corrected-but-still-
  unvalidated selector is exactly as untrustworthy as the original guess;
  flipping the gate is what actually lets the connector write data.
- *Treat this as multi-sample-validated since 4 captures exist*: rejected
  — all 4 are the SAME listing (RARE-04347), captured seconds/minutes
  apart. That proves the parser is deterministic across near-identical
  input, not that the selectors generalise across Hipoges' catalogue.

**See**: [D-111](D-111-hipoges-capture-only.md) (the capture-only decision
and calibration gate this amends), [issue #547](https://github.com/alvarolobato/inmo-tool/issues/547)
(this calibration task), [issue #207](https://github.com/alvarolobato/inmo-tool/issues/207)
(original Hipoges investigation), `etl/connectors/hipoges.py`,
`etl/connectors/hipoges_mapping.py`, `etl/tests/test_connector_hipoges.py`,
`etl/tests/fixtures/hipoges_detail_RARE-04347.html`.
