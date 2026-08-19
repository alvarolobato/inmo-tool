---
id: D-115
title: Hipoges search-URL builder — vocabulary read from the public bundle, only :operation is a guess
date: 2026-08-19
group: Data / connectors
rule: '`dashboard/lib/search-url/portals/hipoges.ts` builds `/es/venta/<typology>/espana/<municipio>_<provincia>` — `:lang`/`:typology`/`:country`/the `:town` FORMAT are all CONFIRMED by reading the site''s public `main-*.js`/`chunk-*.js`/`es.json` bundle (grep it before guessing anything here — reading a public bundle is expected, not probing). Only `:operation` (`"venta"`) is an inference — the bundle pins its DISPLAY value, not the route CODE — and carries the sole `"grammar"` loosened flag. `hipogesParser` must accept ANY operation/typology token (never reject-to-null) so a real capture is always learnable via D-051; `resolve.ts` exempts Hipoges from the #444 municipio-authoritative gate since its town is admittedly guessed, not code-pinned. Never encode price/size into `[:features]` (a confirmed comma-joined config-code list, exact codes unconfirmed) — report them as dropped instead.'
---

# D-115: Hipoges search-URL builder — vocabulary read from the public bundle, only `:operation` is a guess

*Decided: 2026-08-19 — REVISED 2026-08-19 (fresh-context Opus review of PR #562, the most consequential review that week). The original version below shipped with FOUR of five typology tokens wrong, a town format that doesn't exist on the real site, a "learning" mechanism that could never actually learn anything, and doc text that told the next agent (and, once, the owner) not to do the one thing that would have caught all of it. See "Revised" below for the corrected facts and what changed in code; the original "Context"/"Decision" sections are kept for the historical record of how the mistake happened.*

## Revised (2026-08-19) — what was actually wrong, and the fix

**The core error**: the original version conflated two different things under
one name, "probing" — LIVE network requests against the real site (correctly
forbidden by D-075/D-033) and READING THE SITE'S OWN PUBLIC JS/JSON BUNDLE
(`main-*.js`, `chunk-*.js`, `assets/i18n/*.json` — static assets every
visitor's browser downloads on a plain GET, no auth, no live search). D-111
already established the second is fine — it's exactly how the detail-URL
shape was grounded. The original D-115/hipoges.ts text said the typology
vocabulary "cannot be verified without probing" and told future agents "do
not 'improve' this by probing" — both statements are false for the bundle,
and the review read the bundle with plain GETs to prove it.

**What the bundle actually says** (no live search needed, all from the site's
own public code):

- `AssetsURLValidator.canActivate` (in `main-*.js`) validates each route
  segment against a real catalog and redirects home on a miss:
  `typologies.find(_ => _.code === params.typology)`, same shape for
  `operations`/`countries`. A wrong token is therefore a **silent redirect to
  the Hipoges home page**, not a 404 — worse than the original text claimed.
- `AssetsService.buildListingUrl` (`chunk-*.js`) builds the URL from `.code`,
  never `.dbValue` — these are different strings on the same object.
- Typology translations are keyed `filtersForm.subtypologies.<code>` in the
  i18n bundle, so `es.json`'s `filtersForm.subtypologies` object KEYS are the
  real typology codes: `pisos-y-casas`, `locales-y-naves`, `terrenos`,
  `garajes`, `oficinas`, `trasteros`, `edificios`, `obra_parada`. The
  original version used `assetType.*` i18n keys instead
  (`flat`/`house`/`garage`/…) — a **different axis entirely**; none of those
  six emitted tokens exist in any locale's typology vocabulary. This was the
  review's finding B1.
- `operation.dbValue` is `"venta"`/`"alquiler"` (es) — `.code` (what the
  route validates) is the one thing the bundle does not pin outright. The
  original version used the **English** `dbValue` ("sale") from the wrong
  locale, which is exactly why the wrong guess looked plausible.
- `cercaliaService.getCode` plus a town→code table (`chunk-*.js`) confirms
  `:town` is `<municipio>_<provincia>` — underscore-joined, accents stripped
  (`"Estepona, Málaga"` → `"estepona_malaga"`) — NOT the bare municipio slug
  idealista/aliseda use, which is what the original version emitted.
- `:country` values compare against Spanish slugs (`"grecia"` is one) in the
  bundle, so `"espana"` was already correct and is unchanged.

**Code changes** (`dashboard/lib/search-url/portals/hipoges.ts`, full
rewrite of the token tables; `dashboard/lib/search-url/resolve.ts`, one
targeted exemption):

1. **`:typology` is now a CONFIRMED per-typology-SECTION grouping, not a
   per-canonical-type guess.** `piso`/`chalet`/`atico` all collapse into the
   one real `pisos-y-casas` section; `local`/`nave` into `locales-y-naves`;
   `garaje`/`terreno`/`edificio` keep their own confirmed sections
   (`garajes`/`terrenos`/`edificios`). This is the site's OWN taxonomy, not
   an approximation on this project's part, so — unlike the old
   `atico`/`local`/`nave` folds — no `property_types` loosened flag is
   attached; same "the section is the granularity" shape idealista's
   `venta-viviendas` already has.
2. **`:operation` = `"venta"`** (was `"sale"`, the wrong-locale `dbValue`).
   It remains the ONE inferred token — the bundle pins the display value,
   not the route code — and is now the ONLY thing the `"grammar"` loosened
   flag names. Every task no longer claims the whole route/vocabulary is
   unconfirmed; only this one token is.
3. **`:town` = `<municipio>_<provincia>`**, reusing idealista/aliseda's own
   municipio/province tables for the two identifier halves (their spelling
   is still not independently confirmed for Hipoges — only the FORMAT is,
   from the one real example) but joined with the confirmed underscore
   separator. A point outside every known market falls back to a
   `<municipio>_<provincia>`-shaped default (currently `madrid_madrid`)
   instead of the old fallback's nonsensical `espana/espana` (review N4).
4. **`hipogesParser` no longer rejects a real captured URL.** The original
   `PATH_RE` hard-coded `(sale|rent)` for operation and `splitHipogesPath`
   returned `null` for any typology outside its (wrong) token set — so the
   owner's actual first navigation would decode to `null`,
   `saveSearchUrlExample` would report `{stored:false,
   reason:"unparseable"}`, and NOTHING would ever be learned. This is the
   review's B2, and it falsifies the very sentence the original PR body used
   to reassure the owner ("navigate once and the grammar fixes itself").
   `PATH_RE` now accepts any operation/typology token (the only structural
   exclusion is the literal word `"detail"` in either slot, to avoid
   conflating a search URL with a detail URL); an unrecognised typology
   decodes `propertyTypes` to `[]` (honest "we don't know which of our types
   this is") rather than being rejected outright — the URL is still stored
   and still learnable.
5. **`resolve.ts` exempts Hipoges from the #444 "code-driven town is
   authoritative" gate.** That gate (written for idealista, where the town
   slug is genuinely code-pinned and authoritative per D-090) was silently
   disabling tier-2 same-area reuse for Hipoges too, in precisely the two
   markets this tool operates in — the opposite of what a portal whose town
   is an admitted guess needs. `baseTask.portal !== "hipoges"` gates the
   check now.
6. **`[:features]`'s description is corrected** (review N2): it is a
   confirmed comma-joined list of config codes (price/rooms/baths/area +
   subtypology, from `_getAssetsFeats`) — a known SHAPE, unconfirmed exact
   CODES — not "no confirmed grammar at all". The behaviour (never guess a
   code in, report price/size as dropped) is unchanged; only the wording
   stopped overstating the unknown.
7. **The UI's "ampliada:" (broadened) prefix is wrong for the `"grammar"`
   flag** (review N6) — a wrong operation token isn't necessarily a broader
   search, it may be a completely different page (a home-page redirect).
   `dashboard/lib/search-url/labels.ts`'s new `loosenedPrefixLabel()`
   renders `"sin confirmar:"` for `"grammar"` and `"ampliada:"` for
   everything else, used by both `CaptureTaskRow` and `FilterValidationRow`.
8. **A resolver-level test with a REALISTIC captured URL was added**
   (`dashboard/lib/search-url/__tests__/resolve.test.ts`, describe block
   `"resolveSearchTasks — Hipoges tiers with a REALISTIC captured URL"`) —
   its absence from the original PR is exactly why B2 shipped unnoticed. It
   proves, against a hand-written URL string (never derived from this
   builder's own guess): tier 1 (exact town) upgrades the task and drops the
   `"grammar"` flag; tier 2 (same-area, different town) upgrades it too,
   proving the #444 exemption actually works; tier 3 (different section)
   correctly does nothing.

**Not addressed, and not claimed to be**: the exact per-town SPELLING this
builder guesses (only Estepona's format was observed on a real example — a
multi-word town like "Dos Hermanas" might join as `dos_hermanas_sevilla`,
`doshermanas_sevilla`, or something else entirely); whether `"venta"` really
is the route `.code` and not, say, `"comprar"` or a numeric id; the exact
`[:features]` codes. All three remain corrected by the SAME D-051
capture-to-infer path this decision wires up — they were never going to be
solved by more careful guessing, only by the owner's real navigation, which
(unlike the original version) now actually reaches the learning mechanism.

**Alternative considered and rejected**: rewriting this file from scratch
instead of a "Revised" section. Rejected for the same reason D-113 kept its
own review-driven revision in place rather than opening a new decision — the
mechanism this decision is about (a Hipoges search-URL builder existing at
all, wired to D-051) is unchanged; what changed is the FACTS the builder
encodes. Keeping the original text below, clearly superseded, is a more
honest record of how the mistake happened than deleting it.

## Revised again (2026-08-19, round 2) — the SAME wrong vocabulary had a THIRD
## call site, and it was the one that actually blocked the owner

The fix above corrected the builder (`hipoges.ts`) and the parser
(`hipogesParser`). It did not touch a THIRD place the same wrong `sale`/`rent`
guess had been written into: the LISTING-vs-DETAIL page-role detectors —
`etl/listing_detect.py` and `browser-extension/detect.js` (D-069's
lockstep-mirror pair) — whose `isListingPath`/`"listing"` regex hard-coded
`(sale|rent)` as the only accepted operation tokens. The owner navigated a
real search
(`https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/dos-hermanas_sevilla`)
and the extension reported no capture-capable connector recognised it — the
detectors, not the builder/parser, were what actually gated whether the
extension would even try to capture the page at all.

**Fix**: both mirrors now match the route's SHAPE (`operation`/`typology`
positions are simply "not literally `detail`", never an enumerated token
list) instead of an allow-list — applying the SAME B2 lesson (don't
enumerate a vocabulary you don't have to) one level up the stack, where it
should have been applied the first time. The owner's exact URL is now a
permanent test case in both suites (`etl/tests/test_listing_detect.py`,
`dashboard/__tests__/extension-detect.test.ts`) — real ground truth from the
live site.

**Lesson for future agents**: when "the vocabulary was wrong" turns out to be
true, grep the WHOLE tree for the wrong tokens before declaring the fix
complete — this vocabulary had three independent call sites (builder,
parser, detector-pair) written from the same original guess, and each
review only looked at the slice it was asked to look at. `etl/connectors/hipoges.py`'s
own `hipoges_mapping.py` module ALSO uses `flat`/`house`/`garage`/`storage`/
`office`/`building`/`apartment` as English keywords — but for free-text DOM
title/description matching, a legitimately different (and still correct)
use of the same i18n bundle's `assetType.*` axis, not a URL slug. Checked
and left alone.

---

## Original decision (2026-08-19, SUPERSEDED above — kept for the record)

**Context**: #548 shipped `etl/connectors/hipoges.py` (D-111) as a capture-only
connector — Hipoges (`realestate.hipoges.com`) has every sanctioned
enumeration channel walled (D-075) — but never wrote a search-URL builder.
The owner hit this immediately (issue #561): the ETL correctly never fetches
Hipoges (`scope_key()` always `None`), and `/captura` showed no Hipoges task
at all, so there was no button to press and no way to reach the portal
without guessing a URL by hand.

`etl/connectors/hipoges.py`'s module docstring already grounds the site's
Angular route table (read from the public `main-*.js`/`chunk-*.js` bundle —
a static asset, not an API call, the same source D-111 used for the
detail-URL shape):

```
:lang/detail/:id  and  :lang/:investment/detail/:id        (detail)
:lang/:operation/:typology/:country/:town[/:features]       (listing/search)
```

So the search route's SHAPE is grounded. **What follows below (the
vocabulary being unconfirmed and unconfirmable without probing) was the
mistake** — see "Revised" above for the correction. The original text is
otherwise left as written.

**See**: [issue #561](https://github.com/alvarolobato/inmo-tool/issues/561);
[D-111](D-111-hipoges-capture-only.md) (the capture-only connector and the
grounded detail-route table this reuses); [D-075](D-075-hipoges-walled-enumeration-capture-only.md)
(why Hipoges is capture-only — not re-litigated here); [D-051](D-051-capture-to-infer-search-urls.md)
(capture-to-infer — the correction mechanism this decision leans on, and the
mechanism the original version's B2 bug silently defeated); [D-101](D-101-profile-connector-filter-override.md)
(`captureUrl` vs `url` distinction, consumed unchanged here); [D-113](D-113-capturar-todo-batch-queue-piggyback.md)
(the precedent for revising a decision in place with a labeled "Revised"
section rather than opening a new one); `etl/connectors/hipoges.py` (the
route-table docstring this reads), `etl/connectors/hipoges_mapping.py` (the
i18n-derived vocabulary this ALSO got — the operation dbValue confusion — but
whose own effect is confined to free-text keyword matching on a captured
DOM, not a route parameter, so it was never itself wrong the way the URL
builder was), `dashboard/lib/search-url/portals/hipoges.ts`,
`dashboard/lib/search-url/resolve.ts` (the #444 exemption),
`dashboard/lib/search-url/labels.ts` (`loosenedPrefixLabel`),
`dashboard/lib/search-url/__tests__/hipoges.test.ts`,
`dashboard/lib/search-url/__tests__/resolve.test.ts`, `docs/skills/search-url-builder.md`,
`docs/skills/captura-execution.md`.
