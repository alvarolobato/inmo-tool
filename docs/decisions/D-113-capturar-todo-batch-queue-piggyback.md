---
id: D-113
title: '"Capturar todo" batch button hands off additional searches via a URL-fragment piggyback, never a new dashboard→extension channel'
date: 2026-08-18
group: Data / connectors
rule: '"Capturar todo" (per profile, one global button, issue #556) opens ONE tab (the first ticked task, via a SYNCHRONOUS `window.open` inside the click gesture, before any `await`) and piggybacks the REST as `#inmo-capture-queue=<json>` — the URL FRAGMENT, never the query string (`dashboard/lib/extension-capture.ts` `withCaptureQueue`) — capped at `MAX_QUEUE_ENTRIES` (24; a dropped task is NEVER queued or recorded). Call order is `withCaptureSignal(withCaptureQueue(url, queue))`: the queue claims the fragment, so the signal falls back to its own existing query form — zero changes to `withCaptureSignal`/`captureSignalPresent`. The opened tab''s content script (`detect.js` `parseCaptureQueue`, reading `urlSignalValue`''s percent-DECODED fragment branch) forwards the list to `background.js`''s `startBatch`, which appends each entry to #555/D-112''s OWN pending-search queue (`InmoBatch.enqueueSearch`, which now DEDUPES an exact (portal, searchUrl) repeat) — never a second queue, never a second `window.open`. Do not add `externally_connectable`/direct dashboard→extension messaging to solve this; the dashboard has no channel to the extension except opening a tab it runs a content script on. Do not move the queue payload back to the query string — every portal URL-grammar parser reads pathname+query only, never `.hash`, which is what makes a learned-template poisoning attack structurally impossible rather than merely avoided by convention.'
---

# D-113: "Capturar todo" hands off additional searches via a URL-fragment piggyback

*Decided: 2026-08-18 — revised 2026-08-18 (fresh-context Opus review of #558, issue #556): the transport moved from the query string to the URL FRAGMENT (review B2), plus a cap on how many searches ride along (B3), a queue-side dedupe (N3), and several correctness/honesty fixes (N1/N5/N6/N7) — see "Revised" below.*

**Context**: Issue #556 — the owner asked for one button per profile that
ticks off every due capture task and runs them "una a una" (one after
another), unattended. #555/D-112 had just landed the extension-side
pending-search queue (`BATCH_QUEUE_KEY`, `InmoBatch.enqueueSearch`) that makes
firing off several searches back-to-back safe (they queue instead of
clobbering), but that queue is only ever fed from INSIDE the extension — a
content script running on a real portal page sends `START_BATCH` to
`background.js`. The dashboard (`/captura`) has **no channel to the extension
at all** except opening a tab the extension's content script happens to run
on (`browser-extension/manifest.json`'s `content_scripts.matches` is scoped to
the portal domains, never the dashboard's own origin — the SAME constraint
`background.js`'s `sendHeartbeat` docstring already records the other way:
"the extension can NOT inject into the dashboard origin", issue #509, which is
exactly why presence detection there is a server-mediated HTTP heartbeat
instead of a message). There is no `externally_connectable` entry either, so
`chrome.runtime.sendMessage` from a webpage isn't wired up, and the extension
ships with no fixed `key` (no stable id to target even if it were).

Ticking N tasks and clicking one button therefore cannot simply "send N
messages to the extension" — the only thing the dashboard can hand the
extension is what rides along on the ONE tab it's allowed to open (popup
blockers eat any further synchronous `window.open`, and an async one loses the
user-activation gesture entirely). The issue anticipated exactly this
("if the page currently has no way to talk to the extension except by opening
a tab with `#inmo-capture`, say so explicitly and propose the smallest honest
mechanism rather than inventing a parallel one").

**Decision**:

1. **Only the FIRST ticked task's tab is ever opened by the dashboard**, via
   `window.open` — SYNCHRONOUSLY, inside the click's user gesture, before any
   `await` (revised, review N5 — see below). `CapturaProfileSection.onCapturarTodo`
   (`dashboard/components/captura/CapturaProfileSection.tsx`) computes the
   plan via the pure `buildCaptureBatchPlan` (`dashboard/lib/captura-tasks.ts`)
   — display-order first-ticked-task + the rest as a queue — and calls
   `window.open` exactly once, regardless of how many tasks are ticked.

2. **The rest ride on that ONE tab's URL as a FRAGMENT, never the query
   string** (revised from a first version that used a query param — see
   "Revised" below). `withCaptureQueue` (`dashboard/lib/extension-capture.ts`)
   appends `#inmo-capture-queue=<json>` — a compact `[portal, captureUrl][]`
   tuple array, `encodeURIComponent`-encoded explicitly — to the URL.
   `withCaptureSignal`'s call happens AFTER, on the result: it sees the
   fragment already taken and falls back to its OWN pre-existing query-key
   form (`?inmo-capture=1`) — this needed **zero changes** to
   `withCaptureSignal`/`captureSignalPresent`, since that fallback already
   existed for "URL already has an unrelated fragment". A fragment is NEVER
   sent to the portal server by the browser, so the (potentially multi-KB)
   queue payload costs nothing in WAF/analytics exposure — only the small
   (~15-byte) signal still rides in the query, same class of exposure already
   accepted for `CAPTURE_SIGNAL` before this feature existed.

3. **The extension's content script decodes and forwards it through the
   EXISTING internal channel, into the EXISTING D-112 queue — nothing new is
   invented.** `detect.js`'s `parseCaptureQueue` (reusing the shared
   `urlSignalValue` helper `VALIDATE_SIGNAL` already established, whose
   fragment branch is percent-DECODED — see review N4 below) turns the param
   back into `{portal, searchUrl}[]`; `content-script.js`'s
   `startBatchFromPage` threads it as an additional `queue` field on the SAME
   `START_BATCH` message it already sends — from BOTH the auto-start path AND
   the manual banner path (review N2 below). `background.js`'s `startBatch`
   appends every `queue` entry to `getSearchQueue()`/`InmoBatch.enqueueSearch`
   — behind the first search whether that search claims the run or is itself
   queued — all inside the SAME `runBatchStateExclusive` critical section
   D-112 already uses, so no new race is introduced. Each queued entry's
   `urls` is `[]` (the dashboard never harvested a DOM it didn't render) —
   this is not a gap: `enumerateResultsPages` already self-renders page 1 via
   `chrome.tabs` for every OTHER results page of a walk (#362/#554), so an
   empty `urls` array on a queue entry is the SAME code path, not a new one.
   The extension then opens each queued search itself, one at a time, via
   `chrome.tabs` — exempt from the page-level popup blocker the dashboard is
   subject to.

4. **`capture_task_run` is recorded for every task that actually gets
   opened/queued** (parallel best-effort POSTs to the existing
   `/api/profiles/[id]/capture-task-runs`, one call per task — no new
   endpoint), AFTER `window.open` (review N5), regardless of whether the
   extension ever gets around to running all of them — same "last touched,
   not outcome" ledger semantics D-048 already established for the
   single-task button. The status message is explicit about what's confirmed
   vs. merely queued (review N1 below) — never silently implies more than the
   owner can see happened.

**Revised (2026-08-18, fresh-context Opus review of #558)**. The first
version of this decision put the queue payload in the QUERY STRING. The
review found this genuinely dangerous, not just suboptimal, and required a
structural fix rather than a patch:

- **B1 (poisoning, demonstrated not theoretical)**: two `popup.js`-driven
  paths read `tab.url` **without** stripping any signal — `saveSearchUrlExample`
  (capture-to-infer's own learner, #303) and `postCapturedSearchUrl` (which
  feeds directly into `profile_connector_filter.override_url`, the D-101 pin
  used **verbatim** in `discover()`). The reviewer parsed a real query-poisoned
  URL through `parseAliseda` and produced a poisoned template
  (`…?precio={price_min}-{price_max}&inmo-capture-queue=%5B%5B%22idealista%22…`)
  that would silently overwrite the clean learned/pinned template on the same
  `(portal, match_key)` — auto-trusted, no review, permanent, and re-sent to
  Aliseda's own servers on every future resolved capture. It didn't fire in
  the shipped-that-day version only because the URL still carried `#inmo-capture`
  too, and Aliseda's `PATH_RE` regex requires the string to end (`$`) right
  after its optional query group — a fragment ANYWHERE after the query makes
  the whole regex fail to match. That's an accident of composition order, not
  a defence: an in-SPA navigation that strips the fragment (common — SPA
  routers often normalise/clobber a synthetic hash) while preserving the query
  (which usually DOES carry real app state) would have let exactly this
  poisoning through later, not at the moment the tab first opened.
- **B2 (the structural fix, not a patch)**: move the queue payload to the URL
  FRAGMENT. Every portal URL-grammar parser in `lib/search-url/portals/*.ts`
  builds its template from pathname + query only — none of them read `.hash`
  (confirmed: `grep -rn '\.hash' dashboard/lib/search-url/portals/*.ts` finds
  nothing) — so a payload that lives in the fragment can **never** reach a
  learned/pinned template, structurally, regardless of whether any particular
  call site (present OR future) remembers to strip it first. This dissolves
  B1 without touching `popup.js` at all. It also removes the WAF/analytics
  exposure (B3's original framing: "same class as `?inmo-capture=1`" was
  wrong — 15 bytes of opaque flag is not the same class as ~5 KB of
  `[["idealista","https://…"],…]`, the canonical SSRF/open-redirect-shaped
  payload several WAF rule sets flag, aimed at portals that sit behind
  Incapsula/Akamai-class WAFs precisely because they're capture-only). The
  composition trick that makes this free: apply `withCaptureQueue` BEFORE
  `withCaptureSignal` — the queue claims the fragment (when non-empty),
  and `withCaptureSignal`'s PRE-EXISTING "fragment already taken → fall back to
  query" branch handles the signal automatically. **Do not** try to combine
  both signals into one fragment (e.g. `#inmo-capture&inmo-capture-queue=…`)
  — that would force `captureSignalPresent`'s byte-for-byte EXACT match
  (shared with `DISCOVER_SIGNAL` via `urlSignalPresent`) to become a prefix
  match, a much wider blast radius for no benefit over the two-signal split
  above.
- **B3 (a cap, kept even after B2)**: a fragment has no server-enforced length
  limit, but an unbounded queue is still a bad contract — a batch with no
  visible feedback for a long tail, and unbounded growth of what any one JSON
  parse has to handle. `MAX_QUEUE_ENTRIES = 24`
  (`dashboard/lib/extension-capture.ts`) and the pure `capCaptureBatchPlan`
  (`dashboard/lib/captura-tasks.ts`) enforce it: a dropped task is **never**
  queued and **never** recorded (`capture_task_run`) — recording a dropped
  task as "done" would be a worse lie than the cap exists to prevent — and the
  status message tells the owner exactly how many didn't fit, so a second
  click once the batch drains picks up the remainder.
- **N1 (honest status, not a silent lie in the due-cue)**: the ledger records
  every queued task's run up front, but only the FIRST task's tab is
  something the owner actually sees open — the rest depend on the extension
  being installed and running, with no confirmation channel back to the
  dashboard to verify that. The status message now says so explicitly
  ("… en cola en la extensión — solo se capturarán si la extensión está
  instalada y activa") rather than phrasing every ticked task as "capturando".
- **N2**: the manual in-page banner path (`content-script.js` `showBanner`)
  now also forwards the parsed queue to `startBatchFromPage`, matching the
  auto-start path — a queue-carrying tab that shows the banner instead of
  auto-starting no longer silently drops the rest.
- **N3 (dedupe)**: `InmoBatch.enqueueSearch` (`browser-extension/batch.js`)
  now drops an exact `(portal, searchUrl)` repeat already present in the
  queue — an accidental F5 reload of a "Capturar todo"-opened tab re-parses
  the same fragment and would otherwise re-enqueue the whole tail on every
  reload, multiplying an N-search batch by however many times the tab
  reloads. `searchUrl: null` entries are never deduped against each other
  (an unknown source isn't provably a duplicate).
- **N4**: `urlSignalValue`'s fragment branch (`detect.js`) now explicitly
  `decodeURIComponent`s the sliced value — `URL.hash` is never
  platform-auto-decoded the way `searchParams.get()` is, so a value written
  with `encodeURIComponent` (as `withCaptureQueue` does) would otherwise come
  back still percent-encoded and fail `JSON.parse`, silently degrading to "no
  queue" rather than a visible error. The prior docstring's claim that the
  fragment form was already handled was false; it now is.
- **N5 (open before record, not after)**: `window.open` now happens
  SYNCHRONOUSLY before any `await` in `onCapturarTodo`, never after the
  `capture_task_run` POSTs resolve — the previous ordering leaned on Chrome's
  short-lived transient-activation grace period surviving an `await` chain
  instead of the click gesture itself. Strictly safer, and it also means a
  popup-blocked open is detected (`window.open(...) !== null`) and reported
  honestly (N1) rather than assumed to have worked.
- **N6**: the claimed-run branch of `startBatch` (`background.js`) only
  writes `chrome.storage.session` for the queue when `queue` is non-empty —
  the overwhelmingly common case (a plain single-task `START_BATCH`, no batch
  button involved) no longer takes a redundant no-op storage write.
- **N7 (reconcile ticked state with what actually ran)**: the per-task
  optimistic "just ran" override (`runOverrides`, previously local to
  `ConnectorSection`) is lifted to `CapturaProfileSection` and shared by every
  connector under the profile AND by the batch button. Launching a task —
  via EITHER the single-task button OR "Capturar todo" — now greys it out
  AND un-ticks it immediately; without this, a second "Capturar todo" click
  before the page reloads would re-fire every task the first click just
  launched.

**Alternatives rejected**:

- *Add `externally_connectable` + a dashboard-side `chrome.runtime.sendMessage`
  call.* Would let the dashboard message the extension directly (no
  URL-piggyback needed) but requires: a stable extension id (none exists —
  no `key` in `manifest.json`, and an unpacked dev install's id varies by
  install path), a NEW cross-origin trust surface (validating the sender in
  `onMessageExternal`), and contradicts the established pattern that
  dashboard↔extension coordination is server-mediated (heartbeat, config,
  capture, search-url-example, filter-catalog — all plain HTTP fetches FROM
  the extension TO the dashboard, never the reverse via extension messaging).
  Rejected as materially larger surface for a marginal win over the
  fragment piggyback, which needed zero new permissions or trust boundaries.
- *A server-side ephemeral "capture batch" table + a short opaque reference id
  in the URL instead of the full `[portal, captureUrl][]` payload.* Once the
  payload lives in the fragment (never sent to the portal, never reaches a
  URL-grammar parser), the WAF/poisoning motivation for this shrinks away —
  the remaining benefit (a shorter URL) doesn't justify a new table + API
  route + expiry/cleanup logic. Rejected as disproportionate complexity.
- *Combine `CAPTURE_SIGNAL` and the queue payload into one fragment* (e.g.
  `#inmo-capture&inmo-capture-queue=…`) to keep everything invisible to the
  portal, including the signal. Rejected: `captureSignalPresent`'s exact-match
  check would have to become a prefix/startsWith check shared with
  `DISCOVER_SIGNAL`, widening a byte-for-byte-pinned contract multiple call
  sites depend on, to shrink an already-accepted 15-byte query exposure to
  zero. Not worth the blast radius.
- *Open all N ticked tasks' tabs, relying on D-112's queue to sort out the
  race.* Explicitly ruled out by the issue: a burst of `window.open` calls
  outside the single synchronous gesture is popup-blocked past the first, and
  even if it weren't, N simultaneously-opened raw tabs fight over OS focus —
  only one can be the foreground tab Chrome doesn't render-throttle, which is
  exactly the failure mode D-043's bounded-concurrency design exists to avoid
  for CAPTURE tabs; this decision keeps the extension, not the page, in
  control of when each subsequent tab opens.
- *Patch B1 by stripping the queue signal at `popup.js`'s two call sites
  instead of moving the payload to the fragment.* Rejected as the reviewer
  explicitly asked for: a per-call-site strip only protects the call sites
  someone remembered to patch, today and in the future. The fragment move
  makes the failure mode structurally impossible instead of convention-
  dependent, for less code.

**Rationale**: The whole point of #555/D-112 was to make sequential
self-triggered captures safe — this decision's only job is to make the
TRIGGERING itself automatic, without adding a second communication channel or
a second queue. Piggybacking on the one tab the dashboard is allowed to open,
through the one message type and one queue the extension already has, keeps
the blast radius small; putting that piggyback in the URL fragment (rather
than the query string) keeps it invisible to both the portal server and every
URL-grammar parser, which is what turns a class of poisoning/WAF-exposure bug
from "avoided today, at today's call sites" into "impossible by construction".

**See**: issue #556 (owner: *"quiero un botón que sea capturar todo y que
vaya a todas una a una y las capture todas"*); PR #558 and its fresh-context
Opus review (B1/B2/B3/N1–N7, quoted above); D-112 (the queue this hands
off to, untouched in its own locking/ordering guarantees); D-043 (bounded
concurrency/pacing — untouched, this only changes what gets queued); D-045
(execution vs. setup placement — the button lives on `/captura`, not `/etl`);
D-048 (the staleness window `defaultTickedTaskIds` reuses verbatim, and the
"last touched, not outcome" ledger semantics `capture_task_run` keeps); D-053
(the `#inmo-capture` signal contract, left byte-for-byte untouched); D-101
(`captureUrl` vs `url` — the queue always carries `captureUrl`); D-051 (the
capture-to-infer learner B2 protects).
`dashboard/lib/extension-capture.ts` (`CAPTURE_QUEUE_SIGNAL`,
`MAX_QUEUE_ENTRIES`, `withCaptureQueue`, `encodeCaptureQueue`/`decodeCaptureQueue`),
`dashboard/lib/captura-tasks.ts` (`defaultTickedTaskIds`, `allProfileTasks`,
`buildCaptureBatchPlan`, `capCaptureBatchPlan`),
`dashboard/components/captura/CapturaProfileSection.tsx` (owns the ticked set
AND the lifted `runOverrides`), `dashboard/components/captura/ConnectorSection.tsx`
(consumes `runOverrides`/`onOptimisticRun` as props), `dashboard/components/captura/CaptureTaskRow.tsx`
(the per-task checkbox), `browser-extension/detect.js`
(`CAPTURE_QUEUE_SIGNAL`, `parseCaptureQueue`, `stripCaptureQueue`,
`urlSignalValue`'s decode fix), `browser-extension/content-script.js`
(`startBatchFromPage`'s `queue` param, threaded from both the autostart and
banner paths), `browser-extension/background.js` (`startBatch`'s `queue`
field, the N6 write guard), `browser-extension/batch.js` (`enqueueSearch`'s
N3 dedupe via `hasSameSearch`); `dashboard/e2e/captura-tasks.spec.ts`.
