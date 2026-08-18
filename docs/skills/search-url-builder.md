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
approximation). `"grammar"` instead flags that the URL's basic token
VOCABULARY is itself an unconfirmed inference — Hipoges is the first (and so
far only) portal that uses it; see the Hipoges entry under
[Confirmed vs. reverse-engineered grammar](#confirmed-vs-reverse-engineered-grammar) below.

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
| **hipoges** (#561, D-115) | `:country/:town` — `"espana"` (bare guess) + nearest known municipio/province from `municipios.ts`/`provinces.ts`, reused from idealista/aliseda's OWN tables (not grounded for Hipoges). **Every task ALWAYS carries a `"grammar"` flag** (see above) — the whole token vocabulary is inferred, not just geography. | One task per **canonical type**, mapped onto Hipoges' i18n-derived typology tokens (`flat`/`house`/`office`/`building`/`garage`/`land`): `piso→flat`, `chalet→house`, `garaje→garage`, `terreno→land`, `edificio→building` (exact-ish); `atico→flat`, `local→office`, `nave→building` fold onto the nearest token (approx + flagged). | No confirmed grammar for either — `[:features]`'s internal shape is completely unconfirmed, so price/size are never guessed into the URL, always dropped + flagged. |

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

- **Hipoges — route GROUNDED, vocabulary INFERRED (issue #561, D-115).** Unlike
  every other portal above, no owner-tested example and no successful crawl
  exist for Hipoges at all (D-075: every sanctioned enumeration channel 403s
  an honest client). The builder therefore rests on two DIFFERENT levels of
  evidence, and conflating them is the mistake to avoid when touching this
  file:

  - **GROUNDED** — the ROUTE shape, read from the site's own public Angular
    route table (`main-*.js`/`chunk-*.js`, a static client bundle, not an API
    call — the same source D-111 used for the detail-URL shape):

    `/:lang/:operation/:typology/:country/:town[/:features]`

  - **INFERRED, never observed on a real URL** — every token inside that
    shape:
    - `:lang` = `"es"` — the least uncertain of the four (the sitemap index
      D-075/D-111 already confirmed `_es_sitemap.xml` locale siblings).
    - `:operation` = always `"sale"` — an English route token inferred from
      the site's own public `assets/i18n/es.json` key names (#548,
      `etl/connectors/hipoges_mapping.py`'s comment); never `"rent"` (the
      profile scope has no operation field, matching idealista/aliseda's own
      sale-only precedent).
    - `:typology` — one inferred token per canonical type, from the SAME
      i18n bundle (`flat`/`house`/`garage`/`land`/`office`/`building`
      emitted; `apartment`/`storage` recognised by the parser but never
      emitted). A type with no confident match folds onto the nearest token
      and is flagged `property_types` (atico→flat, local→office,
      nave→building) — same discipline as Aliseda's ático/chalet folding.
    - `:country`/`:town` — the LEAST grounded segments, not even an i18n
      echo. `:country` is a bare `"espana"` guess; `:town` reuses
      idealista/aliseda's own municipio/province tables (grounded for THOSE
      portals' slug spelling, not Hipoges').

  Every task this builder emits therefore ALWAYS carries an unconditional
  `"grammar"` loosened flag (a NEW `LoosenableConstraint`, distinct from
  every other flag here — see the best-effort contract section above) saying
  the vocabulary is inferred and may 404 or return the wrong search. `[:features]`
  is never populated — its internal grammar (price range? feature codes?
  something else?) is completely unconfirmed, so a profile price/size bound
  is reported as DROPPED rather than guessed a second time.

  **Do not "improve" this by probing** — no fuzzing `POST /api/assets/map`,
  no spoofed User-Agent, no trying a guessed URL against the live site "just
  to check" (D-075/D-033's stop-probing rule). The correction mechanism is
  D-051 capture-to-infer: `hipogesParser` is registered like every other
  portal's parser, so the owner's FIRST real navigated Hipoges search is
  auto-trusted and upgrades every future task for that section, dropping the
  guessed-grammar flags — exactly like idealista/aliseda already get. See
  [D-115](../decisions/D-115-hipoges-search-url-inferred-grammar.md) for the
  full record.
