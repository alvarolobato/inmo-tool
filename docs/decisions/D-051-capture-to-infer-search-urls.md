---
id: D-051
title: Capture-to-infer — learn portal search-URL grammars from real navigated URLs
date: 2026-08-05
group: Data / connectors
rule: 'Capture-to-infer: LEARN portal search-URL grammars from the owner''s real navigated URLs. `parse()` per portal is the literal inverse of the #296 slug `build()` (round-trip byte-for-byte tested); "Capturar todas" piggybacks a save to `search_url_example` (auto-trusted, no review); `resolve()` upgrades each `SearchTask` — exact section+location → confirmed template, same-area ≤25km → reuse with loosened flag, else the hand-written `build()`.'
order: 54
---

# D-051: Capture-to-infer — learn portal search-URL grammars from real navigated URLs

*Decided: 2026-08-05*

> ID note: originally drafted as D-048, but #300 landed D-047, #299 takes D-048,
> #302 takes D-049 and #272 may take D-050 — so this decision uses the next
> genuinely-free id, D-051.

**Context**: The per-portal pre-filtered search-URL builders (#267/#277) were
hand-written, reverse-engineered, and demonstrably wrong — the idealista builder
emitted a map-draw `/areas/…?shape=<polygon>` grammar when the owner's real URL
is a `<municipio>-<provincia>` path slug. #296 corrected both builders from the
owner's tested URLs (idealista `/<operation>/<municipio>-<provincia>/con-<f>/`;
aliseda `/comprar-viviendas/<plural>/<comunidad>/<provincia>?subtipo=&precio=min-max`)
and restructured the API to return `{tasks: SearchTask[]}` (one openable task per
portal × section). But the builders are still hand-maintained and can drift or be
incomplete (guessed aliseda plurals, unknown subtipo codes, province-fallback
approximations). The fix (issue #293, design spike #290, owner sign-off
2026-08-05): stop guessing — LEARN each portal's grammar from the URLs the owner
actually navigates, and prefer a confirmed template over the hand-written one.
Owner-approved defaults: reuse-with-flag geography, piggyback the batch-start
click, auto-trust every captured URL, organic accumulation.

**Decision**:
1. **`parse()` per portal is the literal structural inverse of the CURRENT
   (#296) `build()`** (`dashboard/lib/search-url/portals/{idealista,aliseda}.ts`).
   It decodes `{filters, categoryKey, template}`, where `template` is the URL
   with every continuous numeric value swapped for a named placeholder
   (`{price_max}`, aliseda's range `precio={price_min}-{price_max}`, …) and every
   categorical part (section, location slug, subtipo, rooms token) left literal.
   Round-trip tests (`parse(build(scope))` decodes the section/filters back AND
   re-substituting reproduces the URL **byte-for-byte**) fail loudly the day any
   `build()` grammar changes — the mechanism that stops us re-breaking the URL.
2. **`search_url_example` table** (`etl/schema/init.sql`, idempotent): `portal,
   url, match_key, filters(jsonb), category_key, template, created_at`,
   `UNIQUE(portal, match_key)`, auto-trusted, `ON CONFLICT DO UPDATE` refresh
   (dedupes re-captures by canonical `match_key`). `filters` carries the decoded
   `locationSlug` and its approximate `center` (resolved from the known
   municipio/province tables) for area matching; `category_key` is the **section**
   (idealista operation / aliseda tipo-plural) — the categorical identity, since
   under the slug grammar one section = one property-type granularity.
3. **Piggyback save, no new UI**: the extension's "Capturar todas" batch-start
   (`browser-extension/background.js` `startBatch`, URL from `popup.js`
   `batchContext.tab.url`) also fire-and-forget POSTs the search page URL to
   `POST /api/extension/search-url-example` (admin-gated, URL-only, portal derived
   from host). Best-effort — a save failure never disrupts the capture run.
4. **`resolve()` upgrades each `SearchTask`** (`dashboard/lib/search-url/resolve.ts`,
   server-only, wired into `GET /api/profiles/[id]/search-urls`, preserving the
   `{tasks}` contract #299 consumes; task `id`/`label` unchanged, only
   `url`/`loosened` may change):
   - **Tier 1 — exact**: a learned example for the SAME section AND the SAME
     location slug the profile resolves to → substitute the profile's numeric
     values into the confirmed template; DROP the builder's guessed-grammar flags
     (the owner navigated it, so they're confirmed) — only genuine
     can't-express-this loosenings remain. No reuse flag.
   - **Tier 2 — same area**: a same-section example whose centroid is within 25 km
     of the profile's own centre (derived from the profile scope's lat/lng, NOT a
     URL) → reuse its template (its location slug) with a "plantilla reutilizada
     de otra búsqueda de la zona" loosened geography flag.
   - **Tier 3 — none** → the hand-written task, unchanged.

**Alternatives rejected**:
- *Cross-section (different-category) same-area reuse* — the section is IN the URL
  path under the slug grammar, so a garaje template can't produce a valid piso
  URL. Same-area reuse is therefore scoped to the SAME section (a nearby town's
  confirmed URL of the same property type), which is what "category" means here.
- *Decoding geography from the URL* — #296 removed the polyline `?shape=` encoder;
  geography is now a path slug. The profile's own centre comes straight from its
  scope lat/lng; an example's centre is resolved from its slug via the known
  municipio/province tables.
- *Diff-based grammar inference; reverse-geocoding a profile centre to a slug;
  a review/approve or browse/prune UI* — all deferred (design §4/§6).
- *Storing a `profile_id` on the example* — the URL decodes on its own terms; app
  state is fragile and unnecessary.

**Rationale**: The grammar lives entirely in the URL the owner already produced,
so learning it is strictly more reliable than maintaining it by hand, and the
#296 builders stay as the permanent zero-examples fallback (loosen, never
silently drop). The byte-for-byte round-trip test converts "did we invert the
grammar right" from an unverifiable hope into a failing test — and will catch the
next `build()` grammar change automatically.

**See**: issues #293 (implementation), #290 (design spike), #296/#277/#267
(builders + tasks), #299 (tasks consumer); `dashboard/lib/search-url/{parse-shared,parsers,resolve}.ts`,
`dashboard/lib/search-url/portals/{idealista,aliseda}.ts`,
`dashboard/lib/search-url/{municipios,provinces}.ts` (slug ↔ point),
`dashboard/lib/db/search-url-example.ts`,
`dashboard/app/api/extension/search-url-example/route.ts`,
`etl/schema/init.sql` (`search_url_example`), `browser-extension/{popup,background}.js`;
D-037/D-043/D-045 (guided/batch capture), D-032 (decision-id collision CI check).
