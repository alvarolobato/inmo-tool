---
id: D-113
title: '"Capturar todo" batch button hands off additional searches via a URL-piggybacked query param, never a new dashboard→extension channel'
date: 2026-08-18
group: Data / connectors
rule: '"Capturar todo" (per profile, one global button, issue #556) opens ONE tab (the first ticked task, via `window.open` in the click gesture) and piggybacks the REST as `?inmo-capture-queue=<json>` (`dashboard/lib/extension-capture.ts` `withCaptureQueue`) on that URL — never a second `window.open`. The opened tab''s content script (`detect.js` `parseCaptureQueue`) forwards the list to `background.js`''s `startBatch`, which appends each entry to #555/D-112''s OWN pending-search queue (`InmoBatch.enqueueSearch`) — never a second queue. Do not add `externally_connectable`/direct dashboard→extension messaging to solve this; the dashboard has no channel to the extension except opening a tab it runs a content script on.'
---

# D-113: "Capturar todo" hands off additional searches via a URL-piggybacked query param

*Decided: 2026-08-18*

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
   `window.open` inside the click's user gesture — byte-identical to the
   existing single-task flow (`ConnectorSection.onExecute`), which keeps
   working unmodified. `CapturaProfileSection.onCapturarTodo`
   (`dashboard/components/captura/CapturaProfileSection.tsx`) computes the
   plan via the pure `buildCaptureBatchPlan` (`dashboard/lib/captura-tasks.ts`)
   — display-order first-ticked-task + the rest as a queue — and calls
   `window.open` exactly once, regardless of how many tasks are ticked.

2. **The rest ride on that ONE tab's URL as a query param**, never the
   fragment. `withCaptureQueue` (`dashboard/lib/extension-capture.ts`) appends
   `?inmo-capture-queue=<json>` — a compact `[portal, captureUrl][]` tuple
   array — to the URL `withCaptureSignal` already tagged. The fragment slot is
   NOT reused: `CAPTURE_SIGNAL`'s `#inmo-capture` equality check
   (`captureSignalPresent`) is a byte-for-byte pinned contract several other
   call sites rely on, and combining signals there would have required
   loosening that shared match to a prefix check — a wider blast radius for a
   feature that doesn't need it. The query-string route means this new
   param IS visible to the first task's portal server — the same class of
   exposure the codebase already accepts for `CAPTURE_SIGNAL`'s own
   `?inmo-capture=1` fallback — mitigated by keeping the payload compact
   (2-tuples, no extra fields) and, for the map→listing "convert" redirect
   path (#529), carried forward explicitly rather than dropped.

3. **The extension's content script decodes and forwards it through the
   EXISTING internal channel, into the EXISTING D-112 queue — nothing new is
   invented.** `detect.js`'s `parseCaptureQueue` (reusing the shared
   `urlSignalValue` helper `VALIDATE_SIGNAL` already established) turns the
   param back into `{portal, searchUrl}[]`; `content-script.js`'s
   `startBatchFromPage` threads it as an additional `queue` field on the SAME
   `START_BATCH` message it already sends. `background.js`'s `startBatch`
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

4. **`capture_task_run` is recorded for every ticked task up front**
   (parallel best-effort POSTs to the existing
   `/api/profiles/[id]/capture-task-runs`, one call per task — no new
   endpoint), regardless of whether the extension ever gets around to running
   all of them — same "last touched, not outcome" ledger semantics D-048
   already established for the single-task button.

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
  query-param piggyback, which needed zero new permissions or trust
  boundaries.
- *A server-side ephemeral "capture batch" table + a short opaque reference id
  in the URL instead of the full `[portal, captureUrl][]` payload.* Would
  shrink the query param from ~1 KB to a few dozen chars (a smaller footprint
  on the first task's portal request), at the cost of a new table + API route
  + expiry/cleanup logic, and an extra network round trip from the extension
  before it can even start enqueuing. Rejected as disproportionate complexity
  for a speculative WAF-risk reduction — real profiles are single-digit
  portal×section counts, so the payload stays small regardless; revisit if a
  live WAF block is ever actually observed on this param.
- *Combine `CAPTURE_SIGNAL` and the queue payload into one fragment* (e.g.
  `#inmo-capture&inmo-capture-queue=…`) to keep everything invisible to the
  portal. Rejected: `captureSignalPresent`'s exact-match check would have to
  become a prefix/startsWith check shared with `DISCOVER_SIGNAL`, widening a
  byte-for-byte-pinned contract multiple call sites depend on, for a payload
  that already has an accepted (if imperfect) query-string home.
- *Open all N ticked tasks' tabs, relying on D-112's queue to sort out the
  race.* Explicitly ruled out by the issue: a burst of `window.open` calls
  outside the single synchronous gesture is popup-blocked past the first, and
  even if it weren't, N simultaneously-opened raw tabs fight over OS focus —
  only one can be the foreground tab Chrome doesn't render-throttle, which is
  exactly the failure mode D-043's bounded-concurrency design exists to avoid
  for CAPTURE tabs; this decision keeps the extension, not the page, in
  control of when each subsequent tab opens.

**Rationale**: The whole point of #555/D-112 was to make sequential
self-triggered captures safe — this decision's only job is to make the
TRIGGERING itself automatic, without adding a second communication channel or
a second queue. Piggybacking on the one tab the dashboard is allowed to open,
through the one message type and one queue the extension already has, keeps
the blast radius to "one query param + one optional message field" instead of
a new trust boundary.

**See**: issue #556 (owner: *"quiero un botón que sea capturar todo y que
vaya a todas una a una y las capture todas"*); D-112 (the queue this hands
off to, untouched in its own locking/ordering guarantees); D-043 (bounded
concurrency/pacing — untouched, this only changes what gets queued); D-045
(execution vs. setup placement — the button lives on `/captura`, not `/etl`);
D-048 (the staleness window `defaultTickedTaskIds` reuses verbatim); D-053
(the `#inmo-capture` signal contract, left untouched); D-101 (`captureUrl` vs
`url` — the queue always carries `captureUrl`).
`dashboard/lib/extension-capture.ts` (`CAPTURE_QUEUE_SIGNAL`,
`withCaptureQueue`, `encodeCaptureQueue`/`decodeCaptureQueue`),
`dashboard/lib/captura-tasks.ts` (`defaultTickedTaskIds`, `allProfileTasks`,
`buildCaptureBatchPlan`), `dashboard/components/captura/CapturaProfileSection.tsx`,
`dashboard/components/captura/CaptureTaskRow.tsx` (the per-task checkbox),
`browser-extension/detect.js` (`CAPTURE_QUEUE_SIGNAL`, `parseCaptureQueue`,
`stripCaptureQueue`), `browser-extension/content-script.js`
(`startBatchFromPage`'s `queue` param), `browser-extension/background.js`
(`startBatch`'s `queue` field); `dashboard/e2e/captura-tasks.spec.ts`.
