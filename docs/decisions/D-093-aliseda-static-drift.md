---
id: D-093
title: Aliseda filter-drift is read from STATIC assets (sitemap + app bundle), not a DOM scrape
date: 2026-08-06
group: Data / connectors
rule: 'Aliseda filter drift is DETECTED server-side from its STATIC, robots-allowed assets (category sitemap `sitemap-category-aliseda-es-0.xml` for top-level `comprar-<category>` paths + the Angular `main-*.js` app-bundle i18n slug map for `comprar-viviendas` residential subtypes) — the passive DOM-scrape discovery (D-090) is RETIRED for Aliseda because its Angular Material `mat-select` overlay is unreadable without a click. `lib/search-url/aliseda-static.ts` fetches+parses them into a `CatalogAxes` (source `static-asset`); `POST /api/etl/discovery/:connector/refresh` persists it and the same `drift.ts` flag on `/etl/discovery` shows ADDED/REMOVED/CHANGED vs `aliseda.ts` `TYPE_MAP`. Passive DOM discovery is KEPT for Idealista (server-rendered). The capture pass bails on any `#inmo-discover` page. URL building stays 100% code-driven (D-090).'
---

# D-093: Aliseda filter-drift from static assets; retire passive DOM discovery for the SPA

*Decided: 2026-08-06*

**Location clause superseded (2026-08-22) by
[D-168](D-168-admin-six-sections-etl-tree-deleted.md)**: the ADDED/REMOVED/
CHANGED drift flag is rendered on `/admin/fuentes/<connector>` (#642 P1), not
on `/etl/discovery` (retired) or `/etl/salud` (deleted by #642 P2). Detection,
parsing and the `POST /api/etl/discovery/:connector/refresh` contract are
unchanged; only the surface moved.

**Context**: D-090 made portal filter discovery a deterministic drift DETECTOR:
the browser extension enumerates a portal's search-form options and a pure diff
(`lib/search-url/drift.ts`) flags where the hard-coded per-portal URL map has
drifted from the live portal, surfaced on `/etl/discovery`. It worked for
Idealista (server-rendered) but **structurally cannot work for Aliseda**: Aliseda
is an Angular Material SPA whose property-type filter is a `mat-select` whose
options render into an overlay **only after a click**. A passive DOM scrape sees
no `<option>`s and no filter control — it captured nothing, or (before the D-090
plausibility gate) the site logo. So Aliseda's drift never got detected.

Yet Aliseda's filter→URL mapping **is** available statically — it is literally
how the ático fix (D-062) was found:
- the **category sitemap** (`/sitemap-category-aliseda-es-0.xml`, reachable from
  `robots.txt` → `/sitemap-index-aliseda.xml`) enumerates the live top-level
  `comprar-<category>` search paths;
- the **Angular app bundle** (`main-<hash>.js`, referenced from the app shell
  `/`) carries the i18n route-slug map whose `comprar-viviendas` residential
  subtypes (`pisos`, `duplex`, `pisos-turisticos`, `lofts`, `casas`,
  `chalets-adosados`, `chalets-pareados` — **no `aticos`**) appear nowhere in the
  sitemap.

**Spike (verified 2026-08-06, honest UA)**: `robots.txt`, the sitemap index, the
category sitemap, the app shell `/` and the hashed `main-*.js` are all **GET-able
server-side** (HTTP 200). Aliseda's WAF does **not** block these static assets
even though it defeats a DOM scrape of the running app. So the extractor runs
**server-side** — no need to route the fetch through the extension. The live map
read from the assets matches D-062 exactly: 11 top-level `comprar-*` categories,
7 vivienda subtypes, no `aticos`.

**Decision**:
- **Retire passive DOM-scrape discovery for Aliseda.** `browser-extension/discover.js`
  drops the `aliseda` `PORTAL_SPECS` entry, so `buildDiscoveryAxes('aliseda', …)`
  returns null (nothing enumerated). Passive discovery is **kept for Idealista**.
- **Server-side static extractor** (`dashboard/lib/search-url/aliseda-static.ts`):
  fetch the category sitemap + app bundle, parse the top-level categories and the
  `comprar-viviendas` residential subtypes, and assemble a `CatalogAxes` (new
  catalog `source: static-asset`). Parse functions are pure and unit-tested from
  captured fixtures (no live network in tests); only the fetch touches the
  network.
- **Emit rule (drift, not noise)**: the catalog mirrors what the code cares
  about, sourced live — each builder slug still present in the assets is emitted
  (its absence → REMOVED, the ático-class 404), and a live category/subtype the
  code does **not already know** (`CATEGORY_SLUGS` / `VIVIENDA_SUBTYPE_SLUGS`) is
  emitted → ADDED (a genuinely new taxonomy entry, e.g. a real `aticos`).
  Categories/subtypes the code knows but deliberately doesn't build (`duplex`,
  `casas`, `comprar-oficinas`, …) are **not** emitted, so day-one is GREEN and
  only a real portal change lights the flag.
- **Wiring**: `POST /api/etl/discovery/:connector/refresh` runs the extractor,
  writes a `portal_filter_catalog` row and returns the computed drift. The
  `/etl/discovery` page shows a **"Comprobar deriva (estáticos)"** button for
  Aliseda (server fetch) in place of the passive `#inmo-discover` "Iniciar
  descubrimiento" (kept for passive/Idealista-style connectors). The drift diff
  (`drift.ts::computePortalDrift`) and its red/green banner are unchanged.
- **UX fix**: the extension's listing-capture pass now **bails on any
  `#inmo-discover` page** (`content-script.js`: both `startListingLoop` and
  `startAutoCaptureLoop` short-circuit when `discoverSignalPresent(url)`), so the
  discovery page never offers "Capturar N".

**Alternatives rejected**:
- *Keep the passive scrape and try harder (synthesise clicks / read the overlay).*
  Fragile, and a content script driving a `mat-select` to harvest options is
  exactly the brittle self-driving pass D-090 moved away from. The static assets
  are the portal's own source of truth and are cheaper and stabler to read.
- *Fetch the static assets from the extension instead of the server.* Only needed
  if the WAF blocked server-side GETs — the spike proved it does not. Server-side
  keeps the whole extractor testable and off the owner's browser.
- *Emit every portal option faithfully and let drift flag all of it.* Correct by
  D-090's literal ADDED semantics but leaves ~10 permanently-ADDED categories the
  code intentionally never maps, turning the flag permanently red and useless as
  a change signal. The known-taxonomy gate keeps it a genuine change detector.

**Rationale**: Reading the portal's own static, robots-allowed assets
server-side is auditable, deterministic, testable from fixtures, and degrades
safely (a fetch/parse failure surfaces a 502 the operator can retry). It restores
Aliseda drift detection that the DOM scrape could never provide, while reusing
D-090's diff + flag surface unchanged.

**See**: issue #377; [D-090](D-090-discovery-drift-detection-only.md) (passive
discovery, retired here for Aliseda only); [D-062](D-062-aliseda-category-subtype-url-grammar.md)
(the grammar these assets confirm); `dashboard/lib/search-url/aliseda-static.ts`,
`dashboard/lib/search-url/__tests__/aliseda-static.test.ts`,
`dashboard/app/api/etl/discovery/[connector]/refresh/route.ts`,
`dashboard/app/etl/discovery/page.tsx`, `dashboard/e2e/discovery.spec.ts`,
`browser-extension/discover.js`, `browser-extension/content-script.js`,
`browser-extension/manifest.json`.
