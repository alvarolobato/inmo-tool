---
id: D-159
title: Idealista's "anuncio retirado" notice is withdrawal evidence; any other non-advert page is refused, never persisted
date: 2026-08-22
group: Data / connectors
rule: 'Idealista normalize() raises ListingUnavailableError on the positively-identified retired notice (→ withdrawn + evidence), and ConnectorError when a page has zero substantive fields. Never persist a listing from a non-advert page.'
---

# D-159: Idealista's "anuncio retirado" notice is withdrawal evidence; any other non-advert page is refused, never persisted

*Decided: 2026-08-22*

**Context**: D-157 established that a listing's status changes only on evidence
of absence, and named Idealista as the worst case: 3.289 active listings, 862
unseen for more than 7 days, **zero ever withdrawn**, and no evidence channel
at all — it is capture-only behind a WAF, and D-081/D-026/D-027 forbid
background fetching it to find out.

The channel was there the whole time. While draining the re-capture queue the
owner keeps landing on pages that say *"lo sentimos, este anuncio ya no está
publicado"*. That is the portal positively asserting absence, obtained with
zero automated requests, because a human was going to open the page anyway.

Measuring what the pipeline did with those pages turned up something worse than
a missed opportunity. `IdealistaConnector.normalize()` never raised: every
field is optional and degrades to `None`, so the notice page parsed
"successfully" into an empty listing and `etl/capture.py` persisted it as
`status='done'`. Production, 2026-08-22 (issue #690):

| signal | real adverts | non-advert pages |
|--------|-------------:|-----------------:|
| `fields_extracted` (7d) | 9–15, 1.509 rows | **exactly 3, 23 rows** — nothing in between |
| listings with zero photos | 23 / 3.263 (0,7 %) | **26 / 26 (100 %)** |

All three surviving fields are structural, not extracted: `url` is handed in,
`operation` is hardcoded `'sale'`, and `property_type` is **fabricated** as
`'piso'` by `map_property_type()` reading the word "Pisos" out of Idealista's
*site-wide* `<title>` ("Viviendas venta. Viviendas alquiler. Pisos. Chalets —
idealista"), which all 26 rows carry in `raw_extra.title`.

Three separate corruptions came out of that:

1. **8 real listings had their stored photo gallery erased.**
   `_update_existing_listing` COALESCEs every scalar — so price, description
   and area survived — but assigns `photo_urls = %s` unconditionally, so an
   empty parse wipes it. These 8 were captured properly on 18 Aug (real
   prices, 449–2.475-char descriptions) and re-captured on 22 Aug.
2. **18 phantom listings were created from nothing**, `status='active'`, no
   price, no description, no photos, `property_type` invented — and counted in
   the 3.289 active total.
3. **`last_seen_at` was pushed to `NOW()`** by the very capture that proved
   the listing was gone, making a dead listing look freshly confirmed alive and
   defeating every staleness nomination downstream — the exact inversion of
   D-157.

None of it was visible: all 214 captures in the preceding 6 hours were `done`,
zero `failed`.

**Decision**: two independent checks in `IdealistaConnector.normalize()`, run
before any field is trusted, with deliberately different outcomes.

1. **The retired notice → `ListingUnavailableError`.**
   `retired_page_signature()` matches the portal's own notice *sentence*
   (`(este|el)? (anuncio|inmueble) … ya no está (publicado|disponible|activo)`)
   against the page's **visible text** — `<script>`/`<style>` stripped, accents
   folded, whitespace collapsed — and returns a Spanish citation quoting what
   was seen. `etl/capture.py` catches it (before the generic `ConnectorError`
   branch; ordering is load-bearing, it is a subclass) and marks the listing
   `withdrawn` with that citation in `listing_status_event.evidence`.

   The match is guarded by requiring the page to carry **none** of the
   advert's own markup (`.main-info__title-main`, `.info-data-price`,
   `.adCommentsLanguage`, `.details-property_features`). That guard is not
   evidence and can never withdraw anything by itself; it exists only to close
   the single false-positive route the sentence leaves open — a **live** advert
   whose seller-written description quotes the phrase ("si ve que este anuncio
   ya no está publicado, llámenos").

2. **Any other page with zero substantive fields → plain `ConnectorError`.**
   If the page yields no price, title, description, address, reference, area,
   room count, coordinates, photos or features block, and is not the recognised
   notice, `normalize()` refuses to return anything. The capture is recorded
   `failed` and **nothing about any listing changes**.

Withdrawal marks and never deletes (D-157): the listing row, its
`listing_price_history`, its feedback and its dedup identity all survive.
`last_seen_at`/`last_fetched_at` are deliberately **not** touched — they mean
"last confirmed present", which is the opposite of what was observed. A notice
page for a URL with no stored listing creates nothing. The capture is recorded
under a new `extension_capture.status = 'withdrawn'`, and the worklist row is
retired to `stale` (see below).

**Alternatives rejected**:

- *Detect withdrawal from "0 photos and no declared photo total".* This was the
  lead that found the bug, and it correlates perfectly in the data (26/26). It
  is still the wrong detector: it is absence-shaped, and absence is equally
  what a soft block (D-047), a CAPTCHA wall, a rate-throttle and a
  half-rendered capture look like. Adopting it would let a throttle wall
  withdraw live inventory — precisely the failure that made
  `milanuncios.py` carry *no* signature at all, deliberately. The correlation
  is used only to *characterise* the page shape here, never to decide.
- *Make the refusal guard raise `ListingUnavailableError` too.* It would
  withdraw far more listings, and every one of them on no evidence. "I cannot
  tell what this page is" is not "the listing is gone" (D-157).
- *Let the notice page keep reaching `_upsert_canonical_listing` and just fix
  the `photo_urls` overwrite.* Fixes one of the three corruptions, leaves the
  phantoms and the `last_seen_at` inversion, and still discards the evidence.
- *Reuse `status='failed'` or `'done'` for the capture row.* `failed` is a lie
  (nothing failed — the capture worked and returned the most valuable answer a
  capture-only portal can give), would inflate `failed_7d` on the data-health
  page, and would drive `_correlate_worklist` to mark the worklist row
  `failed`. `done` is also a lie (nothing was ingested) and would drag the
  per-portal field-completeness average down with a page that has no fields.
- *Leave the `capture_worklist` row `pending`.* `pending` means "still to
  visit". Re-serving a URL the portal has told us is dead spends the owner's
  attention — the scarcest resource in a capture-only pipeline — on a page that
  can never produce data. The row is retired to `stale`, which this table
  already defines as "vanished from the portal" (issue #273) and which is
  excluded from the "Abrir siguiente pendiente" pool. Only a still-`pending`
  row is touched: a `skipped` row is the **owner's** decision about his own
  queue and no automated inference may overrule it, a `captured` row holds a
  real `matched_capture_id`, and an already-`stale` row makes this idempotent.

**Rationale**: this is the first evidence channel Idealista has ever had, and
it costs nothing — no request, no WAF exposure, no change to the owner's
behaviour. The two-outcome split is what makes it safe to turn on: the only
path that can withdraw a listing requires the portal to have said so in words,
and every page we cannot read positively resolves to *no write at all* rather
than to a guess. The refusal guard is the more urgent half in practice — it
stops an active corruption — and it is unconditionally safe, because refusing
to persist a page we do not understand can only ever lose an ingestion we
should not have trusted.

The threshold for that guard ("not one substantive field") was chosen against
the measured distribution above: real adverts extract 9–15 fields and
non-adverts extract exactly 3, all structural, so zero substantive fields
separates the two populations with the whole nine-field gap to spare.

**Not covered here**: the 26 already-corrupted production rows are left alone.
Retro-classifying them would mean inferring *withdrawal* from the generic-title
signature, which proves only "the last capture was not an advert" — it cannot
distinguish a retired notice from a soft block, and doing it anyway would be
the same absence-shaped reasoning this decision rejects. They self-correct the
next time each URL is captured. Whether to repair them another way is the
owner's call (issue #690).

**See**: issue #690;
[D-157](D-157-evidence-not-time-for-withdrawal.md) — time nominates, evidence
decides, and "mark, don't delete";
[D-049](D-049-listing-gone-clean-skip.md) — `ListingUnavailableError` as the
"source says it's gone" signal;
[D-047](D-047-soft-block-clean-outcome.md) — why an unparseable 200 is a soft
block and never "gone";
[D-081](D-081-bankinter-cloudflare-block.md) — the standing WAF rule that
routes blocked portals to browser capture instead of crawling, alongside
[D-026](D-026-sareb-not-viable-incapsula-block.md) and
[D-027](D-027-altamira-not-viable-akamai-block.md);
issue #645 (captured-portal withdrawal at large — this delivers its Phase 2
task 2 for Idealista); issue #685 (the `retired_page_signature` /
`ListingUnavailableError` / `listing_status_event.evidence` machinery reused
here); `etl/connectors/idealista.py`, `etl/capture.py`,
`etl/tests/test_capture.py`, `etl/tests/test_connector_idealista.py`.
