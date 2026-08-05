---
id: D-063
title: URL-building discovery mode — learn a portal's option→URL mapping from the extension, seed as fallback
date: 2026-08-05
---

# D-063: URL-building discovery mode — learn a portal's option→URL mapping via the extension; hard-coded seed is the fallback

*Decided: 2026-08-05*

**Context**: Connectors build a portal's pre-filtered search URL from a
hand-maintained table mapping {property type, subtype, price band, zone, …} to
the portal's URL params/path (e.g. Aliseda's `PLURAL_BY_TYPE`/`SUBTIPO_BY_TYPE`
in `lib/search-url/portals/aliseda.ts`). That table silently drifts and is
incomplete — the driving example was Aliseda "ático" producing a wrong/404 URL
(issue #336 Part A, fixed independently in #338/D-061). The root cause is that we
*guess* the portal's URL grammar instead of *learning* it. This generalizes
beyond Aliseda (every servicer/portal has the same drift).

**Decision**: Add a **URL-building discovery mode**. The browser extension,
running on the owner's real authenticated session, runs an OPTION-ENUMERATION
pass (`#inmo-discover` signal, mirroring the D-053 `#inmo-capture` contract
byte-for-byte via `withDiscoverSignal` ↔ `discoverSignalPresent`) on a portal's
SEARCH page: it enumerates the filter OPTIONS the portal exposes (property type
etc., as the portal labels them) and the URL FRAGMENT each produces — reading
the in-page embedded config JSON first, falling back to the live
`<select><option>` elements — and POSTs a catalog to
`POST /api/extension/filter-catalog` (admin-key gated; the connector is derived
from the page HOST, never trusted from the body — same discipline as
`search-url-example`/D-051). It is persisted to a `portal_filter_catalog` table
(one row per connector × session, latest-wins). The connector's URL builder
consults the LATEST discovered catalog via
`lib/search-url/discovered-mapping.ts::discoveredSegmentFor(connector, axis,
canonicalValue)` and PREFERS the discovered slug/subtipo over the hard-coded
table, FALLING BACK to the table when nothing was discovered. When discovered,
the "guessed" loosened flags are suppressed (the values are authoritative).

Binding specifics:
- **Scope/robots**: discovery reads the search FORM's option list + the URL
  shape each option yields — form metadata, NOT listing results. No pagination,
  no bulk detail fetch. Same read-only, owner-authenticated boundary as capture
  (`docs/skills/connectors.md`, D-051).
- **The hard-coded per-portal table is the verified SEED / offline default**,
  never removed. Discovery is an authoritative OVERRIDE when present. A portal
  re-labelling `pisos` or adding a subtype code needs only a re-run of
  discovery, not a code change.
- **Connector-agnostic storage**: `portal_filter_catalog.axes` is JSONB
  (`{axisName → [{label, portalValue?, urlFragment, category?, subtipo?, …}]}`),
  carrying whatever axes a portal exposes; only Aliseda's `property_type` axis is
  wired end-to-end in the first cut. Canonical-type resolution (portal label →
  our `PropertyType`) lives in TS (`discovered-mapping.ts`), keeping the
  extension taxonomy-free.
- **Priming**: the server-only resolver (`resolve.ts`) loads the latest catalog
  and primes the client-safe `discovered-mapping.ts` cache right before building;
  a DB miss/error clears it → seed fallback. Non-primed paths (client-safe
  `buildSearchUrls`) see an empty cache → seed, which is correct.

**Alternatives rejected**:
- *Thread the catalog through `build(scope)` as a parameter.* Would change the
  public builder signature and every caller, and force `buildSearchUrls` async.
  A module-level latest-per-connector cache primed by the resolver keeps builders
  pure/sync and client-safe; concurrent priming converges on the same latest
  value (benign for a low-traffic admin tool).
- *Embed our canonical `PropertyType` taxonomy in the extension.* Keeps the
  extension generic instead: it scrapes portal labels, TS maps them to canonical.
- *Upsert one row per connector.* Retaining every session (no upsert) makes drift
  auditable; the read path just takes the newest.

**Rationale**: Learning the grammar from the portal itself is the durable fix for
the drift class of bug behind #336; keeping the verified table as the seed means
the feature composes safely with the ático fix (#338/D-061) and degrades to
today's behaviour offline.

**See**: issue #336 (Part B design comment); `dashboard/lib/search-url/discovered-mapping.ts`,
`dashboard/lib/db/portal-filter-catalog.ts`, `dashboard/app/api/extension/filter-catalog/route.ts`,
`dashboard/app/etl/discovery/page.tsx`, `dashboard/app/api/etl/discovery/[connector]/route.ts`,
`browser-extension/discover.js`, `browser-extension/detect.js` (`DISCOVER_SIGNAL`),
`dashboard/lib/extension-discover.ts`, `etl/schema/init.sql` (`portal_filter_catalog`);
[D-051](D-051-capture-to-infer-search-urls.md), [D-053](D-053-batch-capture-discoverability.md),
[D-061](D-061-aliseda-category-subtype-url-grammar.md) (Aliseda seed).
