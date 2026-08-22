---
id: D-159
title: Idealista's "anuncio retirado" notice is withdrawal evidence; any other non-advert page is refused, never persisted
date: 2026-08-22
group: Data / connectors
rule: 'Withdraw on an Idealista retired notice only if its reference equals the captured external_id and its stated size/rooms fit the stored row; date from it, not before last_seen_at.'
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
field is optional and degrades to `None`, so a page that is not an advert —
the notice among them — parsed "successfully" into an empty listing and
`etl/capture.py` persisted it as `status='done'`. Production, 2026-08-22
(issue #690):

| signal | real adverts | non-advert pages |
|--------|-------------:|-----------------:|
| `fields_extracted` (7d) | 9–15, 1.509 rows | **exactly 3** — nothing in between |
| listings with zero photos | 23 / 3.263 (0,7 %) | **100 %** |

**The size of the affected cohort, as of 2026-08-22 08:28 UTC: 40 rows** — 18
phantoms and 22 real adverts whose gallery was erased; all 40 still `active`,
all 40 with zero photos. Query it as
`extension_capture WHERE connector_name='idealista' AND fields_extracted=3 AND
status='done'`. **The number is a moving target and every figure here is
stamped for that reason**: it grows each time the #683 drain lands on another
of these pages, and earlier drafts of this record and of the #690/#691 PR
bodies quote 26 (18 + 8) from the first measurement earlier the same day,
and PR #692's own decision record quotes 33 from a measurement between the
two. All three are the same population at three moments, not a
disagreement. It stops growing when these PRs land.

All three surviving fields are structural, not extracted: `url` is handed in,
`operation` is hardcoded `'sale'`, and `property_type` is **fabricated** as
`'piso'` by `map_property_type()` reading the word "Pisos" out of Idealista's
*site-wide* `<title>` ("Viviendas venta. Viviendas alquiler. Pisos. Chalets —
idealista"), which every one of those rows carries in `raw_extra.title`.

**Those rows are "non-advert pages", and it is not determinable which kind.**
An earlier draft of this record called them withdrawal notices; they are not
known to be. All 15 rows examined have a byte-identical stored footprint —
`fields_extracted = 3`, zero photos, that same site-wide `<title>` — and one of
them is a confirmed withdrawal while others may equally be anti-bot challenge
pages, login interstitials or half-rendered captures. **Nothing retained in the
database can separate the two**: the HTML is discarded once a capture is
processed, and every distinguishing mark lived in it. The measurement is
therefore evidence that these pages are not adverts, which is all the refusal
guard below needs; it is not evidence that they were retired notices, and the
retro-classification question at the end of this record turns on exactly that
gap.

Three separate corruptions came out of that:

1. **Real listings had their stored photo gallery erased** (22 of the 40).
   `_update_existing_listing` COALESCEs every scalar — so price, description
   and area survived — but assigns `photo_urls = %s` unconditionally, so an
   empty parse wipes it. The first 8 identified were captured properly on
   18 Aug (real prices, 449–2.475-char descriptions) and re-captured on
   22 Aug.
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

   The match is guarded by requiring the page to carry **none** of the
   advert's own markup — see above — and, since the owner read a real notice
   page by hand (2026-08-22), by **corroboration against the listing being
   captured**. The sentence alone was weaker evidence than it looked: a notice
   page is generic chrome, near enough the same shell for every dead advert, so
   "this page says an advert is gone" is not "this page says *your* advert is
   gone". A real notice does carry the difference, printed in plain text:

   ```
   Lo sentimos, este anuncio ya no está publicado
   Piso en venta en <calle>, <barrio>, <ciudad>
   123.000 € 80 m² 3 hab.

   Referencia del anuncio: 900000001

   El anunciante lo dio de baja el 03/08/2026
   ```

   **All of the following must hold before a listing is withdrawn**, and any
   one of them failing produces the *same* outcome the refusal guard below
   produces — `ConnectorError`, capture recorded `failed`, not one row touched:

   | check | on failure |
   |-------|------------|
   | the notice sentence is in the page's visible text | not a notice at all; falls through to the ordinary parse |
   | the page carries none of the advert's own markup | a live advert quoting the phrase; not retired |
   | **«Referencia del anuncio» is present** | no withdrawal — an uncorroborated notice is only "some advert is gone" |
   | **that reference equals the captured `external_id`** | no withdrawal — the page and the URL disagree about which listing this is |
   | **any m²/room count the notice states agrees with the stored listing** (m²: the wider of ±1 m² and dedup's own 5% band; rooms exact) | no withdrawal — the notice describes a different property |

   **The m² tolerance is the wider of 1 m² and 5%**, and the second half is
   not slack — it is a correctness requirement. `property.m2_built` is a
   PROPERTY-level, dedup-shared field, so it is not necessarily Idealista's
   own figure at all: dedup merges on `sizes_close`, a 5% band
   (`etl/dedup/signals/address_coords.py`), reserving exact equality for the
   photo-hash auto-merge path (D-137). A legitimately merged property can
   therefore sit several m² from what Idealista printed, and the original
   flat ±1 m² rule would have **silently vetoed genuine withdrawals
   precisely on merged properties** (Opus review, #691). Matching dedup's own
   band means the veto tolerates exactly the disagreement dedup itself was
   willing to merge across, and no more. The 1 m² floor still covers the
   rounding case it was written for — the notice prints "80 m²", the row
   holds NUMERIC(8,2) 79,60 — on flats too small for 5% to reach a metre.

   Two deliberate asymmetries in that table. **Absence is never a mismatch**:
   a notice that prints no size, or a listing stored without one, yields no
   disagreement and the reference match stands alone — treating a reworded
   notice as a contradiction would quietly disable the only evidence channel
   this portal has. And **price is never corroborated**: cutting the asking
   price, failing to sell, and pulling the advert is close to the typical story
   of a dead listing, so a price that moved says nothing about whether the
   notice is about our advert, and vetoing on it would reject exactly the
   withdrawals most worth recording.

   **The transition is dated from the notice, not from the capture.**
   `listing_status_event.observed_at` is stamped with the date the notice says
   the advertiser took the advert down. In the page the owner read, the advert
   had already been down for twelve days when the page was captured: twelve
   days that `NOW()` would have invented, and that every "how long do adverts
   survive?" question downstream would then get wrong. A missing date falls back to the capture
   time, and so does an *implausible* one — a date that cannot exist (31/02), a
   future one (a page cannot report a withdrawal that has not happened; that is
   a misparse or an `MM/DD` locale), or one older than ten years. A wrong date
   in `observed_at` is worse than no date, because afterwards it is
   indistinguishable from a real one; every rejection is recorded in the
   evidence so the fallback is auditable rather than invisible.

   **A fourth rejection: a date earlier than our own `last_seen_at`.** The
   three above are judged by the connector, which can only ask "is this date
   possible?". Believability is also relative to what *we* observed, and that
   check needs the database, so it lives in `etl/capture.py`
   (`_clamped_delisting_date`). A notice dated before the day we last
   confirmed the advert alive asserts it was already dead on a day we have a
   record of seeing it live — the same class of contradiction D-157 exists to
   prevent. One of the two observations is wrong, nothing here can say which,
   so `observed_at` falls back to `NOW()` and the evidence records the
   refusal. Compared at **day** granularity: the notice prints a date, not a
   timestamp, so same-day is not a contradiction. A listing with no
   `last_seen_at` (nullable) has nothing to contradict.

   Note the asymmetry with the size veto: a contradicted **size** kills the
   whole withdrawal (it means the notice is about someone else's flat),
   whereas a contradicted **date** costs the transition only its precision.
   The portal still positively said this advert is gone.

   **This record has to state the consequence of dating from the notice,
   because it is a real behaviour change and the owner should not discover
   it by missing a notification.** `listing_status_event.observed_at` is what
   the notification layer filters on:

   * `dashboard/lib/notifications/digest.ts` and `seguimiento.ts` select
     status changes with `observed_at >= $since`. **A withdrawal backdated
     more than the digest window drops out of the digest entirely** — the
     owner's own sample was twelve days stale, so a weekly digest would
     never have mentioned it. Backdating is the normal case here, not the
     edge case: these pages are found while draining a queue of adverts
     nobody has looked at in weeks. Accepted deliberately — `observed_at`
     means "when did this happen", not "when should you be told" — but if
     withdrawals start going unnoticed, this is why, and the fix belongs in
     the digest query (filter tracked withdrawals on the event's insertion
     time, not on `observed_at`), not in reverting to `NOW()`. Filed as
     issue #699.
   * `dashboard/lib/candidates.ts` computes `days_on_market` as
     `MIN(observed_at) - first_seen_at` with **no `GREATEST(0, …)` clamp**
     (`dashboard/lib/analytics/market-signals.ts` does clamp). A stated date
     earlier than `first_seen_at` would render a negative figure on the
     card. The `last_seen_at` clamp above makes that much harder to reach —
     `last_seen_at >= first_seen_at` for any listing we have actually
     captured — but it is not a proof, and the clamp belongs in the query
     either way. Filed as issue #699 rather than fixed here.

   **Everything the notice states goes into the evidence**: the sentence, the
   reference, the stated delisting date, and the advert's final stated
   price/size/rooms. The price in particular is a fact this project has never
   recorded before — what an advert was actually asking when it died.

   **None of it is written onto the `listing` row.** Those fields hold values
   from a healthy structured capture; the notice's are a weaker parse (plain
   rendered text) of the same facts. Overwriting good data on a row being
   marked dead is all risk and no gain.

   *Where each check lives.* The reference comparison is in the connector
   (`IdealistaConnector.normalize`), which already holds both the page and the
   id it was handed. The size/rooms comparison needs the **stored** listing, so
   it is in `etl/capture.py` (`_notice_contradicts_stored`), which has the
   database — the connector stays a pure function of HTML and hands over parsed
   facts instead. That is what `RetiredNoticeFacts` and the optional
   `Connector.retired_notice_facts()` hook exist for; `retired_page_signature`
   keeps its exact previous contract (a prose citation or `None`) and every
   connector that implements only that one — fotocasa, pisos — is untouched.
   Note that `retired_page_signature` answers "is this page a notice?", *not*
   "is this listing retired?" — it cannot, since nothing about it knows which
   listing the caller has in mind. Only `normalize` can withdraw an Idealista
   listing, and only after the reference check.

2. **Any other page with zero substantive fields → plain `ConnectorError`.**
   If the page yields no price, title, description, address, reference, area,
   room count, coordinates, photos or features block, and is not the recognised
   notice, `normalize()` refuses to return anything. The capture is recorded
   `failed` and **nothing about any listing changes**.

   **Only SELECTOR-DERIVED values count as substantive.** A value that
   Idealista serves site-wide is worthless as proof that a page is an advert,
   however non-None it looks, and the connector carries two of exactly that
   kind:

   | field | site-wide fallback that must NOT count | what counts instead |
   |-------|----------------------------------------|---------------------|
   | title | `og:title` / `<title>` — "Viviendas venta. Viviendas alquiler. Pisos. Chalets — idealista" | the `.main-info__title-main` element |
   | description | `og:description` — "Casas y pisos, alquiler y venta, anuncios de particulares y inmobiliarias" | the `.adCommentsLanguage` block |

   The first was right from the start; the second was **not**, and the
   omission was found by an Opus review of PR #691 reproducing the entire
   #690 corruption on a page whose notice sentence had merely been
   *reworded* ("ya no **se encuentra** publicado"): `description` fell back
   to `og:description`, the guard read that as substantive and never fired,
   the empty parse wiped the stored gallery, and — worse than the original
   bug, because `_update_existing_listing` COALESCEs `description` — the
   site-wide blurb **overwrote a real advert description**. The fail-safe
   this decision rests on ("reword the notice and the page falls through to
   the refusal guard") was therefore not actually in force for the one page
   shape it was written about.

   The lesson generalises past this connector: *a fail-safe that rests on a
   fallback chain is not a fail-safe.* Where a field has a chrome-level
   fallback, the guard must be given the selector-derived value in its own
   local, not the merged one. The merged value is still what gets RETURNED —
   an og: fallback is a reasonable last resort on a real advert whose markup
   shifted — it just may not VOUCH for the page being an advert.

   Pinned by three tests: the reworded notice page raising `ConnectorError`
   with the meta tag still present (deleting it from the fixture would hide
   the defect, not fix it), `og:description` alone not being substantive, and
   a real `.adCommentsLanguage` block alone still being enough to ingest.

Withdrawal marks and never deletes (D-157): the listing row, its
`listing_price_history`, its feedback and its dedup identity all survive.
`last_seen_at`/`last_fetched_at` are deliberately **not** touched — they mean
"last confirmed present", which is the opposite of what was observed. A notice
page for a URL with no stored listing creates nothing. The capture is recorded
under a new `extension_capture.status = 'withdrawn'`, and the worklist row is
retired to `stale` (see below).

**Alternatives rejected**:

- *Ship on the notice sentence alone* (what this decision originally said).
  It withdraws on "some Idealista advert is gone", which a generic notice
  shell served at the wrong URL — a redirect, a stale tab, a mis-typed
  capture, a portal bug — satisfies just as well as a real one. The printed
  reference costs nothing to check and turns the claim into "Idealista says
  THIS advert is gone".
- *Treat the reference as a nice-to-have, withdrawing anyway when it is
  absent.* That is the sentence-alone rule wearing a hat: whenever it
  actually matters — the notice that is not about our listing — it is
  precisely the case where corroboration is unavailable or fails.
- *Corroborate on price too.* Rejected above: a seller repricing before
  delisting is ordinary, and price is the one stated figure that legitimately
  moves.
- *Pass the parsed facts out through the exception, or give the connector a
  database handle.* The first widens `ListingUnavailableError`'s shape for
  every connector that raises it; the second puts SQL in a class whose entire
  contract is "pure function of a page". `capture.py` re-reads the facts from
  the same HTML instead — one extra parse, on the rare notice path only.

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

**Reading `failed_7d` during a drain.** Every corroboration veto here —
missing reference, mismatched reference, contradicted size/rooms — resolves
through `_mark_failed`, which calls `_correlate_worklist(url, "failed")` and
so flips the `capture_worklist` row out of `pending`. That is the right
outcome for one page (a page we could not read is visible on data-health,
rather than silently `done` as before this fix), but it means **a systematic
parse regression would consume the drain queue**: if Idealista reshapes the
notice, every dead URL in the queue burns itself as `failed` while nothing is
learned. So, during a drain, **a spike in `failed_7d` for idealista means
"the corroboration parse broke", not "the pages are broken"** — the response
is to look at a retained page (D-160's retention floor keeps unexplained ones)
and repair the parse, not to requeue. (Retained pages have no TTL or cap
today — filed as issue #698.)

**Not covered here**: the already-corrupted production rows are left alone by
this PR. Retro-classifying them would mean inferring *withdrawal* from the
generic-title signature, which proves only "the last capture was not an
advert" — it cannot distinguish a retired notice from a soft block, and doing
it anyway would be the same absence-shaped reasoning this decision rejects.

**And they will NOT self-correct on their own.** An earlier draft of this
record said they would, "the next time each URL is captured". They will not:
those captures were recorded `done`, so `_correlate_worklist(url, "captured")`
already flipped their `capture_worklist` rows out of `pending`, and the
"Abrir siguiente pendiente" pool selects `status = 'pending'`. Nothing will
ever hand the owner those URLs again. They sit as `active` phantoms with
wiped galleries indefinitely. Repairing them means **requeueing the
`fields_extracted = 3` idealista cohort** with the #683 /
[D-156](D-156-recapture-requeues-worklist-rows.md) machinery once these PRs
have landed — filed as issue #697, deliberately after the fix, so a requeued
page meets a connector that can classify it.

**See**: issues #690 and #691 (the corroboration/date hardening); #697
(requeue the corrupted cohort — it will not self-correct), #698 (no retention
TTL on retained `failed` HTML), #699 (the two backdated-`observed_at`
consequences downstream);
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
