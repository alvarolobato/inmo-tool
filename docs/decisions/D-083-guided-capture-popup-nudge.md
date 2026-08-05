---
id: D-083
title: Guided-capture popup nudge on supported-portal non-capturable pages
date: 2026-08-06
---

# D-083: Guided-capture popup nudge on supported-portal non-capturable pages

*Decided: 2026-08-06*

**Context**: Issue #237's guided-capture vision ("the app shows me the places to
visit one by one; the plugin knows what to capture") was already largely built:
detail auto-capture (#254), the listing-page batch queue (#262/#318, D-043), the
in-page banner + `#inmo-capture` auto-start signal (D-053), sitemap/manual/derived
worklist seeding (#260/#273), server-side listing reclassification (#343/D-069),
and the `/etl/captura` + `/captura` dashboard worklist pages. One gap remained in
the *extension*: when the owner opened the popup on a **supported** capture portal
(idealista / aliseda / altamira) while on a page that is **neither a detail nor a
search/results page** — the portal home, a saved search, an account page, a filter
form — the popup fell through to `runSingleCapture`, which POSTed a non-listing
page the backend can't parse, producing an error state. No guidance, no worklist
visibility, exactly where the owner most needs "where do I go next".

**Decision**: The extension classifies the current page's **role** via a pure,
unit-tested helper `pageRoleForUrl(url) ∈ {"detail","listing","other",null}`
(`detect.js`, mirrored to the popup through `DETECT_PAGE`'s new `role` /
`supportedPortal` fields). The popup routes on it:
- `detail` → single/auto capture (unchanged);
- `listing` → batch capture (unchanged, D-043/D-053);
- `other` (supported portal, non-capturable page) → a **guided** popup state:
  fetch that portal's worklist progress via the background worker
  (`GET_WORKLIST_PROGRESS` → reuses `GET /api/etl/worklist?portal=`, no new
  backend surface), show `captured/total · pending`, and offer **"Abrir siguiente
  pendiente"** which opens the first pending worklist URL (the existing
  auto-capture / batch machinery takes over there). A **"Capturar esta página
  igualmente"** escape hatch preserves manual capture of the current page;
- `null` (unsupported host, e.g. a not-yet-wired portal or Cimenta2's SPA) →
  keeps the universal manual-capture escape hatch (`runSingleCapture`), unchanged.

The popup never blind-captures a supported-portal non-listing page: it guides
instead. Extension bumped to `0.8.0`.

**Alternatives rejected**: (a) An always-on in-page guide banner on every portal
page — too intrusive and redundant with the listing banner (D-053); guidance
belongs in the owner-initiated popup. (b) A new backend progress endpoint — the
existing worklist GET already returns rows + per-portal summaries; adding a route
would duplicate it. (c) Dropping the "capture anyway" fallback — would remove the
extension's universal manual-capture ability on pages our path-regexes miss.

**Rationale**: Reuses every existing piece (worklist, batch queue, #343 listing
path) and adds only the missing routing + a read-only progress fetch. The routing
decision is a pure function unit-tested against the same portal case tables as the
rest of `detect.js`, so it stays in lockstep with the detail/listing predicates.

**See**: `browser-extension/detect.js` (`pageRoleForUrl`, `supportedPortalForUrl`),
`browser-extension/{content-script,background,popup}.js`, `browser-extension/popup.html`,
`dashboard/__tests__/extension-detect.test.ts`; issue #237; D-043, D-053, D-069.
