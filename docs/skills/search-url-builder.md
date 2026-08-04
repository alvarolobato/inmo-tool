# Skill: per-portal pre-filtered search-URL builder

**Module:** `dashboard/lib/search-url/` — issue #267 (part of #237).

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

buildSearchUrls(profile.scope)            // → PortalSearchUrl[] (every capture portal with a builder)
buildSearchUrl("idealista", profile.scope) // → PortalSearchUrl | null
```

`PortalSearchUrl = { portal, url, loosened: LoosenedConstraint[] }`.

API route: `GET /api/profiles/[id]/search-urls` → `{ profileId, name, urls }`.

## Best-effort mapping contract (issue #267)

If a portal's URL grammar can't express a constraint, the builder **loosens it
to something BROADER (more results, never fewer)** and appends a
`LoosenedConstraint` naming what it widened. A hard constraint is **never
silently dropped** — the UI surfaces every `loosened` entry so the operator
knows the open search is wider than the profile.

## Scope → portal mapping (as of #267)

The profile `Scope` carries geography as a **radius around a geocoded point**
(`center` lat/lng + `radius_km`) — NOT a municipality name/slug — plus
`property_types`, `price_min/max`, `size_min/max`. **There is no rooms field**
in the scope today, so `roomsMin` on `CanonicalSearchScope` is reserved and
never set (add the scope field first, then the portal tokens).

| Portal | Geography | Property types | Price / size |
|--------|-----------|----------------|--------------|
| **idealista** | Map-area search: the radius is rendered as a Google-encoded circle polygon in the `shape=` param (`/areas/…`). Faithful → **not** loosened. | One operation section at a time (`venta-viviendas` / `venta-locales` / `venta-garajes` / …). Types spanning sections → pick the first, broaden the rest, flag `property_types`. Home subtypes (`pisos`/`chalets`/`aticos`) added as `con-` tokens when they narrow. | `con-precio-desde_/precio-hasta_`, `con-metros-cuadrados-mas-de_/menos-de_`. |
| **aliseda** | No radius/coordinate search → geography is **always loosened** (returns the full catalogue for the price/type band; zone must be narrowed by hand). | One `tipo` per search; types spanning categories → drop `tipo`, flag `property_types`. | `precioMin/precioMax`, `superficieMin/superficieMax` query params. |

## Adding a portal

1. Add it to `CAPTURE_PORTALS` in `dashboard/lib/worklist.ts` (the capture roster).
2. Write `dashboard/lib/search-url/portals/<name>.ts` implementing `PortalSearchUrlBuilder`.
3. Register it in `BUILDERS` in `dashboard/lib/search-url/index.ts`.
4. Add a unit test `dashboard/lib/search-url/__tests__/<name>.test.ts` (scope → URL, including loosened flags).

A capture portal with no builder is skipped, not an error — the roster and the
builder set grow independently.

## Volatility note

The path/query spellings are the fragile part (portals change their URL
grammar). They are isolated to each `portals/<name>.ts` so refreshing them is a
local edit; the tests pin current behaviour.
