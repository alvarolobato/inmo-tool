---
id: D-053
title: Batch capture is discoverable — in-page banner + app auto-start signal, no popup hunting
date: 2026-08-05
group: Data / connectors
rule: 'Batch capture must be discoverable on a rendered listing page without popup-hunting: an always-available in-page banner (`buildCaptureBanner`) + the app''s `#inmo-capture` auto-start signal (`withCaptureSignal` ↔ `captureSignalPresent`, byte-for-byte contract). Both reuse the D-043 queue verbatim. Auto-start requires the app signal (human-initiated); direct-opened listings get the banner.'
order: 55
---

# D-053: Batch capture is discoverable — in-page banner + app auto-start signal

*Decided: 2026-08-05*

**Context**: Issue #297. Live owner testing (2026-08-05): the owner clicked
"Abrir búsqueda" on `/captura`, the Idealista search page opened, and "nothing
happened". Detection already worked (`isListingPath` matched the search URL),
but the batch harvest ("Capturar todas (N)") only lived inside the **extension
popup** and had to be found and clicked manually. Opening the popup was not
discoverable — the owner reasonably expected capturing to just start after
"Abrir búsqueda". The gap was purely trigger discoverability, not detection.

**Decision**: A recognized SEARCH/LISTING page (per `listingPortalForUrl`),
once rendered, must offer batch capture without the owner opening the popup, via
TWO mechanisms, both reusing the existing batch queue (D-043) verbatim — they
only decide WHEN to fire `START_BATCH`:

1. **In-page banner (manual fallback, always available).** The content script
   injects a small, fixed, Inmo-Tool-branded, dismissible banner ("Inmo-Tool:
   capturar las N propiedades de esta búsqueda" + "Capturar todas"), built by
   the pure `InmoDetect.buildCaptureBanner(doc, …)`. N =
   `extractDetailUrls(...).length`. Its button sends the SAME `START_BATCH`
   message the popup sends. Styled at max z-index, fixed-position, so it can't
   be confused with the portal's own UI and never blocks content; auto-hides on
   batch start or dismiss. Available regardless of the detail auto-capture kill
   switch (it is a manual button).

2. **App auto-start signal (one click from the app).** The dashboard's "Abrir
   búsqueda" (`/captura` `onExecute`) tags the opened URL with the signal
   `#inmo-capture` (fragment; query-key `?inmo-capture` fallback when the URL
   already has a fragment) via `lib/extension-capture.ts withCaptureSignal`,
   which NEVER breaks the URL (returns the input unchanged on a parse failure).
   On a recognized listing page carrying the signal, the content script
   AUTO-STARTS the batch once rendered — respecting the existing render-ready
   wait, the bounded-concurrency/jittered pacing, and the same guards. The extension
   reads the signal with the pure `InmoDetect.captureSignalPresent` /
   `listingCaptureAction`.

**The signal string is a binding cross-component contract**: the dashboard
writer (`withCaptureSignal` / `CAPTURE_SIGNAL`) and the extension reader
(`captureSignalPresent` / `CAPTURE_SIGNAL` in `browser-extension/detect.js`)
MUST agree byte-for-byte. Change one only by changing both.

Auto-start still requires the app-supplied signal (an explicit "Abrir búsqueda"
click), so capture stays human-initiated in spirit — no unattended crawling. A
listing page opened directly (no signal) gets the manual banner, never a silent
auto-start.

**Alternatives rejected**: A cheap stopgap instruction on the Captura page
("open the popup → Capturar todas") — rejected as the primary fix (issue option
3): it still makes the owner hunt in the popup. Auto-starting on ANY recognized
listing page without a signal — rejected: it would crawl any search page the
owner merely browses, violating the human-initiated principle.

**See**: issue #297 (part of #237, relates to #262/#279/#289);
`browser-extension/detect.js` (`captureSignalPresent`, `listingCaptureAction`,
`buildCaptureBanner`), `browser-extension/content-script.js` (listing wiring),
`dashboard/lib/extension-capture.ts`, `dashboard/app/captura/page.tsx`;
D-043 (the batch queue this reuses), D-045/D-048 (the `/captura` execution page).
