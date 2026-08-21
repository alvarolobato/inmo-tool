---
id: D-153
title: "Forzar captura + diagnóstico—separate diagnostic channel, MAIN-world network capture, never an ingest path"
date: 2026-08-21
group: Data / connectors
rule: "\"Forzar captura + diagnóstico\" (issue #671) writes ONLY to extension_diagnostic (own table, no FK/trigger, nothing reads it) via /api/extension/diagnostic — never extension_capture. isRenderReady's verdict is D.isRenderReadyDetail's own output, never re-derived. Opt-in network capture wraps fetch/XHR in a MAIN-world script (no chrome.debugger), redacting credentials and capping bodies IN THE BROWSER before anything is sent."
---

# D-153: "Forzar captura + diagnóstico" — separate diagnostic channel, MAIN-world network capture, never an ingest path

*Decided: 2026-08-21*

**Context**: Three separate investigations in one week (#654 idealista's 3-of-30
photo gallery, #547 Hipoges extracting nothing, a Hipoges results page
harvesting 0 of 17 listings) all depended on captured page HTML surviving BY
ACCIDENT — a purge that hadn't run yet, an uncalibrated connector that
happens to retain HTML, a failed capture (failures retain HTML, successes
don't). The recurring bug SHAPE: the extension snapshots the DOM before
client-rendered content exists. Hipoges' results page captured an empty
Angular shell — `init-front-list` present, zero `/detail/` links, zero
prices — because `isRenderReady` is satisfied by the GENERIC `main` fallback
selector alone (no portal-specific `readySelectors` exist yet for Hipoges,
D-111). The owner asked for a one-click "forzar captura + diagnóstico" button
that sends any page's HTML plus what the extension thought about that page —
and, in a same-day follow-up, for the underlying REST calls too (Angular/React
apps fetch their real data by XHR after the initial render; the DOM can never
contain what a network response delivered), explicitly accepting that this
requires a reload (the fetch/XHR wrapper must install before the app boots).

**Decision**:

1. **A dedicated table and route, never `extension_capture`.**
   `extension_diagnostic` (etl/schema/init.sql) has no FK from
   `capture_worklist`, no trigger, and is read by nothing in `etl/capture.py`
   or any other processing path. `POST /api/extension/diagnostic` is the only
   writer. This is stronger than "mark it unmistakably" (the issue's stated
   minimum bar) — a genuinely separate table structurally cannot be
   mistaken for an ingest row by any future code that queries
   `extension_capture`. Verified by a real-Postgres integration test
   (`diagnostic-no-ingest.integration.test.ts`) asserting `listing` /
   `capture_worklist` / `extension_capture` are byte-for-byte unchanged
   (including a seeded listing's own `status`/`last_seen_at`/`current_price`)
   after a diagnostic POST.

2. **One shared `isRenderReady` computation, never two.**
   `detect.js`'s `isRenderReady(doc, portal)` becomes a thin boolean wrapper
   over a new `isRenderReadyDetail(doc, portal)`, which returns
   `{ready, selector, reason, bodyTextLength}` — `selector` is WHICH
   `readySelectors` entry satisfied the check, the exact field that would
   have explained the Hipoges empty shell instantly. `diagnostic.js`'s
   `buildDiagnosticBlock` calls `isRenderReadyDetail` directly; every
   auto-capture caller (`content-script.js`'s `pollUntilReady`,
   `handleListingWhenReady`, `detectBlockSignals`'s corroboration step) keeps
   calling `isRenderReady`, which now delegates to the SAME function. A test
   (`extension-diagnostic.test.ts`) asserts the diagnostic's `renderReady`
   field `toEqual`s a direct `isRenderReadyDetail` call on the same fixture.

3. **Works on any page, by construction, not by special-casing.**
   `diagnostic.js` composes only functions from `detect.js` that already
   degrade to null/false for an unrecognised page (`detailPortalForUrl`,
   `pageRoleForUrl`, `detectBlockSignals`, etc.) — there is no
   "is this a supported portal" gate anywhere in the diagnostic path. The
   popup's footer button lives OUTSIDE every `#state-*` panel `showState()`
   toggles, so it's reachable regardless of what the popup's main state is
   showing (unsupported host, guide panel, validation panel, a blocked
   page). Tested across supported-detail, supported-listing (the Hipoges
   shell case), unsupported-host, and challenge-page fixtures.

4. **Network capture: a MAIN-world fetch/XHR wrapper, not `chrome.debugger`.**
   `chrome.debugger` would show a permanent "being debugged" infobar on every
   tab it's used on — too heavy for an occasional diagnostic tool, and this
   extension has never requested it. Instead: `network-recorder-main.js`
   (installed via `chrome.scripting.registerContentScripts`, `world:"MAIN"`,
   `run_at:"document_start"`, scoped to exactly ONE origin for ONE session)
   wraps `window.fetch`/`XMLHttpRequest` before the page's own bundle runs.
   This is why the reload is unavoidable and MUST be explicit/owner-initiated
   (a `confirm()` naming what it does) — never silent. The host permission
   for that origin is requested via `chrome.permissions.request` from
   **popup.js itself** (a real user-activation signal) and only verified
   (`chrome.permissions.contains`) in the background — a service worker has
   no user-activation signal, so requesting it there would silently fail.
   `armNetworkRecording`/`disarmNetworkRecording` in `background.js` own the
   registration lifecycle; `disarmNetworkRecording` is called
   UNCONDITIONALLY by `SEND_DIAGNOSTIC`, so a recorder can never outlive the
   diagnostic send it exists for (a recorder left running silently would be
   both a privacy and a storage problem).

5. **Redaction happens IN THE BROWSER, before anything is sent — never a
   second redaction pass server-side.** `network-recorder.js` (pure, loaded
   into both the MAIN-world page and the service worker via `importScripts`,
   unit-tested without a browser) strips `Authorization`/`Cookie`/
   `Set-Cookie` and any credential-shaped header/query-param name OUTRIGHT
   (removed, never masked-but-present) and caps response bodies at
   `MAX_BODY_BYTES` (20 KB) with truncation always reported explicitly. This
   is the guard against becoming a D-033-style back door: Cimenta2 was ruled
   not-buildable because its only data path over-exposed confidential/PII
   fields, "even scoped" — a network recorder must never become an
   unscoped one. Entries are capped to `MAX_ENTRIES` (200), keeping the MOST
   RECENT (the ones nearest the moment the owner clicked send). This is a
   DIAGNOSTIC tool: it records what the owner's own browser already
   requested, never issues or replays a request itself (issue #1 §15 /
   D-033 / D-075's no-evasion rule extends naturally here).

6. **Retention is unconditional and independent of #670.** `html` is
   `NOT NULL` on `extension_diagnostic` (no purge column, no
   `etl.retain_capture_html_for` interaction at all — that config only ever
   governs `extension_capture.html`, a different column on a different
   table). Pruning is manual only, via `/admin/diagnostics`'s delete button
   (`DELETE /api/admin/diagnostics/[id]`) — no automatic expiry.

7. **Retrieval without SQL: an admin list page + a download route, not a CLI
   export.** `/admin/diagnostics` lists recent diagnostics (portal
   detection, the `isRenderReady` verdict + selector, the D-142 block
   verdict, size, network entry count) and shows total storage used. The raw
   HTML is served as a DOWNLOAD (`Content-Disposition: attachment`), never
   rendered inline in the dashboard's own origin — a captured page is
   untrusted third-party content that may carry live `<script>` tags;
   downloading it (opened outside this origin, with no `ps_admin` cookie) is
   what keeps it from ever running with the admin session's credentials. A
   CLI export was considered and rejected: the admin surface reuses the
   existing `/admin/*` auth/nav machinery for free and the owner already
   works from the dashboard when following up on a connector bug.

**Alternatives rejected**:
- Reusing `extension_capture` with a status flag ("diagnostic") — rejected:
  every future `WHERE status = ...` on that table would need to remember to
  exclude it forever; a separate table makes the exclusion structural.
- `chrome.debugger` for network capture — rejected: permanent "being
  debugged" infobar, a much heavier permission grant than this feature
  warrants.
- Declaring the network-recorder scripts statically in `manifest.json`'s
  `content_scripts` — rejected: that would run the fetch/XHR wrapper on
  every load of the 4 supported hosts, not just an explicitly armed session,
  and couldn't reach unsupported hosts at all (this issue's own "works on
  any page" requirement).

**Rationale**: a diagnostic feature that could itself become a second,
sloppier ingest path or a network back door would be worse than not having
it — the value here (three real investigations unblocked in one click) only
holds if "diagnostic" stays structurally, testably true throughout.

**See**: `browser-extension/diagnostic.js`, `browser-extension/detect.js`
(`isRenderReadyDetail`), `browser-extension/network-recorder.js`,
`browser-extension/network-recorder-main.js`,
`browser-extension/network-recorder-relay.js`, `etl/schema/init.sql`
(`extension_diagnostic`), `dashboard/app/api/extension/diagnostic/route.ts`,
`dashboard/app/admin/diagnostics/page.tsx`, D-033, D-075, D-142, issue #671.
