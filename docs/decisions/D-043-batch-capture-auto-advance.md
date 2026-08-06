---
id: D-043
title: Batch capture is a fully-automated bounded-concurrency queue in the extension, with jittered pacing
date: 2026-08-05
group: Data / connectors
rule: Batch capture is a fully-automated BOUNDED-CONCURRENCY queue in the extension (open→activate→auto-capture→close, up to N=3 tabs, hard-cap 5), seeded from a listing page. Keep the JITTERED/staggered launches — never fixed-interval, never an unbounded burst. Small N is mandatory (WAF + Chrome background-tab render throttling). Supersedes the human-paced one-tab-per-click design and the original sequential driver.
order: 46
---

# D-043: Batch capture is a fully-automated bounded-concurrency queue in the extension, with jittered pacing

*Decided: 2026-08-05 — revised 2026-08-05 (#318): sequential → bounded concurrency*

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
1. Batch capture is a **bounded-concurrency auto-advancing queue driven by the
   extension's background service worker** (`browser-extension/batch.js` pure
   logic + `background.js` tab wiring). It opens+activates up to
   **N detail tabs at a time** (`BATCH_CONCURRENCY`, default **3**, hard-capped
   at 5 by `batch.js clampConcurrency`), each awaiting the content script's
   existing `AUTO_CAPTURE_DONE` (or a timeout) and closing on all paths; the
   driver tops the in-flight pool back up whenever a tab settles. It is seeded
   from a listing/search page: the content script harvests detail anchors
   (`detect.js extractDetailUrls`), the worker POSTs them to `capture_worklist`
   (`added_via='derived'`), then sweeps the portal's `pending` set. The pure
   state is a **per-URL slot array** (`pending`/`inflight`/`captured`/`failed`,
   `batch.js launchNext`/`recordResultAt`), so out-of-order settlement across
   the concurrent tabs stays exact.

   *(Revised from the original #262 design, which drove this STRICTLY
   SEQUENTIALLY — one tab at a time. The owner (#318) found that too slow on
   long idealista sweeps and asked for several tabs at once with random waits.
   A future agent must not "restore" the one-at-a-time driver: N>1 is the
   point. Equally, N must stay small and capped — see below.)*
2. **N is small and CAPPED, and launches stay jittered.** Two hard constraints
   bound the concurrency:
   - **WAF safety.** Idealista (CAPTCHA wall) and Aliseda (`Disallow: /` data
     host, D-019) punish bursts. Launches are STAGGERED by a randomised delay
     (`batch.js jitterDelay`, 4–9 s minimum) — this is what keeps the N tabs
     from opening simultaneously. Never a fixed metronome, never an unbounded
     simultaneous burst. Do **not** remove or fixed-interval-ise the stagger,
     and do **not** raise the cap to make it "faster".
   - **Chrome background-tab render throttling.** Only the ACTIVE tab renders
     reliably; unfocused tabs' JS/rendering is deferred. Each launch activates
     its new tab, so the jittered stagger gives every tab a foreground window
     to render+capture before the next launch steals focus. Past a small N,
     later in-flight tabs sit throttled in the background and time out — MORE
     concurrency HURTS reliability rather than helping. **N=3 (cap 5)** is the
     balance between throughput and capture reliability.

   For long sweeps the launch-stagger BASE lengthens stepwise (`batch.js
   paceBaseMs`: +2 s every 25 pages, capped at +12 s) — a 100+ listing run is
   10–15 min of steady navigation, the most likely rate-trip, so late launches
   space out while the 4–9 s minimum still holds at the start. Chosen over
   capping a run, because "click once" means the operator shouldn't have to
   re-trigger.
3. **The run survives MV3 worker eviction.** The driver loop is in-memory but
   the queue *state* — including the per-URL slots and the ids of the tabs
   currently open (an array now, since several can be open at once) — persist in
   `chrome.storage.session`. A watchdog re-attaches a stranded run (persisted
   state `running` but no active loop): `chrome.alarms` (30 s), plus
   `onStartup`/`onInstalled`, plus every popup open (`GET_BATCH_STATE`) call
   `reattachIfStranded()`, which closes every tab orphaned at eviction time
   (`batch.js orphanTabsToClose`), **resets those `inflight` slots back to
   `pending`** (`batch.js resetInflightToPending`) so they re-launch, and
   restarts the loop. Re-opening a page that was mid-capture at eviction is
   safe — capture is idempotent (worklist `match_key` + the content-script
   fire-once guard). Requires the `alarms` permission.
4. The old human-paced affordances survive only as a **manual fallback**:
   `firstPendingUrl` / "Abrir siguiente pendiente" open one pending listing by
   hand. Their docstrings are rewritten to say so — a future agent reading them
   cold must not "restore" the anti-auto-advance stance this decision overturns.

**Alternatives rejected**:
- *An UNBOUNDED wall of background tabs (open all N at once).* Chrome throttles
  unfocused tabs and defers their JS; auto-capture waits up to 20 s for render,
  so most tabs never render and never capture — and a simultaneous burst trips
  the WAFs. The issue names this explicitly. Bounded concurrency (small N,
  jittered/staggered launches, each tab activated in turn) is the deliberate
  middle ground between this and one-at-a-time.
- *Strict one-tab-at-a-time (the original #262 design).* Too slow on long
  idealista sweeps; the owner (#318) explicitly asked for several tabs at once.
- *A large / unbounded / user-uncapped N.* Rejected: past a small N, background
  render throttling makes later tabs time out, and the burst risk to the WAF
  grows. `clampConcurrency` hard-caps at 5 so no config can turn the run into a
  tab bomb.
- *Server-side automated fetch of the portal.* Never — the whole capture path
  exists because these portals wall off automated crawling (D-019/D-026/D-027).
  Every page load must be the extension driving a real browser the human asked
  to batch.
- *Keeping the one-tab-per-click design.* Directly contrary to the owner's
  "click once" north-star for #262.

**Rationale**: Active-tab automation is the only way to both defeat render
throttling and remove the per-listing click. Bounded concurrency (small,
capped N) + jittered/staggered launches gives the operator the speed they
asked for (#318) while preserving the good-neighbour posture (#237 §7) the
human-paced design was protecting — the cap is what keeps "faster" from
becoming "a bot burst that gets us CAPTCHA-walled" or "tabs that never render".
This is stated as the target automation level for ALL capture-based connectors.

**See**: issue #262 (incl. the review requesting the eviction-recovery
watchdog + long-run backoff), #318 (sequential → bounded concurrency);
`browser-extension/batch.js` (`clampConcurrency`, `launchNext`,
`recordResultAt`, `resetInflightToPending`, `paceBaseMs`, `shouldReattach`,
`orphanTabsToClose`), `browser-extension/background.js` (Batch capture +
`runBatchLoop` bounded-concurrency driver + `reattachIfStranded` / watchdog
alarm, `BATCH_CONCURRENCY`), `browser-extension/detect.js` (`isListingPath` /
`extractDetailUrls`), `browser-extension/manifest.json` (`alarms` permission,
version 0.7.0), `dashboard/lib/worklist.ts` (`firstPendingUrl` / `pendingUrls`),
`dashboard/app/etl/captura/page.tsx`; D-037 (Aliseda guided capture),
D-019 (Aliseda not viable), #254 (auto-capture), #260/#261 (worklist).
