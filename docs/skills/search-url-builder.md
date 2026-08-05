# Skill: per-portal pre-filtered search-URL builder

**Module:** `dashboard/lib/search-url/` — issue #267 (part of #237); grammar +
task-list restructure in #277.

Turns a search profile's canonical `Scope` into the search URL each
capture-capable portal understands, so guided capture ("Abrir búsqueda" /
"Empezar captura") opens the portal already filtered to the profile
(zone/price/type/size). From there the batch-capture-from-listing flow (#262)
takes over. **URL construction only — no automated fetch**; the operator's
browser loads the URL.

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

## Best-effort mapping contract (issue #267)

If a portal's URL grammar can't express a constraint, the builder **loosens it
to something BROADER (more results, never fewer)** and appends a
`LoosenedConstraint` naming what it widened. A hard constraint is **never
silently dropped** — the UI surfaces every `loosened` entry so the operator
knows the open search is wider than the profile.

## Scope → portal mapping (as of #277)

The profile `Scope` carries geography as a **radius around a geocoded point**
(`center` lat/lng + `radius_km`) — NOT a municipality name/slug — plus
`property_types`, `price_min/max`, `size_min/max`. **There is no rooms field**
in the scope today, so `roomsMin` on `CanonicalSearchScope` is reserved and only
fires when a caller supplies it (idealista maps it to a rooms token). Geography
is resolved to admin-area slugs by two small lat/lng tables:
- `provinces.ts` — `provinceForPoint` → `<comunidad>/<provincia>` (bounding
  boxes; málaga + sevilla, both andalucía). Used by aliseda.
- `municipios.ts` — `municipioForPoint` → nearest-town `<municipio>-<provincia>`
  within `MAX_MATCH_KM` (centroids for Costa del Sol + greater Sevilla towns).
  Used by idealista, which falls back to the province table then national.

| Portal | Geography | Property types (→ tasks) | Price / rooms / size |
|--------|-----------|--------------------------|----------------------|
| **idealista** | `<municipio>-<provincia>` path slug from `municipios.ts` (nearest town). Town match = accepted (not flagged). No town → `<provincia>-provincia` fallback + flag; no province → national + flag. | One task per **operation section** (`venta-viviendas` / `venta-locales` / `venta-garajes` / …). Home subtypes are NOT narrowed (the section is the granularity — owner's confirmed URL carries no subtype token). | price `con-precio-desde_/precio-hasta_`; rooms `de-cuatro-cinco-habitaciones-o-mas` (min ≥ 4 confirmed; lower → omit + flag); size `con-metros-cuadrados-mas-de_/menos-de_`. Comma-joined after `con-`. |
| **aliseda** | `<comunidad>/<provincia>` path slugs from `provinces.ts`. Radius→province is **always broader** → geography **always loosened**. Point outside every box → drop geo segments + flag. | One task per **canonical type**, mapped to Aliseda's own taxonomy (#336): residential types are `comprar-viviendas/<subtype-slug>` (`pisos`, `chalets-adosados`, …); **non-residential types are their OWN top-level category** (`comprar-locales`/`comprar-naves`/`comprar-garajes`/`comprar-terrenos`/`comprar-edificios`), **not** nested under viviendas. Aliseda has **no `ático`** → ático folds onto `pisos` (broadened + flagged); chalet → `chalets-adosados` only (approx + flagged). Types collapsing to one URL (piso+ático) are de-duped. | `precio=<min>-<max>` (hyphen range, min defaults to 0), plus `subtipo=<code>` on viviendas (`pisos=36`, `chalets-adosados=31` confirmed; others omitted + flagged). Size has no confirmed grammar → dropped + flagged. |

## Adding a portal

1. Add it to `CAPTURE_PORTALS` in `dashboard/lib/worklist.ts` (the capture roster).
2. Write `dashboard/lib/search-url/portals/<name>.ts` implementing `PortalSearchUrlBuilder` (`build(scope) → SearchTask[]`, one task per searchable section).
3. Register it in `BUILDERS` in `dashboard/lib/search-url/index.ts`.
4. Add a unit test `dashboard/lib/search-url/__tests__/<name>.test.ts` (scope → tasks: exact URLs, stable ids, loosened flags).

A capture portal with no builder is skipped, not an error — the roster and the
builder set grow independently.

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
  [D-061](../decisions/D-061-aliseda-category-subtype-url-grammar.md).
- **Idealista** — path grammar **owner-confirmed 2026-08-05** (issue #277 fix).
  The builder emits `/<operation>/<municipio>-<provincia>/con-<f1>[,<f2>,…]/`.
  Confirmed examples (Estepona piso ≤ 200 000 €):
  `https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_200000/`
  and with 4+ rooms `…/con-precio-hasta_200000,de-cuatro-cinco-habitaciones-o-mas/`.
  Confirmed tokens: the path shape, `con-precio-hasta_/desde_`, the 4-5+ rooms
  token, and the `<municipio>-<provincia>` slug for a town match. **Guessed /
  best-effort** (flagged when used): the `<provincia>-provincia` and national
  fallbacks when no town is near, a rooms minimum below 4 (omitted), and the
  standard `metros-cuadrados-*` size tokens (long-established, not re-confirmed).
  The previous `/areas/…?shape=…` map-polygon grammar was WRONG and has been
  removed (along with `geo.ts`).
