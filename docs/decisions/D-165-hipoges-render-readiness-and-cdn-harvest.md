---
id: D-165
title: Hipoges result cards carry no anchors — harvest the asset reference from the photo CDN path, and judge listing readiness by the harvest itself
date: 2026-08-22
group: Data / connectors
rule: 'Hipoges detail URLs come from the photo CDN ref, never `a[href]` — its cards are not links. Listing readiness is a COMPLETE harvest, never a selector or a bare settle.'
---

# D-165: Hipoges result cards carry no anchors — harvest the asset reference from the photo CDN path, and judge listing readiness by the harvest itself

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
  standalone `<p-skeleton>` placeholders = the 17 he could see.** (The *raw*
  `<p-skeleton>` tag count is 17, not 13 — each painted card holds one more of
  its own for its photo carousel. See decision 3 below; the difference is not
  cosmetic.)
- **Zero anchors on the page resolve to a detail URL** — the string `/detail/`
  does not occur anywhere in the 262 KB, and `<main>` contains no anchor at
  all. The four *fully painted* cards — real titles, m², prices — carry no
  `<a href>` and no click attribute. They navigate by Angular click handler.
  The page's **16** anchors are nav, footer, social and language links. (65 is
  the count of `href=` *attributes* page-wide: `<link>`×48 + `<base>`×1 +
  `<a>`×16.) Capture id **3617** corroborates from the other side: it is a real
  *detail* page rendering five similar-property cards, and it too carries zero
  `/detail/` anchors — its single `/detail/` string is its own
  `<link rel="canonical">`. Hipoges never emits a detail anchor anywhere.

**`extension_capture` id 3577** — the `/es` home page: every `/detail/` string
on it is a **blog article** (`es/blog/detail/<slug>`, six of them).

**Decision**:

1. **Hipoges detail URLs are derived from the photo CDN path, not from
   anchors.** A card's image is
   `https://hipoges.azureedge.net/imageshams/<bucket>/<lot>/<ref>/<file>` and
   `<ref>` is the advert's own asset reference, lowercased — the `:id` of the
   `:lang/detail/:id` route. Only the **third** segment is the id: the `<lot>`
   is not 1:1 with it (`rran01399` hosts `rare-01643`, `rare-03256` *and*
   `rare-04347`), so a rule keyed on the lot would collide. `detect.js`'s `mediaDetailRef` reads it,
   uppercases it, and builds the URL in the page's own language segment.
   Host-pinned and shape-checked (`[a-z]{4}-\d{4,6}`); an unrecognised
   servicer prefix yields nothing rather than a fabricated URL.

2. **A results page's readiness is a COMPLETE harvest, not a selector match
   and not merely a settled one.** `isRenderReadyListing()` requires the
   portal's listing element, at least one harvested detail URL, that count
   holding steady across `harvestSettlePolls` consecutive polls, **and** a
   reason to believe the harvest is complete. Settled is not complete:
   `harvestSettlePolls: 3` at a 500 ms poll is 1.5 s of an unchanged count, and
   a connection that stalls mid-paint satisfies that at 9 of 17 — after which
   the listing handler autostarts on those 9 as a *success*, not as a deadline
   fallback. Completeness holds when **any** of:

   - the harvest has reached the page's own stated total (`expectedResultCount()`,
     the leading integer of id 3576's `<h1>` "17 Pisos y casas en venta en…");
   - no result placeholder remains — the list itself says nothing more is
     coming. This is the release valve that keeps a stated total the view can
     never reach (a paginated search) from stalling the page to its deadline;
   - the page states no total we can parse — then the settle window decides
     alone, exactly as before, which is every portal except Hipoges.

   Placeholders are therefore load-bearing for the second route **only**, never
   as a veto: the other two routes are independent of them, and `maxWaitMs` is
   the outer bound on all three (at the deadline the partial harvest is used).

3. **A pending-result count is not a count of `<p-skeleton>` tags.** Capture id
   3576 carries **seventeen** of those elements: thirteen standalone, one per
   result still to paint, and four more, one *inside* each painted card holding
   its photo-carousel slot. So the raw tag count never reaches zero on this
   portal — a fully painted 17-result page carries seventeen — and "no
   skeletons left" is a state Hipoges never reaches.
   `pendingPlaceholderCount()` excludes placeholders inside a
   `resultCardSelectors` element, leaving the honest count of results that have
   not arrived (13 on id 3576, 0 once all 17 land). This matters beyond
   tidiness: that number is what the diagnostic reports as `pendingPlaceholders`
   and what the `never_rendered` `motivo=` line names, so reading the raw count
   would have made the one signal added for diagnosis report `still_loading`
   permanently, including on a page that had finished painting.

4. **Hipoges' detail readiness drops the generic `main`/`h1` fallback** in
   favour of the advert's own components (`init-asset-detail-main-info`,
   `-features`, `-details`, `-description`), grounded in the real RARE-04347
   capture.

5. **The render budget is per portal** (`maxWaitMs`; Hipoges 45 s, default
   20 s), not one global ceiling.

6. **A page that never renders leaves a row.** Terminal
   `extension_capture.status = 'never_rendered'`, written directly by
   `POST /api/extension/capture` with `outcome: 'never_rendered'`, carrying
   `render_wait_ms` and a one-line `error_msg`.

7. **A `detail/` URL must name something with a digit in it, and `blog` is
   excluded from the `:investment` slot** — both, in both `detect.js` and
   `etl/listing_detect.py` (D-069 lockstep). The deny-list closes the hole we
   proved (six blog articles in id 3577); it does not close the *class*, since
   `/es/news/detail/…` or `/es/prensa/detail/…` would still classify as
   adverts. Requiring a digit in the `:id` slot does close it: every non-asset
   `detail/` link observed on this portal is a prose slug, and every asset
   reference observed carries digits (RARE-04347, FRRE-20005, FRRE-20171,
   REGA-06247, GTRE-01142, RARE-01643, RARE-03256, RARE-01287, GTRE-01073,
   GTRE-01166 — read off the CDN paths of ids 3576/3577/3617).

   Deliberately **not** the harvest's stricter `[a-z]{4}-\d{4,6}`, even though
   that would close the class harder and this PR already relies on that shape.
   The two uses fail in opposite directions. In `mediaDetailRef` a too-narrow
   shape merely yields no URL — a miss that costs one card and that
   `harvestStats()` now **counts** (`refMisses`), so a stale rule announces
   itself. In `isDetailPath` a too-narrow shape makes a real advert stop being
   recognised as one, silently, with no counter anywhere. The very scenario
   that motivates counting `refMisses` — a servicer whose prefix is not four
   letters — is the scenario in which importing that shape into the detector
   would lose real adverts. "An asset reference carries digits" is the weaker
   assumption and still rejects every prose slug the class is made of.

8. **An unreadable CDN path is counted, not swallowed.** `mediaHarvestStats()`
   returns `refMisses`: media URLs that matched the portal's CDN host but whose
   path yielded no reference. Surfaced in the diagnostic `harvest` block
   (`mediaRefMisses`), in the listing verdict, and in the `never_rendered`
   `error_msg` (`refs_ilegibles=`), and it takes priority over `no_detail_urls`
   as the reported reason. Without it a stale ref rule is indistinguishable
   from a page that genuinely never painted — the exact conflation #701 exists
   to end.

**Alternatives rejected**:

- *Just raise `MAX_WAIT_MS`.* This was the obvious reading of "tarda mucho
  tiempo", and it would have fixed nothing. The failure is not that the
  extension gave up too early — it is that it fired **too early and got a
  header**, then harvested a page whose cards are not links. More patience
  applied to an anchors-only harvest still returns zero on a perfectly
  rendered Hipoges page, forever.
- *Harvesting from a card selector instead of from the photo CDN.* Not for
  lack of evidence — `init-similar-card` is exactly as grounded as
  `init-asset-detail-main-info` is: id 3576 contains four of them, fully
  painted, and reading them is how the no-anchor finding was established in
  the first place. Rejected because it would add nothing. The harvest already
  derives one detail URL from each card's own photo, so card count and harvest
  count are 1:1 by construction, and a second count of the same thing cannot
  disagree usefully. What a card selector *is* good for is scoping the
  placeholder count (decision 3), which is what it now does.
  What would have been a guess — and what `["main","h1"]` actually was — is a
  selector chosen for a page nobody had looked at. That is a different mistake
  from using a selector read off a real capture.
- *Treating every `<p-skeleton>` as a hard veto.* This is the trap decision 3
  exists to avoid, and it is worse than it first looks: because each painted
  card carries one, the raw count never reaches zero, so a veto on it would
  block readiness on a *fully painted* page — forever, until the deadline. Once
  the count excludes in-card placeholders the signal is sound, which is why
  decision 2 is willing to lean on it as a release valve; it is still never a
  veto, since the stated-total and no-total routes bypass it entirely.
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
