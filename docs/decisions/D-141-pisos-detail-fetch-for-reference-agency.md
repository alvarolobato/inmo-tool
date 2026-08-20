---
id: D-141
title: pisos.com adds one detail fetch per listing, for reference/agency only
date: 2026-08-20
group: Data / connectors
rule: 'PisosConnector fetch_detail() makes ONE real request per listing (revising D-071''s "no detail fetch") to recover reference_code/contact_raw from the detail page''s `features__feature`("Referencia:")/`owner-info__name` blocks — confirmed live 2026-08-20 absent from the search card/JSON-LD (0/30). A failed detail request degrades to search-card fields only, never fails the listing. Safe today: born disabled (D-071).'
---

# D-141: pisos.com adds one detail fetch per listing, for reference/agency only

*Decided: 2026-08-20*

> ## REVISES (2026-08-20) — see [D-071](D-071-pisos-search-payload-connector.md)

**Context**: Issue #628, raised from a real pair the owner flagged as
obviously the same property (fotocasa vs. pisos, matching price/m²/rooms/
city) that the dedup queue was asking him to judge by eye instead of
matching automatically — because `reference_code`/`contact_raw` were
captured on the fotocasa side only. Coverage query against the corpus
confirmed pisos at 0/315 for both fields, and cross-checking the pending
dedup queue found pisos the SINGLE LARGEST contributor to the 241 pending
pairs carrying a reference on only one side (136 of 241 — see D-140 for
the full measurement).

D-071 explicitly designed `PisosConnector` as search-payload-primary with
**no detail fetch at all**, on the grounds (verified at the time) that the
detail page carries "NO JSON-LD... strictly poorer than the search card,"
and its own "Alternatives rejected" section dismissed a per-listing detail
fetch as "unnecessary and worse... for zero field gain." That reasoning
no longer holds for two specific fields.

A fresh live spike (2026-08-20, honest UA, respecting `robots.txt` — the
same host D-071 already verified allows both `/venta/...` and
`/comprar/...`) fetched a real pisos.com search page (30 cards) and
confirmed, as before, that NEITHER the card markup NOR its per-card
JSON-LD carries a reference code or agency name anywhere (0/30). The
listing's own DETAIL page, however, does carry both:

- `div.features__feature` containing `span.features__label` text
  "Referencia:" with the code in a sibling `span.features__value`
  (real value observed, not committed to any fixture — see AGENTS.md's
  no-scraped-content rule; only the markup SHAPE is documented, in
  `pisos_mapping.py`'s docstrings and a fully synthetic test fixture).
- `p.owner-info__name` (inside `.owner-info__header`) with the agency's
  display name, linking to its own `/inmobiliaria-<slug>/` profile page.

So the field IS published — just not where D-071 looked.

**Decision**: `PisosConnector.fetch_detail()` now makes ONE real HTTP
request per listing (`throttle()`-paced, same as every other detail-
fetching connector) to the detail URL discover() already resolved, purely
to extract `reference_code`/`contact_raw` via two new pure functions in
`pisos_mapping.py` (`extract_reference_code`/`extract_agency_name`).
Every other canonical field (price, rooms, baths, m², floor, coordinates,
photos, city/province) is UNCHANGED — still read from the search card and
its JSON-LD, with zero extra requests. A failed detail request (timeout,
5xx, connection error) logs a warning and degrades to search-card fields
only, `reference_code`/`contact_raw` left `None` — it never fails the
whole listing, since these two fields are an enrichment on an otherwise-
complete record, not load-bearing for it. A 404/410 on the detail URL
still raises `ListingUnavailableError` (the listing was withdrawn between
discovery and fetch), consistent with every other connector's D-049
handling.

**Why this is safe despite reversing D-071's stated tradeoff**: the
connector is still **born disabled** (`connector_config.enabled = false`,
unchanged) — this doubles pisos's real request volume (one search + one
detail per listing, vs. one search request total) only once an operator
opts it in, at which point they are accepting exactly this cost knowingly.
Nothing runs unattended today.

**Alternatives rejected**:
- *Leave pisos's reference/agency permanently unmapped* — rejected: this
  is the single largest contributor (136/241) to the corpus's one-sided-
  reference gap (D-140), and the owner's own flagged example is a
  pisos-side listing.
- *A lighter partial fetch (HEAD request, or range-request the page head)*
  — considered and rejected: the reference/agency blocks are deep enough
  in the page (past the photo carousel and most feature rows) that a
  partial fetch offers no meaningful savings over a normal GET, and adds
  complexity (partial-HTML parsing) for no real benefit.
- *Guess the reference from the card's numeric id* — already rejected by
  D-071 itself (the id is pisos.com's own ad id, not a seller reference)
  and still correct; not revisited here.

**Rationale**: two real, previously-unmapped fields directly unblock the
majority of a real, owner-flagged dedup gap, at a bounded, opt-in-only
cost (one extra request per listing, only once an operator enables the
connector) — consistent with `docs/skills/connectors.md`'s "prefer
embedded JSON, but don't leave a real field unmapped when the honest
answer is one more request."

**See**: `etl/connectors/pisos.py`, `etl/connectors/pisos_mapping.py`,
`etl/tests/test_connector_pisos.py`,
`etl/tests/fixtures/pisos_sample_detail.html` (synthetic),
`etl/tests/fixtures/pisos_sample_detail_no_reference.html` (synthetic),
issues #628/#629, [D-071](D-071-pisos-search-payload-connector.md)
(revised), [D-140](D-140-reference-code-relaxed-normalizer.md) (the
matching/veto-side fix this lands alongside).
