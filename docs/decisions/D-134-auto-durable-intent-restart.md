---
id: D-134
title: Auto-capture durable intent survives a browser restart
date: 2026-08-20
group: Data / connectors
rule: The extension's auto-capture record splits {enabled,portal,force} into chrome.storage.local (durable, restart-safe) from run state in chrome.storage.session (volatile) — getAutoState/setAutoState compose/decompose them. A run-state-only update MUST go through setAutoRunState (session only), never setAutoState with a spread pre-await `auto` snapshot — that resurrects a stale durable intent (e.g. an operator's Stop) and, post-split, makes it survive every future restart.
---

# D-134: Auto-capture durable intent survives a browser restart

*Decided: 2026-08-20*

**Context**: Auto mode (#424/#516) is an alarm-driven loop whose whole record —
including `enabled` — lived in `chrome.storage.session`. Chrome wipes
`storage.session` on every browser close (not just a worker eviction). On the
next launch, `onStartup` → `autoTick()` read `getAutoState()` as `null` →
`nextAutoAction` had nothing to evaluate → `disarmAutoAlarm()`. The owner
turns Auto on, closes the browser, and it comes back silently OFF with no
signal (#587) — the opposite of "vuelva a ejecutar [auto] al día siguiente,
haciendo polling" (his ask), and worse, indistinguishable in the popup from a
correctly-idling scheduler.

**Decision**: Split the auto record across two storage areas:
- **Durable intent** — `{enabled, portal, force}`, what the operator asked
  for — persists in `chrome.storage.local` (survives a full browser restart,
  key `inmoAutoIntent`).
- **Volatile run state** — `status`, `harvestTask`, `lastBatchAt`,
  `batchesDone`, `totalPending`, the cached `batchSize`/`timeoutSec` —
  stays in `chrome.storage.session` (key `inmoAuto`, unchanged), safe to lose
  on a real restart since the tabs/enumeration it describes are gone too.

`background.js`'s `getAutoState()`/`setAutoState()` are the only two
functions that know about the split — they compose/decompose via
`InmoBatch.composeAutoState`/`InmoBatch.autoIntentFromState` (pure, unit
tested in `batch.js`), so every other caller (`nextAutoAction`,
`recoverStrandedHarvest`, `runAutoBatch`, the popup) still sees the one full
auto-state shape it always did. `composeAutoState(intent, session=null,
config)` with an enabled intent and no session yields a fresh `IDLE` state,
which `nextAutoAction` reads as `start` (re-plan) — that's the restart fix:
`onStartup` → `autoTick()` now re-arms instead of disarming. A worker
*eviction* (not a restart) still leaves `chrome.storage.session` intact, so a
stranded `HARVESTING`/`RUNNING` state still resumes through the existing
`recoverStrandedHarvest`/`reattachIfStranded` paths, untouched by this split.

The popup gained an always-visible "Auto: ON — próxima comprobación HH:MM /
última tanda hace X" / "Auto: OFF" line (`renderAutoArmedStatus`), reading the
*actual* armed `chrome.alarms.get('inmoAutoNext')` entry rather than a derived
estimate — so a silently-dead scheduler renders differently from a live one,
which is the whole point: showing "armed" while a dead timer sits behind it
is worse than showing nothing.

Separately, `capture.staleness_days_idealista` (`config/schema.yaml`) default
changed from `null` (inherits the global `capture.staleness_days=7`) to `1`,
so Idealista capture tasks become due again the next day — matching "al día
siguiente" — without touching the global default or unifying it with
`connector_config.freshness_interval_hours` (that unification is #588,
sequenced after this).

**Alternatives rejected**:
- *A client-side "expired" clock derived from `lastBatchAt`* — rejected:
  staleness is already server-owned (`/api/etl/auto-plan` reuses the same
  `taskStaleness` `/captura` renders); a second notion of "expired" in the
  extension would drift from it. This issue only fixes *persistence* of the
  intent to run, not *what* is due.
- *A second scheduler/queue in the extension* — rejected: the existing
  alarm-driven loop (D-043 bounded concurrency, D-112 pending-search queue,
  D-113 fragment handoff) already does exactly what's needed; this only fixes
  where its "am I on" bit lives.

**Rationale**: The bug was pure persistence-layer, not a scheduling design
flaw — the loop's mechanics (alarms, not `setTimeout`; eviction recovery)
were already correct. Splitting by *volatility* rather than adding a new
subsystem keeps every existing consumer's contract unchanged and is provable
with a fresh-module-instance unit test that simulates a restart (durable
storage carried over, session storage and armed alarms wiped) without needing
a real browser.

**Amendment (2026-08-20, PR #613 review)**: the first cut of this split had a
real bug — every run-state update (`deferAutoTick`, the PLANNING/HARVESTING/
RUNNING/EMPTY/WAITING transitions in `runAutoBatch`/`onAutoBatchComplete`)
went through `setAutoState({ ...auto, ... })`, spreading a SNAPSHOT of `auto`
taken before an `await` (often the `fetchAutoPlan` network round trip). If the
operator pressed Stop during that window, `stopAuto()`'s durable-intent write
would be silently undone the instant the in-flight snapshot's write landed —
and because that write now goes to `chrome.storage.local`, the resurrected
`enabled:true` would have survived every future restart, not just until the
next browser close. Fixed by adding `setAutoRunState(patch)`
(`browser-extension/background.js`), which touches ONLY
`chrome.storage.session` — every run-state-only call site now uses it;
`setAutoState` (which writes both halves) is reserved for `startAuto`/
`stopAuto`/`setAutoForce`, the three functions that legitimately change what
the operator asked for. **Binding going forward**: a new call site that needs
to record run-state (status, `harvestTask`, `lastBatchAt`, `batchesDone`,
`totalPending`) must use `setAutoRunState`, never `setAutoState` with a
spread `auto` snapshot — spreading a pre-`await` snapshot into `setAutoState`
is exactly the bug this amendment fixes.

**See**: `browser-extension/background.js` (`getAutoIntent`/`getAutoSession`/
`getAutoState`/`setAutoState`/`setAutoRunState`/`getNextAutoCheckAt`),
`browser-extension/batch.js` (`composeAutoState`/`autoIntentFromState`),
`browser-extension/popup.js` (`renderAutoArmedStatus`),
`dashboard/__tests__/extension-auto-restart.test.ts`,
`dashboard/__tests__/extension-batch.test.ts`,
`dashboard/__tests__/extension-popup-armed-status.test.ts`, issue #587, #588 (cadence-knob
unification, not done here).
