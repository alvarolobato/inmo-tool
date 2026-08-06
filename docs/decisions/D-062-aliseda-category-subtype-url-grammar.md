---
id: D-062
title: Aliseda search-URL grammar — top-level category per type, vivienda subtype via slug+subtipo, no ático
date: 2026-08-05
group: Data / connectors
rule: 'Aliseda search URLs: non-residential types are their OWN top-level `comprar-<category>` path (locales/naves/garajes/terrenos/edificios); residential is `comprar-viviendas/<subtype-slug>?subtipo=<code>` (`pisos=36`, `chalets-adosados=31`). Aliseda has NO ático → ático folds onto `pisos` (broadened+flagged); chalet→`chalets-adosados` (approx+flagged); unverified subtipo codes omitted, never guessed; piso+ático de-duped.'
order: 57
---

# D-062: Aliseda search-URL grammar — category-per-type + vivienda subtype (slug + subtipo), no ático bucket

*Decided: 2026-08-05*

**Context**: The Aliseda pre-filtered search-URL builder
(`dashboard/lib/search-url/portals/aliseda.ts`, from #277) emitted a single
shape for every property type —
`/comprar-viviendas/<tipo-plural>/<comunidad>/<provincia>?subtipo=<code>` — with
only `piso→pisos`/`subtipo=36` owner-confirmed and every other type's path slug
GUESSED (`aticos`, `chalets`, `locales`, `garajes`, …). Issue #336 reported that
an **ático** profile produced a URL that 404'd / returned nothing.

Investigation against the live portal (2026-08-05) found the grammar was
structurally wrong, not just missing a code:

- **Aliseda has no `ático` category at all.** The string "atico" appears **zero
  times** in the portal's Angular app bundle (`main-*.js`). Áticos are published
  as `pisos`. The emitted `/comprar-viviendas/aticos/…` slug matched nothing.
- **Non-residential types are their OWN top-level `comprar-<category>` paths**,
  not subtypes of viviendas. The live category sitemap
  (`/sitemap-category-aliseda-es-0.xml`) enumerates the top-level categories:
  `viviendas`, `locales`, `naves`, `garajes`, `terrenos`, `edificios`,
  `oficinas`, `trasteros`, `obras-paradas`, `negocios`, `otros`. So a `local`
  search is `/comprar-locales/<region>`, **not** `/comprar-viviendas/locales/…`.
- The residential category `comprar-viviendas` carries a **subtype** as an extra
  path slug + a numeric `?subtipo=<code>`. Verified subtype slugs (from the app
  bundle's i18n map): `pisos`, `duplex`, `pisos-turisticos`, `lofts`, `casas`,
  `chalets-adosados`, `chalets-pareados`. Verified codes (from Google-indexed
  category URLs): `pisos=36`, `chalets-adosados=31`.

**Decision**: The Aliseda builder maps each canonical property type onto
Aliseda's real taxonomy:

| canonical | Aliseda URL | status |
|-----------|-------------|--------|
| `piso` | `/comprar-viviendas/pisos/<region>?subtipo=36` | exact (owner-confirmed) |
| `atico` | `/comprar-viviendas/pisos/<region>?subtipo=36` | **folded** — Aliseda has no ático; áticos are pisos → broadened + `property_types` flag |
| `chalet` | `/comprar-viviendas/chalets-adosados/<region>?subtipo=31` | **approximate** — Aliseda splits houses into casas/adosados/pareados; no single "chalet" filter → flagged |
| `local` | `/comprar-locales/<region>` | exact (own category, no subtipo) |
| `nave` | `/comprar-naves/<region>` | exact |
| `garaje` | `/comprar-garajes/<region>` | exact |
| `terreno` | `/comprar-terrenos/<region>` | exact |
| `edificio` | `/comprar-edificios/<region>` | exact |

`<region>` = `<comunidad>/<provincia>` from `provinces.ts` (or dropped +
geography-flagged when the point matches no known province). `precio=<min>-<max>`
(min defaults to 0) as before. Types that collapse onto the same Aliseda URL
(piso + ático → the `pisos` search) are **de-duplicated**, keeping the exact one.
The `parse()`/`substitute()` inverse (D-051) is updated to decode every Aliseda
category (not only viviendas) so captured URLs round-trip. Subtipo codes that
aren't verified (chalets-pareados, casas, lofts, …) are **omitted, never
guessed**.

**Alternatives rejected**:
- *Guess the `aticos` slug + an ático subtipo code* — Aliseda has no ático bucket
  at all, so any code is fabricated. Folding onto `pisos` is the honest, working
  mapping (áticos genuinely are pisos in the portal's own data).
- *Map chalet to all of viviendas* (broadest) — returns every home type incl.
  pisos; `chalets-adosados` is a real, useful, verified filter and the flag makes
  the narrowing explicit.
- *Wait for the #336 Part B discovery mode before fixing* — the ático bug ships
  independently and first; Part B generalises the same mapping later.

**Rationale**: The builder's contract is best-effort — express the profile as
closely as the portal's real URL grammar allows, and surface every approximation
as a `loosened` flag rather than emit a broken URL. Grounding the mapping in the
live sitemap + app bundle + indexed URLs (not reverse-engineering) is the same
discipline D-051 established.

**See**: issue #336; `dashboard/lib/search-url/portals/aliseda.ts`;
`dashboard/lib/search-url/__tests__/aliseda.test.ts`;
`docs/skills/search-url-builder.md`; [D-051](D-051-capture-to-infer-search-urls.md).
