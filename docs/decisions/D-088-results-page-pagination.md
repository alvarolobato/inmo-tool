---
id: D-088
title: Batch capture paginates every results page by rendering each in the authenticated session, not by fetch
date: 2026-08-06
group: Data / connectors
rule: Batch capture ENUMERATES every results page before capturing — walk pages 1..RESULTS_PAGE_CAP (40) by RENDERING each in one reused, activated tab in the operator's authenticated session (a background fetch returns an empty SPA shell for Aliseda / a WAF 403 for Idealista+Altamira), harvesting detail URLs + the next-page URL from the live DOM. Per-portal next-page URL is a pure helper in detect.js (idealista `/pagina-N.htm`, verified; aliseda/altamira best-effort `?pagina=N` with a rendered-DOM 'siguiente' fallback). Pace results-page loads with the same jitter as capture; stop on no-new / no-next / cap.
order: 63
---

# D-088: Batch capture paginates every results page by rendering each in the authenticated session, not by fetch

*Decided: 2026-08-06*

**Context**: The extension's batch capture (D-043) harvested detail links off **only the current results page's DOM** — so a search spanning N pages captured just page 1 (~20-30 of N results). The owner reported this on Aliseda; it affected all three capture portals (idealista, aliseda, altamira). There was no next-page logic anywhere in `detect.js` / `background.js` / `batch.js` (issue #362).

The obvious fix — "for each results page do a same-origin `fetch(pageUrl)` and parse its HTML for detail links" — was **verified against the live portals and found infeasible for the reported case**:
- **Aliseda** is a client-side-rendered Angular SPA: the server ships an empty `<app-root>` with zero anchors, so a raw fetch of any results URL returns nothing to parse.
- **Idealista** (Datadome) and **Altamira** (Akamai) return `403` to any non-session request — a background/service-worker fetch never sees the results HTML.
- Only **Idealista** exposes a clean, verifiable pagination URL scheme: `/pagina-N.htm` appended to the search path (confirmed from its `robots.txt`, which disallows the `/*/pagina-*.htm` family). Aliseda/Altamira expose no statically determinable page-N URL.

**Decision**:
1. **Pure per-portal pagination helpers in `detect.js`** (unit-tested, no DOM/chrome): `resultsPageUrl(url, n)` / `nextResultsUrl(url)` / `currentResultsPage(url)`, plus `nextResultsUrlFromHrefs(hrefs, currentUrl, portal)` (the rendered-DOM "siguiente" fallback). Idealista uses the verified `/pagina-N.htm` path scheme; Aliseda/Altamira use a best-effort `?pagina=N` query scheme, but the walk **prefers the next-page URL read from the rendered DOM** when present. `RESULTS_PAGE_CAP = 40`.
2. **Enumeration walk in `background.js`**: on batch start, seed page-1 (as before), then walk pages 1..CAP by **rendering each in ONE reused, `active:true` tab** in the operator's authenticated session (the only reliable enumeration for a CSR/WAF portal — the same reason the extension exists, and the same reason capture activates its tabs per D-043's render-throttling constraint). Per page, the content script (`HARVEST_LISTING_PAGE`) waits for render, then returns the harvested detail URLs + the next-page URL. The background dedups by `matchKey`, seeds each page's fresh URLs into the worklist incrementally, and paces results-page loads with the same jittered dwell capture uses. It **stops** when: a page past the first yields no NEW detail URLs, the next-page URL is absent (last page / infinite scroll / no numbered pagination), the cap is reached, or the run is stopped. Only then is the capture queue (D-043) built from the portal's full pending set and run.
3. **UX**: a distinct `enumerating` phase (session key `inmoBatchEnum`) surfaces a growing discovered-count in the popup ("N anuncio(s) encontrados…") so the UI never freezes while pages are discovered; it transitions to the normal N/M capture progress once enumeration completes.

**Alternatives rejected**:
- *Same-origin `fetch(pageUrl)` + parse* (the issue's first suggestion): returns an empty shell for the CSR portal (Aliseda, the reported case) and a WAF 403 for the others from a non-session context. It would "fix" only Idealista while silently no-op'ing the portal the owner actually reported.
- *Guessing Aliseda/Altamira page-N URL schemes and navigating blindly*: neither exposes a statically verifiable scheme; a wrong guess re-serves page 1 → the walk's no-new-URLs stop condition ends it after one page. The rendered-DOM "siguiente" fallback is the robust path, with the query-param guess only as a backstop.
- *Opening the enumeration tab in the background (`active:false`)*: Chrome throttles background-tab rendering (D-043), so a CSR results page would not paint and harvest nothing. The tab must be activated, exactly as capture does.

**Rationale**: Rendering in the real session is the only mechanism that enumerates a client-side-rendered portal (Aliseda) and passes the WAFs (Idealista/Altamira) — it reuses the session the operator already cleared. The pure URL helpers stay unit-testable and give Idealista a deterministic, verified scheme; the rendered-DOM fallback covers the portals without one. The bounded cap + jittered pacing keep the walk WAF-safe and prevent a runaway loop, consistent with D-043.

**Residual limitation**: if a portal renders its results with **infinite scroll** (no numbered next-page anchor and no clean URL scheme), the walk enumerates only page 1 — no regression versus the prior behaviour, and a scroll-to-load-more enumeration is a possible follow-up. Aliseda's exact rendered pagination markup could not be verified statically (SPA); the rendered-DOM fallback recognises `?pagina=`/`?page=`/`?pag=` and `/pagina-N` / `/pagina/N` anchors.

**See**: issue #362; `browser-extension/detect.js` (pagination helpers), `browser-extension/background.js` (`enumerateResultsPages` / `renderAndHarvest`), `browser-extension/content-script.js` (`HARVEST_LISTING_PAGE`); `dashboard/__tests__/extension-detect.test.ts`; [D-043](D-043-batch-capture-auto-advance.md) (bounded-concurrency capture queue + render-throttling), [D-019](D-019-aliseda-not-viable-disallowed-api.md) (Aliseda not server-side viable).
