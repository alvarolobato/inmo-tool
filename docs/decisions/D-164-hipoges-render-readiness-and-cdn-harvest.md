---
id: D-164
title: Hipoges result cards carry no anchors — harvest the asset reference from the photo CDN path, and judge listing readiness by the harvest itself
date: 2026-08-22
group: Data / connectors
rule: 'Hipoges detail URLs come from the photo CDN path (`/imageshams/<bucket>/<lot>/<ref>/`), never from `a[href]` — its cards are not links. Listing readiness is a settled non-zero harvest, never a selector.'
---

# D-164: Hipoges result cards carry no anchors — harvest the asset reference from the photo CDN path, and judge listing readiness by the harvest itself

*Decided: 2026-08-22*

**Context**: The owner reported Hipoges twice — *"no está detectando los
listados de inmuebles y la extracción automática no funciona"*, and then
concretely *"/es/venta/… dice que no hay anuncios que capturar y yo veo 17 / un
anuncio concreto dice sin resultados"*. Production held **2 active Hipoges
listings**. #700 measured the symptom and explicitly scoped the repair out;
#547 calibrated the parser's selectors but its step 6 — re-verify
`detect.js`'s `readySelectors` against real *search* pages — never became an
exit criterion and was never done.

Two captures already sitting in production Postgres answered it without a
single request to the site (Hipoges is capture-only: D-075, D-111).

**`extension_capture` id 3576** — the owner's own
`/es/venta/pisos-y-casas/espana/dos-hermanas_sevilla`, 262 KB of retained HTML:

- `<main>` present; `<h1>` = *"17 Pisos y casas en venta en Dos Hermanas,
  Sevilla"*; body text 2.036 chars against a 400-char floor. So
  `readySelectors: ["main","h1"]` was satisfied on the **first 500 ms poll**,
  by the page header.
- The results list at that instant: **4 painted `<init-similar-card>` + 13
  `<p-skeleton>` placeholders = the 17 he could see.**
- **Zero anchors on the page resolve to a detail URL.** The four *fully
  painted* cards — real titles, m², prices — carry no `<a href>` at all. They
  navigate by Angular click handler. The page's 65 anchors are nav, footer,
  social and language links.

**`extension_capture` id 3577** — the `/es` home page: every `/detail/` string
on it is a **blog article** (`es/blog/detail/<slug>`, six of them).

**Decision**:

1. **Hipoges detail URLs are derived from the photo CDN path, not from
   anchors.** A card's image is
   `https://hipoges.azureedge.net/imageshams/<bucket>/<lot>/<ref>/<file>` and
   `<ref>` is the advert's own asset reference, lowercased — the `:id` of the
   `:lang/detail/:id` route. `detect.js`'s `mediaDetailRef` reads it,
   uppercases it, and builds the URL in the page's own language segment.
   Host-pinned and shape-checked (`[a-z]{4}-\d{4,6}`); an unrecognised
   servicer prefix yields nothing rather than a fabricated URL.

2. **A results page's readiness is a settled non-zero harvest, not a
   selector match.** `isRenderReadyListing()` requires the portal's listing
   element, at least one harvested detail URL, and that count holding steady
   across `harvestSettlePolls` consecutive polls. Loading placeholders
   (`<p-skeleton>`) delay readiness but can never veto it once the count has
   settled, so a lazily-rendered tail cannot deadlock the page.

3. **Hipoges' detail readiness drops the generic `main`/`h1` fallback** in
   favour of the advert's own components (`init-asset-detail-main-info`,
   `-features`, `-details`, `-description`), grounded in the real RARE-04347
   capture.

4. **The render budget is per portal** (`maxWaitMs`; Hipoges 45 s, default
   20 s), not one global ceiling.

5. **A page that never renders leaves a row.** Terminal
   `extension_capture.status = 'never_rendered'`, written directly by
   `POST /api/extension/capture` with `outcome: 'never_rendered'`, carrying
   `render_wait_ms` and a one-line `error_msg`.

6. **`blog` is excluded from the `:investment` slot** in both
   `detect.js` and `etl/listing_detect.py` (D-069 lockstep).

**Alternatives rejected**:

- *Just raise `MAX_WAIT_MS`.* This was the obvious reading of "tarda mucho
  tiempo", and it would have fixed nothing. The failure is not that the
  extension gave up too early — it is that it fired **too early and got a
  header**, then harvested a page whose cards are not links. More patience
  applied to an anchors-only harvest still returns zero on a perfectly
  rendered Hipoges page, forever.
- *Grounding listing readiness in a card selector.* No rendered Hipoges
  results list has ever been captured, so any card selector would be a guess
  — exactly how `["main","h1"]` came to be shipped as though calibrated. The
  harvest count is not a guess; it is the operation's own success condition.
- *Treating `<p-skeleton>` as a hard veto.* Clean, and it deadlocks: the
  detail template carries 5 skeletons of its own, and 13 below-the-fold
  placeholders may never resolve until scrolled.
- *Reusing `'failed'` for a never-rendered page.* It would put "the page never
  arrived" in the same bucket as "the parser broke", inflating `failed_7d`
  with an outcome the parser was never given a chance at — the precise
  conflation #700 found had made this unanswerable twice over.
- *`'blocked'`.* The nearest neighbour, but it asserts something specific and
  unproven — that a WAF or challenge intervened. The honest claim is only that
  we ran out of patience.
- *Sending the give-up to `extension_diagnostic`.* That is the manual,
  always-retains-full-HTML, 30-day-purge investigation channel that nothing
  reads (D-153). A routine outcome belongs on the capture ledger, where #644's
  timeline and #640's queue counts already look.
- *An allow-list of `:investment` tokens to exclude blog.* Repeats D-115's
  mistake: a real URL using a token the list did not anticipate silently
  vanishes. A deny-list of the non-asset sections actually observed keeps the
  wildcard's tolerance and closes the one hole we can prove.

**Rationale**: Every load-bearing claim here is measured against HTML already
stored in production, not inferred from an unrendered fixture — which is the
specific failure mode that produced the selectors being replaced. The CDN rule
is confirmed twice, independently: `FRRE-20005`, derived this way from id 3576,
is already in production as a *successfully captured* detail page (rows
3623/3696), and the RARE-04347 detail capture's own gallery images sit under
`.../rran01399/rare-04347/…`. Different servicer prefixes, same rule.

The 45 s budget is chosen, not measured, and is deliberately paired with (5):
the honest render time is still unknown, so the next revision should come from
`render_wait_ms` and `never_rendered` counts rather than from a second guess.

**See**: issue #701; production `extension_capture` ids 3576, 3577, 3614-3617,
3623, 3696; `browser-extension/detect.js`, `content-script.js`,
`diagnostic.js`, `background.js`; `etl/listing_detect.py`;
`etl/schema/init.sql`; `dashboard/__tests__/extension-hipoges-render.test.ts`;
D-075, D-111, D-146 (Hipoges capture-only + parser calibration), D-069
(JS/Python detector lockstep), D-115 (don't allow-list an unconfirmed
vocabulary), D-159 (a distinct outcome gets a distinct status), D-161 (bump the
manifest whenever the extension's behaviour changes).
