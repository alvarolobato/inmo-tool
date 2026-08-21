# Skill: per-portal pre-filtered search-URL builder

**Module:** `dashboard/lib/search-url/` — issue #267 (part of #237); grammar +
task-list restructure in #277.

Turns a search profile's canonical `Scope` into the search URL each
capture-capable portal understands, so guided capture ("Abrir búsqueda" /
"Empezar captura") opens the portal already filtered to the profile
(zone/price/type/size). From there the batch-capture-from-listing flow (#262)
takes over. **URL construction only — no automated fetch**; the operator's
browser loads the URL.

> **Not to be confused with the ETL-connector URL grammar (issue #491).** This
> module (`dashboard/lib/search-url/`) is the *capture-extension* builder for the
> browser-driven CAPTURE portals. The ETL **connectors** publish their own
> declarative, invertible `SearchUrlGrammar` (build template + parse regex) to
> `connector_registry.search_url_grammar`; the generic
> `dashboard/lib/connector-url/parse.ts` reads it to infer params from an
> owner-edited URL on the "Validar filtros" page. Different surface, different
> connectors — see [connectors.md → Search params + URL grammar](../architecture/connectors.md#search-params--url-grammar-issue-491).

## Public API

```ts
import { buildSearchUrls, buildSearchUrl, canonicalScopeFromProfile,
         SEARCH_URL_PORTALS } from "@/lib/search-url";

buildSearchUrls(profile.scope)             // → SearchTask[]  (flat, every portal × section)
buildSearchUrl("idealista", profile.scope) // → SearchTask[] | null  (one portal's tasks)
```

`SearchTask = { id, portal, label, url, loosened: LoosenedConstraint[] }`.

**Task list, not one URL per portal (#277).** Each portal searches ONE section
at a time (idealista: one operation section; aliseda: one property-type path
segment), so a profile fans out into a flat list of discrete, openable TASKS —
one per (portal × section) — instead of a single merged URL with a "types
widened" note. `id` is a stable, deterministic hash of `portal + normalized
filters` (see `task-id.ts`); the same profile+filters always reproduces the same
id, so a UI feature can record "last run at" keyed on it.

API route: `GET /api/profiles/[id]/search-urls` → `{ profileId, name, tasks }`.

> The Captura UI currently groups tasks by portal (one card per portal, one
> "Abrir búsqueda" button per task) as an interim; a dedicated task-driven UI
> (per-task last-run tracking) is a separate issue.

## Reviewing captured/observed search URLs — SQL, not a page (#653)

`/admin/captured-urls` (issue #475/#488, part of #471) was deleted outright in
#653: production had only 2 `captured_search_urls` rows (last written
2026-08-09) and 152 `observed_search_urls` rows — a developer decode aid for
URL-grammar work, not an operator surface anyone was checking. The write paths
are untouched (`POST /api/captured-search-urls`, the extension's passive
observer → `POST /api/observed-search-urls`, D-051's capture-to-infer
machinery) — only the browsing page is gone. When decoding a portal's grammar
(the workflow #471/#514 needed that page for), query the tables directly:

```bash
ps prod psql app "$POSTGRES_DB" <<'SQL'
-- Deliberate captures ("Capturar URL de búsqueda"), newest first, verbatim
-- (shape= and all).
SELECT id, portal, url, title, captured_at
FROM captured_search_urls
ORDER BY captured_at DESC, id DESC
LIMIT 50;

-- Passively-observed search/results pages, most-recently-seen first — a
-- re-observation UPSERTs (seen_count, last_seen), so this is naturally
-- deduped to one row per distinct search.
SELECT id, portal, url, title, seen_count, first_seen, last_seen
FROM observed_search_urls
ORDER BY last_seen DESC
LIMIT 50;
SQL
```

Filter either query with `WHERE portal = '<portal>'` or `WHERE url LIKE
'%<fragment>%'` the same way the old page's portal chips / filter box did.
Both tables and their schemas are unchanged — see `etl/schema/init.sql`
(`captured_search_urls`, `observed_search_urls`) for full column docs,
including the `norm_key` de-dup key on the observed table.

## Precedence: the builder is tier 3 — an owner pin wins (tier 0, D-051/D-101)

The `build()` in this module is the **bottom** of a precedence stack that
`resolveSearchTasks(scope, profileId)` (`dashboard/lib/search-url/resolve.ts`)
applies per task. From strongest to weakest:

> **tier 0** — owner-pinned override (`profile_connector_filter`, issue #478 / D-101): the URL the owner tuned and pinned by hand for this `(profile × portal × section)`. Used **verbatim** (`loosened: []`, `overridden: true`), never re-substituted — it is the maximal "owner-confirmed" signal and beats every derived URL. Matched by `section_key` (the parser's `categoryKey`, or `''` = all sections); id/label are preserved so `capture_task_run` staleness survives the upgrade. A capture portal with no builder (altamira) gets a **synthesised** task from its pin — its first search URL with zero builder code.
> **tier 1** — exact learned example (D-051): substitute the profile's numbers into a confirmed same-section, same-slug template.
> **tier 2** — same-area (≤25 km) learned example, capped by #444 (`municipioForPoint`).
> **tier 3** — this module's hand-written `build()` (the default for any profile with no pin and no learned example; #471 P2 upgrades it to a `shape=` polygon builder).

Tier 0 is *stronger* in the same direction #444/D-090 already point (owner-confirmed beats derived), so the #444 regression must stay green with tier 0 present. On the **ETL** side the same pin drives recall too: a supporting HTTP connector consumes it as `ConnectorScope.override_url` in `discover()` (D-101 — see `docs/architecture/connectors.md`).

## Best-effort mapping contract (issue #267)

If a portal's URL grammar can't express a constraint, the builder **loosens it
to something BROADER (more results, never fewer)** and appends a
`LoosenedConstraint` naming what it widened. A hard constraint is **never
silently dropped** — the UI surfaces every `loosened` entry so the operator
knows the open search is wider than the profile.

**`"grammar"` (issue #561, D-115) is a different kind of flag.** Every other
`LoosenableConstraint` names one specific dropped/broadened VALUE inside an
otherwise-confirmed grammar (a rooms token, a price bound, a geography
approximation). `"grammar"` instead flags that ONE SPECIFIC TOKEN in the
URL is an unconfirmed inference — not, as the first version of Hipoges'
builder claimed, the whole route. A fresh-context review of that first
version (PR #562) found FOUR of five Hipoges typology tokens were flatly
wrong and traced every one of them from the site's own public bundle with
plain GETs — see the Hipoges entry under
[Confirmed vs. reverse-engineered grammar](#confirmed-vs-reverse-engineered-grammar)
below for the corrected facts, and read it before touching `hipoges.ts`:
almost this whole grammar is confirmed, not guessed, and the one bundle read
that confirmed it needed no probing.

## Scope → portal mapping (as of #277)

The profile `Scope` carries geography as a **radius around a geocoded point**
(`center` lat/lng + `radius_km`) — NOT a municipality name/slug — plus
`property_types`, `price_min/max`, `size_min/max`. **There is no rooms field**
in the scope today, so `roomsMin` on `CanonicalSearchScope` is reserved and only
fires when a caller supplies it (idealista maps it to a rooms token). Geography
is resolved by two small lat/lng tables:
- `provinces.ts` — `provinceForPoint` → `<comunidad>/<provincia>` (bounding
  boxes; málaga + sevilla, both andalucía). Used by aliseda for its path slug.
- `municipios.ts` — `municipioForPoint` → nearest-town within `MAX_MATCH_KM`
  (centroids for Costa del Sol + greater Sevilla towns). Idealista now renders
  geography as a **drawn polygon** (`geo.ts`, #471) and uses this table only for
  the human task LABEL ("~Dos Hermanas (r=5 km)"), not the URL.

| Portal | Geography | Property types (→ tasks) | Price / rooms / size |
|--------|-----------|--------------------------|----------------------|
| **idealista** | **Drawn polygon (`shape=`), #471.** The profile circle is rendered as a 24-gon (circumscribing → faithful, ~0.9% broader) and encoded as a Google polyline in `/areas/<operation>[/con-…]/mapa-google?shape=((<polyline>))`. The radius is expressed faithfully → geography is **never flagged**; two radii around one centre give two URLs. `municipios.ts` is used only for the human LABEL (nearest town). | One task per **operation section** (`venta-viviendas` / `venta-locales` / `venta-garajes` / …). Home subtypes are NOT narrowed (the section is the granularity — owner's confirmed URL carries no subtype token). | price `con-precio-desde_/precio-hasta_`; rooms `de-cuatro-cinco-habitaciones-o-mas` (min ≥ 4 confirmed; lower → omit + flag); size `con-metros-cuadrados-mas-de_/menos-de_`. Comma-joined after `con-`, in the PATH before `/mapa-google`. |
| **aliseda** | `<comunidad>/<provincia>` path slugs from `provinces.ts`. Radius→province is **always broader** → geography **always loosened**. Point outside every box → drop geo segments + flag. | One task per **canonical type**, mapped to Aliseda's own taxonomy (#336): residential types are `comprar-viviendas/<subtype-slug>` (`pisos`, `chalets-adosados`, …); **non-residential types are their OWN top-level category** (`comprar-locales`/`comprar-naves`/`comprar-garajes`/`comprar-terrenos`/`comprar-edificios`), **not** nested under viviendas. Aliseda has **no `ático`** → ático folds onto `pisos` (broadened + flagged); chalet → `chalets-adosados` only (approx + flagged). Types collapsing to one URL (piso+ático) are de-duped. | `precio=<min>-<max>` (hyphen range, min defaults to 0), plus `subtipo=<code>` on viviendas (`pisos=36`, `chalets-adosados=31` confirmed; others omitted + flagged). Size has no confirmed grammar → dropped + flagged. |
| **hipoges** (#561, D-115) | `:country` = `"espana"` (confirmed — country values compare against Spanish slugs in the bundle). `:town` = `<municipio>_<provincia>` (CONFIRMED format from one real example, `estepona_malaga`) — the two identifier halves are reused from idealista/aliseda's OWN municipio/province tables (their exact spelling for Hipoges is the one part of this row not independently confirmed). | One task per **confirmed typology SECTION** (`pisos-y-casas`/`locales-y-naves`/`garajes`/`terrenos`/`edificios`, read from the bundle's `filtersForm.subtypologies` keys — see below), not per canonical type: `piso`+`chalet`+`atico` → `pisos-y-casas`; `local`+`nave` → `locales-y-naves`; the rest keep their own section. No `property_types` flag — this is the site's own taxonomy, same "section is the granularity" shape as idealista's `venta-viviendas`. | `:operation` = `"venta"` — the ONE inferred token on this whole row, carries the sole `"grammar"` flag. `[:features]` is a CONFIRMED comma-joined list of config codes (price/rooms/baths/area+subtypology) whose exact codes are unconfirmed → price/size dropped + flagged, never guessed in. |

## Adding a portal

1. Add it to `CAPTURE_PORTALS` in `dashboard/lib/worklist.ts` (the capture roster).
2. Write `dashboard/lib/search-url/portals/<name>.ts` implementing `PortalSearchUrlBuilder` (`build(scope) → SearchTask[]`, one task per searchable section).
3. Register it in `BUILDERS` in `dashboard/lib/search-url/index.ts`.
4. Add a unit test `dashboard/lib/search-url/__tests__/<name>.test.ts` (scope → tasks: exact URLs, stable ids, loosened flags).

A capture portal with no builder is skipped, not an error — the roster and the
builder set grow independently.

## Inverse preview on "Validar filtros" (issue #497)

The capture-portal rows on `/profiles/[id]/filtros` render the resolved task URL
back through the **existing** per-portal parsers (`PARSERS` in
`dashboard/lib/search-url/parsers.ts`, via `decodeFilterUrl` in
`dashboard/lib/filter-validation.ts`) — this is UI wiring, **not** new parser
logic. An edited/pinned URL is decoded into Spanish chips (idealista: vertex
count for a `shape=` polygon, zone count for a `/multi/` URL, filters for a
legacy slug; aliseda: type/zone/price) plus amber warnings where the URL is
broader than the profile scope. **Confirmed tokens only**: anything the parser
does not recognise degrades to a verbatim pin with the "se usará tal cual" note
— never an error or a block (the owner tuned it by hand; their intent wins).

**Verbatim-only portals** (no builder *and* no parser — e.g. **altamira**, whose
Akamai WAF blocks grammar verification) are flagged `verbatimOnly` on the row.
That row offers zero inference: no chips, no warnings, no misleading "no se pudo
descodificar" note — just an honest "sin gramática verificada; se usa tal cual"
note and a verbatim pin under the portal's host. A portal graduates out of
verbatim-only the moment it gains a real `PortalSearchUrlParser`.

## Volatility note

The path/query spellings are the fragile part (portals change their URL
grammar). They are isolated to each `portals/<name>.ts` so refreshing them is a
local edit; the tests pin current behaviour.

### Confirmed vs. reverse-engineered grammar

- **Aliseda** — grammar **corrected against the live portal 2026-08-05** (issue
  #336; supersedes the #277 shape, which wrongly nested every type under
  `comprar-viviendas` and guessed `aticos`). Two path shapes:
  - residential: `/comprar-viviendas/<subtype-slug>/<comunidad>/<provincia>?subtipo=<code>&precio=<min>-<max>`
  - non-residential: `/comprar-<category>/<comunidad>/<provincia>?precio=<min>-<max>` (no subtype/subtipo).

  Confirmed example (owner-tested — Estepona-area piso ≤ 200 000 €):
  `https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000`.

  **Verified** (from the live category sitemap + the app's `main-*.js` bundle +
  Google-indexed category URLs, 2026-08-05): the top-level categories
  (`comprar-viviendas`/`-locales`/`-naves`/`-garajes`/`-terrenos`/`-edificios`/…);
  the vivienda subtype slugs (`pisos`, `duplex`, `casas`, `chalets-adosados`,
  `chalets-pareados`, `lofts`, `pisos-turisticos` — there is **no `aticos`**);
  and the codes `pisos=36`, `chalets-adosados=31`. **Canonical-type mapping**:
  `piso→pisos/36` (exact); `atico→pisos/36` (Aliseda has no ático — áticos are
  pisos → broadened + flagged); `chalet→chalets-adosados/31` (Aliseda splits
  houses into casas/adosados/pareados — approx + flagged); `local→comprar-locales`,
  `nave→comprar-naves`, `garaje→comprar-garajes`, `terreno→comprar-terrenos`,
  `edificio→comprar-edificios` (each its own category, no subtipo). Types that
  collapse to the same URL (piso+ático) are de-duped. **Not guessed**: subtipo
  codes for chalet-pareados/casas/lofts/… (omitted). Province slugs come from
  `provinces.ts` (bounding boxes for málaga and sevilla, both `andalucia`). See
  [D-062](../decisions/D-062-aliseda-category-subtype-url-grammar.md).
- **Idealista** — geography is a **drawn polygon (`shape=`)**, grammar
  **owner-confirmed from a real captured specimen 2026-08-08** (issue #471; the
  earlier #277 shape builder was reverted because it was reverse-engineered
  without a real URL — this one is pinned to one). The builder emits

  `/areas/<operation>[/con-<f1>,<f2>,…]/mapa-google?shape=((<polyline>))`

  where `<polyline>` is a **Google Encoded Polyline (precision 5, lat,lng)** of
  the profile circle as a **closed, circumscribing 24-gon**, URL-encoded and
  wrapped in `((…))`. Filters (`con-…`) ride in the PATH before `/mapa-google`.
  Captured specimen (Dos Hermanas, ≤ 700 000 €):
  `https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_700000/mapa-google?shape=%28%28}hpbFl|lc@…%29%29`
  → a 10-vertex ring, centroid ≈ Dos Hermanas. `geo.ts` (`encodePolyline` /
  `decodePolyline` / `circlePolygon` / `shapeUrl`) is pinned to it byte-for-byte
  in `geo.test.ts`.

  **Why drawn-polygon, not the old slug:** the slug grammar resolved the point
  to the nearest of 12 hard-coded `<municipio>-<provincia>` towns and DISCARDED
  the radius (5 km ≡ 30 km ≡ same URL), couldn't express sub-/cross-municipality
  circles, and was blind to Idealista's zone mis-parenting (Montequinto filed
  under "Sevilla"). A polygon over the real area sidesteps the whole taxonomy and
  renders the radius faithfully (no geography flag). Per break-by-default the slug
  grammar is **retired as the builder's output**; it survives only inside the
  **parser** so owner-navigated / historical slug URLs stay learnable (D-051).

  **Parser also recognises** (never generated): the multi-zone grammar
  `/multi/<operation>/<zone-codes>/[con-…]/` (opaque Idealista neighbourhood
  codes — usable verbatim as a tier-0 override). Confirmed tokens elsewhere:
  `con-precio-hasta_/desde_`, the 4-5+ rooms token. **Best-effort** (flagged when
  used): a rooms minimum below 4 (omitted), the standard `metros-cuadrados-*`
  size tokens.

  **Resolver:** shape/multi are CONCRETE, code-pinned geometry — `resolve.ts`
  never lets a learned example relocate them (only a tier-0 owner override wins),
  which makes the #444 municipality-crossing rewrite structurally impossible.

- **Hipoges — almost the WHOLE grammar is CONFIRMED by reading the public
  bundle; only `:operation` is a guess (issue #561, D-115, revised after a
  fresh-context review of the first version — PR #562).** No owner-tested
  example and no successful crawl exist for Hipoges at all (D-075: every
  sanctioned enumeration channel 403s an honest client). The FIRST version of
  this builder responded to that by conflating two different things under
  the name "probing": LIVE requests against the real site (correctly
  forbidden, D-075/D-033) and READING THE SITE'S OWN PUBLIC BUNDLE
  (`main-*.js`/`chunk-*.js`/`assets/i18n/*.json` — static assets on a plain
  GET, no auth, no live search — exactly what D-111 already used to ground
  the detail-URL shape). It guessed the typology vocabulary from the wrong
  i18n keys and never opened the bundle to check. **Read the bundle before
  guessing anything in this file — that is the expected first step, not an
  exception to the no-probing rule.**

  What the bundle actually says (all read with plain GETs, no live search,
  no probing of any endpoint):

  - `AssetsURLValidator.canActivate` (`main-*.js`) validates each route
    segment against a real catalog and redirects HOME on a miss —
    `typologies.find(_ => _.code === params.typology)`, same shape for
    `operations`/`countries`. A wrong token is a **silent home-page
    redirect**, not a 404 — worse than a visible failure, so getting this
    right matters more than the first version's own text implied.
  - `AssetsService.buildListingUrl` (`chunk-*.js`) builds the URL from
    `.code`, never `.dbValue` — different strings on the same object.
  - Typology i18n keys are `filtersForm.subtypologies.<code>`, so
    `es.json`'s `filtersForm.subtypologies` object KEYS ARE the real
    typology codes: `pisos-y-casas`, `locales-y-naves`, `terrenos`,
    `garajes`, `oficinas`, `trasteros`, `edificios`, `obra_parada` —
    CONFIRMED, not guessed. (`flat`/`house`/`garage`/… — what the first
    version used — are `assetType.*` i18n keys, a DIFFERENT axis entirely;
    none of them are valid typology codes. That was the review's B1.)
  - `operation.dbValue` is `"venta"`/`"alquiler"` (es) — `.code` (what the
    route validates) is the ONE thing the bundle does not pin outright. The
    first version used the ENGLISH `dbValue` ("sale") from the wrong locale,
    which is exactly why the wrong guess looked plausible. `"venta"` is now
    used as the most-likely code, and it is the ONLY inferred token left.
  - `cercaliaService.getCode` + a town→code table (`chunk-*.js`) confirms
    `:town` is `<municipio>_<provincia>` — underscore-joined, accents
    stripped (`"Estepona, Málaga"` → `"estepona_malaga"`) — CONFIRMED
    format, not the bare municipio slug idealista/aliseda use (which the
    first version wrongly emitted).
  - `:country` values compare against Spanish slugs (`"grecia"` is one) —
    `"espana"` was already correct, unchanged.
  - `[:features]` (`_getAssetsFeats`, `chunk-*.js`) is a confirmed
    comma-joined list of CONFIG CODES (price/rooms/baths/area +
    subtypology) — a known SHAPE, unconfirmed exact CODES. Never guess a
    code in; price/size stay reported as dropped.

  So the builder emits `/es/venta/<typology>/espana/<town>` where `:lang`,
  `:typology`, `:country`, and the `:town` FORMAT are all CONFIRMED — one
  task PER TYPOLOGY SECTION (`piso`+`chalet`+`atico` → `pisos-y-casas`;
  `local`+`nave` → `locales-y-naves`; the rest keep their own confirmed
  section — the site's own taxonomy, no `property_types` flag, same "section
  is the granularity" shape idealista's `venta-viviendas` already has). Only
  `:operation` (`"venta"`) is inferred, and it is the ONLY thing the
  `"grammar"` loosened flag names now (a NEW `LoosenableConstraint`, distinct
  from every other flag here — see the best-effort contract section above).

  **`hipogesParser` must accept ANY operation/typology token, never reject to
  `null`.** The first version whitelisted `sale|rent` and a fixed (wrong)
  typology set, so a REAL captured URL — which necessarily uses tokens the
  builder didn't happen to guess right — decoded to `null` and
  `saveSearchUrlExample` silently never learned anything (the review's B2).
  D-051's whole point is broken if the thing meant to teach this file a URL
  never accepts one. An unrecognised typology now decodes `propertyTypes` to
  `[]` (honest "we don't know which of our types this is") rather than being
  rejected — the URL is still stored and still learnable. `resolve.ts` also
  exempts Hipoges from the #444 "code-driven town is authoritative" gate —
  this builder's town is an admitted guess, not a confirmed slug the way
  idealista's is, so same-area reuse (tier 2) must stay reachable even when a
  municipio resolves (which it does for every point in this tool's own two
  markets).

  **Do not fuzz `POST /api/assets/map`, spoof a User-Agent, or try a guessed
  URL against the live site "just to check"** (D-075/D-033's stop-probing
  rule — this is still correctly forbidden). **Do** read the public bundle
  first; it answers almost everything here. The correction mechanism for the
  one remaining guess (`:operation`) is D-051 capture-to-infer:
  `hipogesParser` is registered like every other portal's parser, and now
  actually accepts a real capture (see above), so the owner's FIRST real
  navigated Hipoges search is auto-trusted and upgrades every future task
  for that section, dropping the `"grammar"` flag — exactly like
  idealista/aliseda already get. A resolver-level test with a hand-written,
  realistic captured URL (`dashboard/lib/search-url/__tests__/resolve.test.ts`)
  proves this end to end — its absence from the first version is exactly why
  B2 shipped unnoticed; don't remove it. See
  [D-115](../decisions/D-115-hipoges-search-url-inferred-grammar.md) for the
  full record.
