---
id: D-142
title: Extension block/challenge detection stops the run, alerts once, reports as a D-047 clean notice
date: 2026-08-20
group: Data / connectors
rule: "Extension block detection (detect.js) requires !isRenderReady corroboration, serializes/scopes the per-portal pause, TTL-expires episodes, and retries dropped dashboard reports."
---

# D-142: Extension block/challenge detection stops the run, alerts once, reports as a D-047 clean notice

*Decided: 2026-08-20*

**Context**: Issue #634. The extension's whole value is unattended running
(#587/D-134 made Auto survive a browser restart and re-fire), which amplifies
one specific failure: if a portal starts challenging the extension at 03:00,
it used to grind on, capture nothing, and the owner would find out days later
from stale data. There was no block detection anywhere in the extension —
CAPTCHA/WAF only appeared in comments explaining why D-043's concurrency is
bounded. Two real hits already existed to ground the signatures against:
idealista's DataDome CAPTCHA wall (`captcha-delivery.com`, every request,
regardless of UA — `docs/skills/connectors.md`) and a live GeeTest "Pardon Our
Interruption" wall hit twice during #628 (same tech any of this extension's
portals could equally sit behind; its confirmed marker set is already recorded
in `milanuncios_sample_soft_block_page.html` for the server-side connector).

The hard part is separating three things that all produce "no data": a real
block (stop + alert), a genuinely empty search (continue, no alert), and a
gone/404 listing (skip, count, continue — mirrors D-049). Getting the
false-positive direction wrong makes the alert worthless (training the owner
to ignore it); getting the false-negative direction wrong wastes a night and
can deepen a ban.

**Decision**:

1. **Detection is a small, portal-agnostic DOM-marker library, not per-portal
   selectors — and a marker alone is never enough.** `browser-extension/
   detect.js`'s `detectBlockSignals(doc, portal)` checks seven documented
   signatures — Cloudflare's challenge (primarily its language-independent
   `/cdn-cgi/challenge-platform/` orchestration script, never the Turnstile
   *widget* script a portal can legitimately embed in a contact form), the
   DataDome/`captcha-delivery.com` wall, GeeTest's "Pardon Our Interruption"
   (`#captcha-box`, `static.geetest.com`), a generic Incapsula JS challenge
   (`_Incapsula_Resource`), Akamai's static deny page (title "Access Denied" +
   a "Reference #" id), a generic WAF-403 page ("Acceso denegado"/"Access
   Denied"/"Forbidden"), and a login/session wall (a password field plus
   session-wall copy) — returning the FIRST match as `{blocked: true,
   signature: <id>}` or `{blocked: false, signature: null}` for anything
   else. Every `matches()` is individually try/caught so one bad check can
   never crash detection or block a later signature.

   **A candidate match only counts once `!isRenderReady(doc, portal)`** — the
   SAME render-readiness heuristic auto-capture already trusts to know a page
   painted its real content (see the 2026-08-21 amendment below for why: a
   fresh-context review ran its own adversarial fixtures and found four
   healthy pages — a Turnstile widget, a defensively-loaded Incapsula/DataDome
   tag, listing copy merely mentioning a challenge phrase, a contact widget
   using `id="captcha-box"` — reading as blocked). An unrecognised page is
   still the safe default — this is what keeps a genuinely empty search or a
   404/removed listing from ever matching (see the false-positive tests in
   `extension-block-detect.test.ts`, including the "healthy page with a
   plausible marker" cases), since neither carries any of these markers by
   construction, corroborated or not.
2. **Detection runs everywhere a page renders, independent of any active run.**
   `content-script.js`'s `checkForBlock()` fires on initial load (before
   validation-mode resolution — a challenge outranks every other decision on
   the page) and on every SPA route change; a second, last-moment check runs
   again immediately before the detail auto-capture flow snapshots the DOM
   (`waitForQuiescenceThenFire`'s `done()`), so a challenge injected AFTER the
   page's initial render can never get ingested as if it were real listing
   data. A match posts `BLOCK_DETECTED {portal, signature}` to the background
   worker — detection is decoupled from whether a batch/auto run happens to be
   active.
3. **Stop the run — pause, never drain, and SCOPED to the portal that's
   actually running.** `background.js`'s `handleBlockDetected` records the
   episode (`InmoBatch.recordBlock`, below), and if a batch loop is actually
   driving (`batchLooping`) AND the currently-driving batch's own `portal`
   field (now carried on batch state — see amendment) matches the blocked
   portal (or is `null`, an unrestricted Auto drain with no single portal to
   attribute), pauses it via the SAME `mutateBatch(InmoBatch.pause)`
   PAUSE_BATCH already used — never `stop()`/STOP_BATCH, which drains the
   pending-search queue (D-112), and never a DIFFERENT portal's run (see
   amendment — `checkForBlock` fires on every render, including an unrelated
   manual tab). A block detected mid-ENUMERATION (before a capture batch
   state even exists) is represented as an already-PAUSED batch built from
   whatever detail URLs were already seeded, for the same reason: a bare
   cleared enum claim would read as idle to
   `isBatchActive()`/`advanceQueueIfIdle` and silently pop the next queued
   search, which is exactly the "grind on" this issue exists to prevent.
   Every pending/in-flight URL and the whole search queue (D-112) survive
   untouched — a resume (the existing RESUME_BATCH control) picks up exactly
   where it left off.
4. **One alert per episode, not per tab — race-free under concurrency.**
   `batch.js`'s `recordBlock(state, portal, signature, now)` is idempotent
   while a portal's episode is active and non-expired — a second (or
   twentieth) detection returns `isNewEpisode: false` and the state is
   untouched (not even `detectedAt`/`signature` are overwritten, since they
   describe when the episode STARTED). `handleBlockDetected` reads, records,
   AND claims the report attempt all inside ONE `runBatchStateExclusive`
   critical section (the same serializer every other shared-state mutation
   in `background.js` already uses) — see the amendment for why a
   post-hoc/in-memory decision isn't enough under D-043's real concurrency
   (up to 8 tabs can render the same challenge within milliseconds of each
   other). `chrome.notifications.create` (needs the new `notifications`
   manifest permission) and the dashboard POST fire only for the winning
   claim. An episode resolves via `clearBlock`, called ONLY after a REAL
   capture succeeds for that portal (`EXTRACT`'s success handler, dispatched
   through the real `chrome.runtime.onMessage` listener) — never merely
   because one render didn't show a marker, since an absent marker on a
   single page is not proof of recovery (the challenge page might not render
   identically every time) — OR once the episode ages past
   `BLOCK_EPISODE_TTL_MS` (2h; see amendment). The NEXT detection after a
   clear or an expiry is treated as a fresh episode and alerts again.
5. **The popup's armed-status line must never say "armed" while blocked**
   (D-134's truthful-state principle, extended). `getAutoProgress()` attaches
   `blocked: activeBlockSummary()` regardless of whether Auto is on;
   `popup.js`'s `renderAutoArmedStatus` renders the blocked line FIRST,
   overriding both the ON and the OFF cases.
6. **Report as a D-047 clean notice, not a new error vocabulary.** `POST
   /api/extension/block-episode` (admin-gated exactly like `/capture` and
   `/heartbeat`) accepts only `{portal, signature, detectedAt}` — never page
   content or the captured URL — and writes one row to the new
   `extension_block_episode` table. `/etl/salud` renders recent episodes
   (`getRecentBlockEpisodes`, `ExtensionBlocksSection`) with the SAME "info"
   badge / "Parada limpia" styling a connector's own soft-block clean-stop
   gets (`hasCleanNotice`) — a block the extension detects reads the same way
   in the dashboard as one a connector detects, per the issue's explicit ask
   to not invent a second vocabulary.
7. **No evasion path anywhere in this diff.** Every check in
   `detectBlockSignals` is read-only DOM inspection — no header/identity
   changes, no retry-with-different-fingerprint, no CAPTCHA-solving. This
   exists so the human goes and satisfies the challenge legitimately (issue #1
   §15, D-033, D-075) — the opposite of circumvention.

**Alternatives rejected**:
- *HTTP-status-based detection (a `webRequest` listener reading real response
  codes).* Rejected for this pass: a genuine network-level block (no response
  body, Chrome's own error page) never runs a content script at all, so there
  is nothing for `detectBlockSignals` to see regardless of `webRequest` — and
  the two real hits this issue is grounded in (DataDome, GeeTest) both render
  a normal HTTP 200 page with a captcha body, which DOM inspection already
  catches without the extra permission surface.
- *A long, portal-specific selector list.* Rejected per the issue's own
  guidance — signatures rot as portals change; a handful of robust,
  documented, cross-portal markers (three of which are ALREADY grounded in
  real captured evidence — D-026/D-027's WAF spikes, #628's GeeTest hit) beats
  a brittle list that needs updating every time a portal's markup shifts.
- *Clearing a block on the absence of a marker on one render.* Rejected — an
  absent marker proves nothing (the challenge page's own markup could vary,
  or the page could be blank/erroring in some OTHER unrecognised way); only a
  genuine forward-progress signal (a real capture reaching the server) is
  trustworthy enough to resolve an episode.
- *A second "blocked" status value in `connector_run_results`-style
  vocabulary.* Rejected — the issue explicitly asks to align with D-047
  rather than invent a second one; a dedicated `extension_block_episode` table
  plus the existing "info notice" rendering does the job without touching the
  connector-side schema at all.

**Rationale**: The response half (stop cleanly, alert exactly once, make the
reason visible, never grind) matters as much as the detection half — a false
alarm at 03:00 trains the owner to ignore the channel; a missed block wastes a
night and can deepen a ban. Reusing D-043's existing PAUSE (never a new
stop/drain path) and D-047's existing clean-notice vocabulary (never a new
status enum) means this feature adds one new detection surface and one new
report table, not a second parallel state machine to keep in sync with the
first.

**Amendment (2026-08-21, PR #637 fresh-context review)**: the first cut of
this decision had four BLOCKERS, all fixed in place (this file rewritten to
describe the fixed behavior directly; this amendment records what changed and
why, for archaeology):

- **B1 — the detection itself cried wolf.** The reviewer's own adversarial
  fixtures found four HEALTHY pages (a Turnstile widget in a contact form, a
  defensively-loaded Incapsula/DataDome tag, listing copy merely mentioning a
  challenge phrase, a contact widget using `id="captcha-box"`) reading as
  blocked, and two genuine blocks (a login/session wall, a Spanish "Acceso
  denegado" WAF page) reading as healthy — plus a Cloudflare interstitial
  with a localised (non-English) title going undetected. Fixed by requiring
  **corroboration**: every candidate marker now only counts once
  `!isRenderReady(doc, portal)` (point 1, above) — the cheap fix the review
  itself proposed, costing no true positives since a genuine interstitial
  never renders real content. The Cloudflare check was ALSO re-targeted at
  the language-independent `/cdn-cgi/challenge-platform/` script path
  (distinct from the Turnstile widget's `/turnstile/v0/api.js` on the same
  host) rather than relying on the English title as primary evidence. Two new
  signatures (`waf_denied`, `session_wall`) close the two false-negative
  gaps. The false-positive test suite was rewritten to include "a healthy
  page that contains a plausible marker" fixtures — the class of case the
  original tests, built from markerless pages, could never have caught.
- **B2 — the alert wasn't race-free under real concurrency.**
  `handleBlockDetected`'s read-modify-write of block state (and, once added,
  the "should I retry the dashboard report" decision) had no serializer,
  while every OTHER shared-state mutation in `background.js` already used
  `runBatchStateExclusive` for exactly this reason. D-043's bounded
  concurrency (up to 8 tabs) means a WAF flip is per-egress-IP, not per-tab —
  every in-flight tab can render the same challenge within milliseconds of
  each other, which is the NORMAL case, not an edge one. Measured: 8
  concurrent detections produced 8 notifications before the fix. Both the
  episode record AND the report-retry claim (`reportInFlight`, an in-memory
  Set) are now decided atomically inside ONE `runBatchStateExclusive` section
  per `handleBlockDetected` call.
- **B3 — the two most safety-critical paths had no test that could fail.**
  Reverting the post-enumeration paused-batch branch, or reverting
  `enumerationStopped(portal)`'s portal-awareness, left the full 4442-test
  suite green; the `EXTRACT` success handler's `clearBlockIfActive` call was
  only ever exercised by calling the function directly, never through the
  real `chrome.runtime.onMessage` dispatch. `extension-block-detection.test.ts`
  now drives both through the REAL code path: a real (mocked)
  `chrome.tabs.create`/`onUpdated`/`sendMessage`-driven enumeration walk that
  detects a block mid-walk (after page 1 already harvested something) and
  asserts page 2 never renders and no capture tab opens; and dispatching a
  real `EXTRACT` message through the actual registered listener.
- **B4 — the pause was portal-UNCONDITIONAL even though the episode is
  per-portal.** `checkForBlock` runs on every render, including an unrelated
  manual tab — an idealista challenge could pause an in-flight ALISEDA run.
  Fixed by carrying `portal` on batch state itself (`makeBatchState`'s new
  4th argument; `null` for an unrestricted Auto drain spanning several
  portals, where pausing on any block remains the conservative fallback) and
  checking it before pausing.

Also fixed, same review, lower severity:
- **A stuck-forever episode could silently kill Auto.** `clearBlock` only
  ever fires on a real `EXTRACT` success, but a block detected mid-enumeration
  with zero already-seeded URLs produces a paused batch with NOTHING to ever
  capture — no EXTRACT, no clear, ever. Fixed with `BLOCK_EPISODE_TTL_MS`
  (2h): `isPortalBlocked`/`blockEntry` treat an entry past its TTL as
  resolved even without an explicit clear, and the next detection after
  expiry is a genuinely NEW episode (re-alerts). Bounds "silent forever" to
  "silent at most 2h, then either a real recovery or a fresh alert."
- **A dropped dashboard report was lost permanently.** `reportBlockEpisode`
  never checked `response.ok`, so a failed POST (dashboard down, 401, 500)
  was indistinguishable from success and the `isNewEpisode` gate would then
  silence every future attempt. Fixed: the response is checked and a
  `reported: boolean` field (`markBlockReported`) tracks delivery per
  episode; a later detection for the same still-active, unreported episode
  retries the POST (never re-notifying locally) — reproduced live and fixed
  by the review's own request for a retry test.
- **`chrome.notifications.onClicked` was missing** — clicking the alert did
  nothing. Added: it opens `/etl/salud` in a new tab.
- **`/etl/salud`'s block section had no time bound.** `getRecentBlockEpisodes`
  is LIMIT-20-only with no age filter or resolved-state tracking, so a
  long-resolved episode stays listed under "resuelve el reto" indefinitely.
  Deliberately NOT fixed with a resolve-report round trip (extra endpoint +
  extension wiring) for this pass — flagged here as a known gap; a future
  pass should either add a time window or a resolve POST.
- **D-142's `rule:` was rewritten to fit the ≤180-char guidance** — the
  detailed behavior lives in this file's numbered decision points, not the
  index one-liner.

**Known limits** (not yet solved, intentionally out of scope for this pass):
- A genuine NETWORK-level block (no HTTP response body at all — Chrome's own
  `chrome-error://` page) never runs a content script, so `detectBlockSignals`
  can't see it regardless of `webRequest`; this is a real gap for a portal
  whose WAF rejects the connection outright rather than serving a challenge
  page. Both grounding incidents (DataDome, GeeTest) render a normal HTTP 200
  page, which DOM inspection already catches.
- The Cloudflare `cloudflare_challenge` signature's weakest fallback (the
  English "just a moment" title check) will still miss a localised
  interstitial that ALSO happens to omit the `/cdn-cgi/challenge-platform/`
  script — believed rare (that script is what actually runs the challenge)
  but not proven absent in the wild.

**See**: issue #634, D-043 (bounded-concurrency batch queue — PAUSE reused
verbatim), D-112 (pending-search queue — never drained by a block), D-134
(auto durable intent / armed-status truthful-state line, extended here), D-047
(soft-block clean-outcome vocabulary, mirrored here), D-049 (gone-listing
clean skip, the third outcome this issue explicitly separates from a block).
Files: `browser-extension/detect.js` (`detectBlockSignals`, `BLOCK_SIGNATURES`,
`isRenderReady` corroboration), `browser-extension/batch.js`
(`recordBlock`/`clearBlock`/`isPortalBlocked`/`blockEntry`/
`markBlockReported`/`BLOCK_EPISODE_TTL_MS`, `makeBatchState`'s `portal`
field), `browser-extension/content-script.js` (`checkForBlock`, the
last-moment guard in `waitForQuiescenceThenFire`), `browser-extension/
background.js` (`handleBlockDetected`/`tryReportBlockEpisode`/
`clearBlockIfActive`/`notifyBlocked`/`reportBlockEpisode`/
`activeBlockSummary`/`reportInFlight`, the `enumerationStopped(portal)`
extension, the `notifications.onClicked` listener), `browser-extension/
popup.js` (`renderAutoArmedStatus`, `blockSignatureLabelEs`),
`browser-extension/manifest.json` (`notifications` permission, version
0.15.0), `dashboard/app/api/extension/block-episode/route.ts`,
`dashboard/lib/db/extension-blocks.ts`, `dashboard/lib/data-health.ts`
(`ExtensionBlockEpisode`, `extensionBlockNoticeEs`), `dashboard/app/etl/salud/
page.tsx` (`ExtensionBlocksSection`), `etl/schema/init.sql`
(`extension_block_episode`). Tests: `dashboard/__tests__/
extension-block-detect.test.ts` (signature fixtures, the false-positive
cases, and the "healthy page with a plausible marker" cases), `dashboard/
__tests__/extension-batch.test.ts` (recordBlock/clearBlock/TTL/
markBlockReported), `dashboard/__tests__/extension-block-detection.test.ts`
(background.js wiring: one-alert-per-episode under real concurrency,
pause-never-drain, portal-scoped pause, the real enumeration walk, the real
EXTRACT dispatch, report retry, notification click), `dashboard/__tests__/
extension-popup-armed-status.test.ts` (the blocked armed-status line),
`dashboard/app/api/extension/__tests__/block-episode-route.test.ts`,
`dashboard/lib/db/__tests__/extension-blocks.test.ts`.
