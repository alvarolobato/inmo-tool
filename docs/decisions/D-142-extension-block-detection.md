---
id: D-142
title: Extension block/challenge detection stops the run, alerts once, reports as a D-047 clean notice
date: 2026-08-20
group: Data / connectors
rule: "Extension block detection (browser-extension/detect.js detectBlockSignals, a small portal-agnostic DOM-marker library) never solves/retries a challenge — it PAUSES (never drains, D-043/D-112 queues survive) the active batch/auto run, fires ONE chrome.notifications alert per episode (recordBlock/clearBlock in batch.js gate re-notification), and POSTs {portal, signature, detectedAt} — never page content — to /api/extension/block-episode, surfaced on /etl/salud as a D-047-style informational notice, never a red badge. An unrecognised page (incl. an empty search or a 404 listing) is never a match."
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
   selectors.** `browser-extension/detect.js`'s `detectBlockSignals(doc)`
   checks five documented signatures — Cloudflare's "Just a moment" challenge,
   the DataDome/`captcha-delivery.com` wall, GeeTest's "Pardon Our
   Interruption" (`#captcha-box`, `static.geetest.com`), a generic Incapsula
   JS challenge (`_Incapsula_Resource`), and Akamai's static deny page (title
   "Access Denied" + a "Reference #" id) — in that order, returning the FIRST
   match as `{blocked: true, signature: <id>}` or `{blocked: false,
   signature: null}` for anything else. Every `matches()` is individually
   try/caught so one bad check can never crash detection or block a later
   signature. An unrecognised page is the safe default — this is what keeps a
   genuinely empty search or a 404/removed listing from ever matching (see the
   false-positive tests in `extension-block-detect.test.ts`), since neither
   carries any of these markers by construction.
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
3. **Stop the run — pause, never drain.** `background.js`'s
   `handleBlockDetected` records the episode (`InmoBatch.recordBlock`, below),
   and if a batch loop is actually driving (`batchLooping`), pauses it via the
   SAME `mutateBatch(InmoBatch.pause)` PAUSE_BATCH already used — never
   `stop()`/STOP_BATCH, which drains the pending-search queue (D-112). A block
   detected mid-ENUMERATION (before a capture batch state even exists) is
   represented as an already-PAUSED batch built from whatever detail URLs were
   already seeded, for the same reason: a bare cleared enum claim would read
   as idle to `isBatchActive()`/`advanceQueueIfIdle` and silently pop the next
   queued search, which is exactly the "grind on" this issue exists to
   prevent. Every pending/in-flight URL and the whole search queue (D-112)
   survive untouched — a resume (the existing RESUME_BATCH control) picks up
   exactly where it left off.
4. **One alert per episode, not per tab.** `batch.js`'s `recordBlock(state,
   portal, signature, now)` is idempotent while a portal's episode is active —
   a second (or twentieth) detection returns `isNewEpisode: false` and the
   state is untouched (not even `detectedAt`/`signature` are overwritten,
   since they describe when the episode STARTED). `handleBlockDetected` only
   calls `chrome.notifications.create` (needs the new `notifications`
   manifest permission) and POSTs to the dashboard on `isNewEpisode: true`.
   An episode resolves via `clearBlock`, called ONLY after a REAL capture
   succeeds for that portal (`EXTRACT`'s success handler) — never merely
   because one render didn't show a marker, since an absent marker on a single
   page is not proof of recovery (the challenge page might not render
   identically every time). The NEXT detection after a clear is treated as a
   fresh episode and alerts again.
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

**See**: issue #634, D-043 (bounded-concurrency batch queue — PAUSE reused
verbatim), D-112 (pending-search queue — never drained by a block), D-134
(auto durable intent / armed-status truthful-state line, extended here), D-047
(soft-block clean-outcome vocabulary, mirrored here), D-049 (gone-listing
clean skip, the third outcome this issue explicitly separates from a block).
Files: `browser-extension/detect.js` (`detectBlockSignals`, `BLOCK_SIGNATURES`),
`browser-extension/batch.js` (`recordBlock`/`clearBlock`/`isPortalBlocked`/
`blockEntry`), `browser-extension/content-script.js` (`checkForBlock`, the
last-moment guard in `waitForQuiescenceThenFire`), `browser-extension/
background.js` (`handleBlockDetected`/`clearBlockIfActive`/`notifyBlocked`/
`reportBlockEpisode`/`activeBlockSummary`, the `enumerationStopped(portal)`
extension), `browser-extension/popup.js` (`renderAutoArmedStatus`,
`blockSignatureLabelEs`), `browser-extension/manifest.json` (`notifications`
permission, version 0.15.0), `dashboard/app/api/extension/block-episode/route.ts`,
`dashboard/lib/db/extension-blocks.ts`, `dashboard/lib/data-health.ts`
(`ExtensionBlockEpisode`, `extensionBlockNoticeEs`), `dashboard/app/etl/salud/
page.tsx` (`ExtensionBlocksSection`), `etl/schema/init.sql`
(`extension_block_episode`). Tests: `dashboard/__tests__/
extension-block-detect.test.ts` (signature fixtures + the false-positive
cases), `dashboard/__tests__/extension-batch.test.ts` (recordBlock/clearBlock),
`dashboard/__tests__/extension-block-detection.test.ts` (background.js wiring:
one-alert-per-episode, pause-never-drain, clear-on-real-capture),
`dashboard/__tests__/extension-popup-armed-status.test.ts` (the blocked
armed-status line), `dashboard/app/api/extension/__tests__/
block-episode-route.test.ts`, `dashboard/lib/db/__tests__/
extension-blocks.test.ts`.
