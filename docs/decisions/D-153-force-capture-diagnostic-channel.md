---
id: D-153
title: "Forzar captura + diagnóstico — a separate diagnostic channel, never an ingest path"
date: 2026-08-21
group: Data / connectors
rule: "Extension diagnostics write ONLY to extension_diagnostic, never extension_capture; the reported isRenderReady verdict is isRenderReadyDetail's own output, never re-derived."
---

# D-153: "Forzar captura + diagnóstico" — a separate diagnostic channel, never an ingest path

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
that sends any page's HTML plus what the extension thought about that page.

**Scope note — what this record does NOT cover.** A same-day follow-up added
opt-in network capture (a MAIN-world `fetch`/XHR wrapper armed before an
owner-initiated reload, so an SPA's real data is visible). The fresh-context
review of PR #675 found its armed-recorder lifecycle unshippable — the
recorder outlives the diagnostic send and survives browser restarts — and the
button was removed before merge. The pure redaction module and its tests were
kept, unreachable, for a rebuild. **No decision is recorded here about network
capture**; the analysis, the redaction audit and the exit criteria live in
issue #684, and what shipped from it is recorded in
[D-164](D-164-network-capture-armed-lifecycle.md). In particular, an earlier
draft of this file asserted that "a recorder can never outlive the diagnostic
send it exists for" — that was **false as written**, which is exactly why the
half it described did not ship. **And read D-164 point 5 before quoting point 6
or this record's summary about credentials**: a captured response BODY is
truncated and scrubbed of three credential shapes, not sanitised, so
`extension_diagnostic.network` can carry whatever personal data a portal's own
API returned.

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

4. **Ungated by host, therefore confirmed by URL.** Because point 3 means the
   button will happily send ANY page — the unclassifiable ones are the whole
   point — one misclick with a bank or webmail tab focused would upload that
   page's fully-rendered, authenticated DOM. So the click opens a `confirm()`
   naming the exact URL about to be sent before anything is read from the
   tab. The gate is the prompt, never a host allowlist: an allowlist would
   re-break the requirement it exists to satisfy.

5. **Nothing reaches `jsonb` unsanitised.** `insertDiagnostic` deep-strips
   U+0000 from `detection`/`network` (keys and values) before serialising.
   The route's `stripNulBytes` on `url`/`html`/`title` cannot cover them:
   `JSON.stringify` ESCAPES a NUL instead of emitting it raw, so sanitising
   the serialised text is a silent no-op while Postgres still rejects the
   whole INSERT with "unsupported Unicode escape sequence". That is the same
   production 500 issue #207 / PR #563 closed for `text`, one layer in.
   Sanitising in the DB helper rather than the route makes the guarantee
   hold for every caller.

6. **Retention is unconditional in kind, bounded in time.** `html` is
   `NOT NULL` on `extension_diagnostic` and is kept regardless of connector
   calibration state or #670's `etl.retain_capture_html_for` config (which
   only ever governs `extension_capture.html`, a different column on a
   different table) — that unconditional keeping is the feature. But every
   row is a whole third-party page (~350 KB) that routinely carries owner
   names and phone numbers, so `purge_extension_diagnostics(retention_days
   INT DEFAULT 30)` puts a floor under it, shaped exactly like this schema's
   existing `purge_stale_owner_identities()` (same signature, same returned
   count, same plpgsql CTE). It DELETEs rather than nulling columns because
   nothing anywhere references a diagnostic row. 30 days rather than
   owner_identity's 90: a diagnostic exists to unblock one investigation
   that is in practice in progress the same week, and anything worth keeping
   longer belongs in a scrubbed fixture. Mechanism only — no caller wired up
   yet, same as `purge_stale_owner_identities`. Per-row deletion via
   `/admin/diagnostics` stays the way to drop one on purpose.

7. **Retrieval without SQL: an admin list page, a JSON view, and a download
   route — not a CLI export.** `/admin/diagnostics` lists recent diagnostics
   (portal detection, the `isRenderReady` verdict + selector + REASON, the
   harvest anchor/detail-URL counts, the D-142 block verdict, size, storage
   total). `GET /api/admin/diagnostics/[id]?format=json` returns the whole
   stored row EXCEPT `html`, so no field of the payload is SQL-only — the
   list can only ever be a summary, and issue #671's "he should not need
   SQL" is about the payload, not about the six fields that happen to fit on
   a row. The raw HTML alone is served as a DOWNLOAD
   (`Content-Disposition: attachment`, `application/octet-stream`,
   `X-Content-Type-Options: nosniff`), never rendered inline in the
   dashboard's own origin — a captured page is untrusted third-party content
   that may carry live `<script>` tags; downloading it (opened outside this
   origin, with no `ps_admin` cookie) is what keeps it from ever running with
   the admin session's credentials. `html` is excluded from the JSON view for
   the same reason, and because a browser renders a JSON response inline. A
   CLI export was considered and rejected: the admin surface reuses the
   existing `/admin/*` auth/nav machinery for free and the owner already
   works from the dashboard when following up on a connector bug.

**Alternatives rejected**:
- Reusing `extension_capture` with a status flag ("diagnostic") — rejected:
  every future `WHERE status = ...` on that table would need to remember to
  exclude it forever; a separate table makes the exclusion structural.
- Gating the button to supported hosts to avoid the misclick risk of point 4
  — rejected: it would defeat the requirement the feature exists for. A
  confirm() costs one click and keeps the reach.
- Sanitising the serialised JSON string at the route alongside
  `url`/`html`/`title` — rejected because it does not work; see point 5.
- Leaving retention manual ("prune via the delete button") — rejected: an
  unbounded store of third-party pages containing personal data is not a
  debugging aid, and this schema already had the purge pattern to copy.
- A CLI export instead of the admin surface — see point 7.

**Rationale**: a diagnostic feature that could itself become a second,
sloppier ingest path would be worse than not having it — the value here
(three real investigations unblocked in one click) only holds if
"diagnostic" stays structurally, testably true throughout.

**See**: `browser-extension/diagnostic.js`, `browser-extension/detect.js`
(`isRenderReadyDetail`), `browser-extension/popup.js`, `etl/schema/init.sql`
(`extension_diagnostic`, `purge_extension_diagnostics`),
`dashboard/app/api/extension/diagnostic/route.ts`,
`dashboard/app/api/admin/diagnostics/[id]/route.ts`,
`dashboard/lib/db/extension-diagnostics.ts`,
`dashboard/lib/strip-nul-bytes.ts`, `dashboard/app/admin/diagnostics/page.tsx`,
D-111, D-121, D-124, D-142, issues #671 and #684, PR #675.
