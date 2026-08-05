---
id: D-043
title: Batch capture is a fully-automated sequential queue in the extension, with jittered pacing
date: 2026-08-05
---

# D-043: Batch capture is a fully-automated sequential queue in the extension, with jittered pacing

*Decided: 2026-08-05*

**Context**: Issue #262. The guided-capture worklist (#237/#254/#260/#261) was
built around a deliberately human-paced flow: `lib/worklist.ts firstPendingUrl`
and `/etl/captura`'s `handleOpenNext` opened exactly ONE detail tab per human
click, and the owner then let the page render so the extension's auto-capture
(#254) fired. The docstrings for both explicitly argued AGAINST an
auto-advancing queue, on the reasoning that rapid-firing tabs looks like bot
navigation — the thing the human-in-the-loop design existed to avoid. Fable's
planning pass on #262 flagged that this was a considered design, not an
oversight, and that whoever implemented #262 had to consciously overturn it.

The owner's north-star clarification (2026-08-05) supersedes it: "minimum manual
work" — the operator clicks "Capturar todas" once on a listing page and does
nothing else. The extension must open each detail URL, **activate the tab
itself** (an active tab is not subject to Chrome's background-tab render
throttling, so auto-capture's render-wait actually completes — this is also why
a 40-tab bomb never works), wait for `AUTO_CAPTURE_DONE`, **close the tab**, and
advance, showing live N/M progress with stop/resume.

**Decision**:
1. Batch capture is a **sequential (one-at-a-time) auto-advancing queue driven
   by the extension's background service worker** (`browser-extension/batch.js`
   pure logic + `background.js` tab wiring). It opens+activates a detail tab,
   waits for the content script's existing `AUTO_CAPTURE_DONE` (or a timeout),
   closes the tab, and advances. It is seeded from a listing/search page: the
   content script harvests detail anchors (`detect.js extractDetailUrls`), the
   worker POSTs them to `capture_worklist` (`added_via='derived'`), then sweeps
   the portal's `pending` set.
2. **Pacing is mandatory and must stay jittered.** A randomised delay
   (`batch.js jitterDelay`, 4–9 s minimum) sits between closing one tab and
   opening the next. The WAF concern the old human-paced design named did not
   disappear when the pacing left the human's hands — it moved into the
   extension. Idealista (CAPTCHA wall) and Aliseda (`Disallow: /` data host,
   D-019) both punish bursts. Do **not** remove or fixed-interval-ise the pace.
   For long sweeps the dwell BASE lengthens stepwise (`batch.js paceBaseMs`:
   +2 s every 25 pages, capped at +12 s) — a 100+ listing run is 10–15 min of
   steady navigation, the most likely rate-trip, so late pages space out while
   the 4–9 s minimum still holds at the start. Chosen over capping a run,
   because "click once" means the operator shouldn't have to re-trigger.
3. **The run survives MV3 worker eviction.** The driver loop is in-memory but
   the queue *state* — and the id of the tab currently open — persist in
   `chrome.storage.session`. A watchdog re-attaches a stranded run (persisted
   state `running` but no active loop): `chrome.alarms` (30 s), plus
   `onStartup`/`onInstalled`, plus every popup open (`GET_BATCH_STATE`) call
   `reattachIfStranded()`, which closes the tab orphaned at eviction time
   (`batch.js orphanTabToClose`) and restarts the loop from the persisted
   index. Re-opening a page that was mid-capture at eviction is safe — capture
   is idempotent (worklist `match_key` + the content-script fire-once guard).
   Requires the `alarms` permission.
4. The old human-paced affordances survive only as a **manual fallback**:
   `firstPendingUrl` / "Abrir siguiente pendiente" open one pending listing by
   hand. Their docstrings are rewritten to say so — a future agent reading them
   cold must not "restore" the anti-auto-advance stance this decision overturns.

**Alternatives rejected**:
- *A wall of background tabs (open N at once).* Chrome throttles unfocused tabs
  and defers their JS; auto-capture waits up to 20 s for render, so most tabs
  never render and never capture. The issue names this explicitly.
- *Server-side automated fetch of the portal.* Never — the whole capture path
  exists because these portals wall off automated crawling (D-019/D-026/D-027).
  Every page load must be the extension driving a real browser the human asked
  to batch.
- *Keeping the one-tab-per-click design.* Directly contrary to the owner's
  "click once" north-star for #262.

**Rationale**: Active-tab automation is the only way to both defeat render
throttling and remove the per-listing click. Keeping the queue strictly
sequential + jittered preserves the good-neighbour posture (#237 §7) the
human-paced design was protecting, without the babysitting the owner no longer
wants. This is stated as the target automation level for ALL capture-based
connectors.

**See**: issue #262 (incl. the review requesting the eviction-recovery
watchdog + long-run backoff); `browser-extension/batch.js` (`paceBaseMs`,
`shouldReattach`, `orphanTabToClose`), `browser-extension/background.js`
(Batch capture + `reattachIfStranded` / watchdog alarm),
`browser-extension/detect.js` (`isListingPath` / `extractDetailUrls`),
`browser-extension/manifest.json` (`alarms` permission),
`dashboard/lib/worklist.ts` (`firstPendingUrl` / `pendingUrls`),
`dashboard/app/etl/captura/page.tsx`; D-037 (Aliseda guided capture),
D-019 (Aliseda not viable), #254 (auto-capture), #260/#261 (worklist).
