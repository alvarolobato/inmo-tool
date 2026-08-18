---
id: D-112
title: Batch capture queues additional searches instead of clobbering the live one
date: 2026-08-18
group: Data / connectors
rule: "START_BATCH while a run is active (enumerating or capturing) ENQUEUES the search (chrome.storage.session, FIFO) instead of clobbering BATCH_KEY/BATCH_ENUM_KEY; the next entry auto-starts on natural completion (runBatchLoop's own finally) AND on eviction recovery (reattachIfStranded). A same-portal drain (worklist already emptied by an earlier queued search) reports emptyReason 'already-captured', never a bare 0/0. STOP_BATCH drains the whole queue; concurrency/pacing (D-043) are untouched."
---

# D-112: Batch capture queues additional searches instead of clobbering the live one

*Decided: 2026-08-18*

**Context**: Issue #554. The owner wants to fire off several searches
(different zones/portals) back to back and have the extension work through
them one at a time. `startBatch` (`browser-extension/background.js`) had no
guard against an already-running run: the queue state lived in a single
session key (`BATCH_KEY`, plus `BATCH_ENUM_KEY` for the enumeration phase
that precedes it). A second `START_BATCH` while one was live overwrote the
first run's state — the popup's progress stopped corresponding to what was
actually happening, and the re-entrancy guard in `runBatchLoop` left the
*old* loop driving the *new* state. No data was lost (pending URLs live
server-side in `capture_worklist`, in-flight tabs finish cleanly), but the
run became unobservable and uncontrollable.

This extends D-043 (bounded-concurrency batch capture) — it does not replace
it. D-043's concurrency cap, jittered stagger, and long-run backoff are
completely untouched: this decision only changes *what search runs next*,
never *how fast* or *how much at once*. Two searches never run concurrently —
the WAF-safety envelope D-043 protects is per-browser, not per-search.

**Decision**:

1. **A pure FIFO queue in `batch.js`, not `background.js`.** `makeSearchQueue`
   / `enqueueSearch` / `dequeueSearch` / `removeSearchAt` / `clearSearchQueue`
   / `searchQueueDepth` / `peekNextSearch` are plain array operations over
   `{ portal, searchUrl, urls }` entries — no chrome/DOM, unit-tested exactly
   like the existing slot machinery (`makeBatchState`/`launchNext`/…).
   `background.js` persists the array under a new `BATCH_QUEUE_KEY` session
   key (matching `BATCH_KEY`'s lifetime) and owns the *when* (is a run
   active?) and the *what happens next* (kick off the same enumerate→capture
   flow `startBatch` already uses).
2. **`START_BATCH` while a run is active enqueues instead of clobbering.**
   The active-check and the "claim the run" transition (persisting the
   `enumerating` phase) happen inside ONE critical section
   (`runBatchStateExclusive`, the existing in-memory serializer from #321) so
   two `START_BATCH` calls racing each other can never both decide "nothing's
   running" and both write `BATCH_ENUM_KEY` — that race was one message-timing
   coincidence away from being the original clobbering bug. The response says
   `{ started: false, queued: true, queueDepth, aheadCount }` — never a lie
   that it "started" when it didn't.
3. **The queue advances from two places, covering both the happy path and
   eviction.** `advanceQueueIfIdle()` — itself an atomic claim-or-noop inside
   the same exclusive section — is called from:
   - `runBatchLoop`'s own `finally`, once the loop genuinely stops driving
     (done, not merely paused — `isBatchActive()` distinguishes them), so a
     natural completion advances promptly;
   - `reattachIfStranded()` (the existing D-043 watchdog: `chrome.alarms`
     every 30 s, `onStartup`/`onInstalled`, every popup open), as the final
     fallback once nothing is stranded. This is what recovers a queued
     follow-up when the service worker is evicted in the exact gap between
     "the run just finished" and "the in-memory continuation got to run" — a
     queue that silently stalls after eviction would be worse than no queue,
     since the owner would believe work is progressing.
   `reattachIfStranded()` is also extended to recover a **stranded
   ENUMERATION** (not just a stranded capture queue): before this, only
   `recoverStrandedHarvest` (issue #516) covered an evicted enumeration, and
   only for Auto's `HARVESTING` state. A plain manual `startBatch` whose
   enumeration got evicted had no recovery path — `isBatchActive()` would
   report "active" forever and permanently wedge anything queued behind it.
   `shouldRecoverStrandedEnumeration` (pure, mirrors `shouldReattach`) detects
   this and falls through to capturing whatever was already seeded — exactly
   what `startBatch`'s own enumeration-failure fallback already does.
4. **Same-portal drain reports cleanly, never a bare 0/0.** The capture queue
   is portal-scoped (`runCaptureQueue` fetches every pending row for the
   whole portal) — two queued searches on the same portal share one worklist,
   so the second one's capture phase can legitimately find nothing left.
   `runCaptureQueue(portal, discoveredCount)` now takes how many detail URLs
   *this* search discovered (page 1 + enumeration); `classifyEmptyCapture`
   (pure) distinguishes `already-captured` (discovered > 0 but 0 pending — an
   earlier queued search got there first) from `no-results` (discovered 0 —
   this search genuinely found nothing). `makeBatchState`'s new optional third
   argument attaches the reason; `progress()` surfaces it (`emptyReason`,
   `null` when not applicable) for the popup to render "Ya capturada por la
   búsqueda anterior" instead of a confusing 0/0.
5. **`STOP_BATCH` drains the whole queue, not just the live run.** "Detener"
   is the operator's full-stop control — it cancels everything fired off, not
   only the one currently running. Removing a single queued search (or not
   queueing it in the first place) is the popup's per-item "Quitar" /
   "Vaciar cola" affordance instead.
6. **Popup**: the batch panel shows queue depth + a per-entry "Quitar" plus a
   "Vaciar cola" button (`GET_SEARCH_QUEUE` / `REMOVE_QUEUED_SEARCH` /
   `CLEAR_SEARCH_QUEUE`). `init()`'s ordering changed: the plain "a batch is
   running → show its progress" check moved from the FIRST thing checked to a
   FALLBACK after per-tab page detection. Before this, opening the popup on a
   *second* search page while a first run was live always jumped straight to
   the first run's progress — there was no way to reach "Capturar todas" for
   the second page, which is the entire point of this feature. A fresh
   listing/search page on the current tab now always gets its own
   "Capturar todas"/"Añadir a la cola" offer; the live-run fallback only
   applies when the current tab has nothing fresh of its own (a detail page,
   the dashboard, a blank tab, …). Known rough edge, accepted rather than
   solved: reopening the popup on the *same* page that's already
   driving/queued its own run will offer "Capturar todas" again rather than
   showing its progress (no per-run search-URL identity is tracked) — clicking
   it re-seeds the same (idempotent) URLs and queues a redundant entry that
   the same-portal-drain handling (#4) reports as a clean "ya capturada" when
   its turn comes. Not a correctness bug; a future agent could tighten this by
   threading the originating `searchUrl` through `BATCH_ENUM_KEY`/`BATCH_KEY`
   and comparing it against the current tab.

**Alternatives rejected**:
- *Raising concurrency / running two searches' capture queues at once.*
  Explicitly out of scope — D-043's bounded concurrency exists for WAF safety
  and because more concurrency measurably hurts reliability; this issue
  changes ordering, never parallelism.
- *A cross-worker-instance lock (e.g. a compare-and-swap in
  chrome.storage).* Rejected as over-engineering: `runBatchStateExclusive` is
  an in-memory mutex, so it only serializes calls within one live worker
  instance. A genuine dual-instance race (the worker evicted and respawned in
  the exact same tick as another trigger) is an accepted residual risk,
  consistent with how the rest of the batch-capture machinery already treats
  `chrome.storage` races (issue #321's own serializer has the same scope).
- *Tracking per-entry queue identity (an id) so the popup can show "my
  search's exact position" or detect "this tab IS the one now running".*
  Deferred (see point 6) — the FIFO depth + next-portal summary satisfies the
  issue's exit criteria without the added persisted-state surface.

**Rationale**: Keeping the queue as pure array operations in `batch.js`
(mirroring the existing slot state machine) makes the actual "don't lose
state" logic unit-testable outside a browser, per this repo's standing rule
that `batch.js` is pure/tested and `background.js` is the untested imperative
shell around Chrome APIs. Reusing the existing `runBatchStateExclusive`
serializer for the claim-or-enqueue decision closes the exact race that was
the original bug, without inventing a second locking mechanism.

**See**: issue #554; D-043 (the design this extends — bounded concurrency and
pacing, untouched here); D-053 (discoverability); D-060 (extension zip
freshness); D-069 (run hygiene); D-088 (results-page enumeration);
`browser-extension/batch.js` (`makeSearchQueue`/`enqueueSearch`/
`dequeueSearch`/`removeSearchAt`/`clearSearchQueue`/`searchQueueDepth`/
`peekNextSearch`/`shouldAdvanceQueue`/`shouldRecoverStrandedEnumeration`/
`classifyEmptyCapture`/`EMPTY_REASON`); `browser-extension/background.js`
(`startBatch`/`beginRun`/`advanceQueueIfIdle`/`runCaptureQueue`/
`reattachIfStranded`/`queueSummary`/`stopBatch`); `browser-extension/popup.js`
(`init`/`attachLiveBatchIfAny`/`onStartBatch`/`showQueuedConfirmation`/
`renderSearchQueue`); `dashboard/__tests__/extension-batch.test.ts`.
