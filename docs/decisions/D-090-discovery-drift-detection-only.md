---
id: D-090
title: Portal filter discovery is drift DETECTION only — never self-heals URL building
date: 2026-08-06
group: Data / connectors
rule: 'Portal filter discovery is DETECTION-ONLY (supersedes D-063 self-healing). The extension enumerates a portal''s search-form property-type OPTIONS — plausibility-gated per portal (Aliseda: a `comprar-<category>` segment and/or a `subtipo`; Idealista: a `venta-<section>` segment) so branding/nav junk (the Aliseda logo) is dropped and a portal it can''t read yields NOTHING, not junk — and POSTs a catalog to `portal_filter_catalog`. A deterministic, no-LLM pure diff (`lib/search-url/drift.ts::computePortalDrift`) flags ADDED/REMOVED/CHANGED vs each connector''s hard-coded code mapping (`PortalSearchUrlBuilder.codeMapping()`), surfaced on `/etl/discovery`. URL building stays 100% code-driven from the per-portal map — discovery NEVER feeds URL construction.'
---

# D-090: Portal filter discovery is drift DETECTION only — never self-heals URL building

*Decided: 2026-08-06*

**Context**: #336/#339 (D-063) added a "URL-building discovery mode": the
browser extension enumerated a portal's search-form filter options and the
builder PREFERRED the discovered slug/`subtipo` over its hard-coded seed,
falling back to the seed. Two problems surfaced. (1) The enumerator captured
JUNK: for Aliseda (an Angular SPA with no `<select>`) the generic "largest array
of {label, link} objects" scan grabbed the site LOGO
(`{label:'Aliseda', urlFragment:'/'}`) — a labelled link — instead of the
property-type control. (2) The owner reframed the feature: silently letting a
scraped catalog rewrite the URL grammar is fragile and hard to audit. The
durable value of discovery is telling a human "the portal changed — update the
code", not auto-rewriting URLs.

**Decision**: Discovery is **detection-only**.
- **Enumerator (`browser-extension/discover.js`)**: each wired portal declares
  an `isPropertyTypeOption(opt)` predicate that recognises a real filter option
  by its URL SHAPE (Aliseda: a `comprar-<category>` path segment and/or a
  numeric `subtipo`; Idealista: a `venta-<section>` segment). Candidate option
  arrays are SCORED by how many plausible options they carry, so the real
  control beats navigation/branding. When nothing plausible is found the pass
  captures NOTHING (returns null) rather than junk. Reading the embedded config
  JSON / live form is unchanged; only the plausibility gate is new. Payloads
  still POST to `/api/extension/filter-catalog` → `portal_filter_catalog`
  (latest-wins), host-derived connector.
- **No self-healing**: `resolve.ts` no longer primes a discovered catalog and
  the builders no longer call `discoveredSegmentFor` (removed). URL building is
  100% code-driven from each connector's hard-coded map (Aliseda `TYPE_MAP`,
  Idealista `OPERATION_BY_TYPE`). `resolve.ts` still upgrades tasks from
  owner-navigated LEARNED examples (#293) — a separate mechanism, untouched.
- **Deterministic drift (`lib/search-url/drift.ts`)**: a pure, no-LLM diff keyed
  by URL slug (last path segment) computes, per axis, ADDED (portal offers a
  slug the code doesn't map — e.g. a real Aliseda `aticos` the code folds into
  `pisos`), REMOVED (code maps a slug the portal dropped), CHANGED (shared slug
  whose `subtipo` differs, or whose portal label no longer resolves to the
  code's canonical type). Each connector exposes its code mapping via
  `PortalSearchUrlBuilder.codeMapping()`. Covered portals: Aliseda + Idealista
  (every URL-building portal).
- **Flag it**: `/etl/discovery` renders a per-portal drift report — a red
  "actualiza el mapeo del código" banner listing added/removed/changed options,
  or a green "sin deriva" when the catalog matches. `portal_filter_catalog` is
  retained (now used only for drift analysis).

**Alternatives rejected**:
- *Keep the self-healing and just fix the enumerator.* The owner explicitly
  wants humans to update the code from a flagged diff — auto-rewriting the URL
  grammar from a scraped catalog is the fragility being removed.
- *Move the per-portal filter→URL maps into config files.* Deferred to a
  separate issue (noted as follow-up in #371); this change keeps the maps in
  code and only adds detection on top.

**Rationale**: Detecting drift deterministically and surfacing it for a human is
auditable, testable (pure diff, no LLM), and degrades safely — a portal the
enumerator can't read simply yields no catalog and no false flag, while the
verified code map keeps building correct URLs.

**See**: issue #371 (reframe of #336/#339); `browser-extension/discover.js`
(`PORTAL_SPECS`, plausibility gate), `dashboard/lib/search-url/drift.ts`,
`dashboard/lib/search-url/discovered-mapping.ts` (validator + canonical
resolver, self-healing cache removed), `dashboard/lib/search-url/portals/{aliseda,idealista}.ts`
(`codeMapping()`), `dashboard/lib/search-url/resolve.ts`,
`dashboard/app/api/etl/discovery/[connector]/route.ts`,
`dashboard/app/etl/discovery/page.tsx`; supersedes [D-063](D-063-url-building-discovery-mode.md).
