---
id: D-164
title: Network capture is armed durably and torn down unconditionally; response bodies are not redacted
date: 2026-08-22
group: Data / connectors
rule: "Recorder teardown reads storage.session + getRegisteredContentScripts(), never a Map; persistAcrossSessions:false, respawn sweep, onRemoved, 5-min expiry. Bodies are not sanitised."
---

# D-164: Network capture is armed durably and torn down unconditionally; response bodies are not redacted

*Decided: 2026-08-22*

**Context**: The owner asked for network capture alongside "forzar captura +
diagnóstico" — *"además debería capturar las llamadas rest etc aunque eso
implique recargar la página, de forma que angular o react se capturen."* A DOM
snapshot cannot contain data that arrives by XHR after render: Hipoges' results
page is an Angular shell whose listings are fetched separately, and idealista's
gallery lazy-loads the same way.

PR #675 built it and the fresh-context review found the armed-recorder
lifecycle unshippable, so the button was pulled before merge and the modules
were parked, unreachable, under a `DO-NOT-REWIRE` header. D-153 deliberately
recorded **no** decision about network capture; issue #684 holds the full
static analysis. The defect, in one line: `disarmNetworkRecording` guarded on
`networkBuffers.has(tabId)`, and `networkBuffers` is an in-memory `Map` in an
MV3 service worker that Chrome evicts after ~30 s idle. On the **documented
happy path** — arm, reload, page settles, no more messages, worker dies — the
Map was gone, so disarm returned `null` *before* reaching
`unregisterContentScripts`. Two failures at once: the buffer was silently lost
(`network: null`, so the feature returned nothing in normal use) **and the
MAIN-world `fetch`/`XHR` wrapper stayed registered** — on every tab of the
origin, indefinitely, and across browser restarts, because
`registerContentScripts` omitted `persistAcrossSessions: false` (which defaults
to `true`) and no sweep ever looked for a surviving `inmo-diag-*`.

**Decision**:

1. **Teardown never reads volatile state.** `disarmNetworkRecording` calls
   `unregisterContentScripts` **first, unconditionally**, before it consults
   any state at all. "Is there a buffer for this tab" and "is there a
   registration for this tab" are independent facts; conflating them was the
   whole defect. The buffer itself moved from an in-memory `Map` into
   `chrome.storage.session` (which survives an eviction; only a browser close
   clears it), with appends serialised through one promise chain so a burst of
   relay messages cannot lose entries to read-modify-write races. The armed
   registry (`diagArmed`) lives there too and is what every path consults.

2. **Four independent nets, because there were three ways to stay armed.**
   - `persistAcrossSessions: false` on both registrations.
   - `sweepStrandedNetworkRecorders()` reconciles
     `chrome.scripting.getRegisteredContentScripts()` against `diagArmed` on
     every worker respawn (top-level), `onStartup` and `onInstalled`, and
     unregisters every `inmo-diag-*` id nothing claims. It reconciles against
     **Chrome's own registry**, not a mirror of our intent, which is what makes
     it correct for a recorder registered by an 0.18.0-or-earlier build that
     really was persistent. After a restart `storage.session` is empty by
     definition, so every survivor is stranded and goes.
   - `chrome.tabs.onRemoved` disarms (it previously only called
     `endValidation`).
   - A 5-minute `expiresAt` on every armed session, enforced by a 1-minute
     `chrome.alarms` tick, bounds the owner who arms a recording and never
     sends.
   The popup also shows an armed recording with a live entry count and an
   explicit "Detener grabación", reading the same durable state — an armed
   recorder is never invisible.

3. **Interception is confined to the armed tab by a handshake, because
   `registerContentScripts` has no per-tab filter.** The ISOLATED-world relay
   asks the worker `NETWORK_RECORDER_HELLO` at `document_start`; the worker
   answers from `_sender.tab.id`, which page script cannot forge. A tab told
   `armed: false` makes the MAIN-world recorder **uninstall itself** — restore
   `window.fetch` and the three `XMLHttpRequest.prototype` methods it wrapped —
   and discard everything it buffered. Until the verdict arrives the recorder
   buffers and emits **nothing**, so no foreign tab's traffic can leave the
   page even transiently. What remains, honestly: `fetch`/`XHR` **are** wrapped
   on every tab of the origin for the duration of that round-trip (a
   possibly-cold service worker, so tens to hundreds of ms). That is
   unavoidable without a per-tab registration API, and the `confirm()` says so
   in as many words rather than describing the feature more flatteringly than
   it behaves.

4. **Redaction: substring matching for URL parts, and the path and fragment are
   in scope.** PR #675 matched query-param names by **exact** name only,
   justified in a comment as avoiding "an overzealous substring match" mangling
   the path. That justification is simply wrong — `URLSearchParams.forEach`
   iterates parameter *names* and structurally cannot reach the path — so the
   rule bought nothing and missed `password`, `pwd`, `passwd`, `jwt`, `bearer`,
   `credential`, `signature` and every portal-specific `x_session_token`-shaped
   name. Matching is now substring, aligned with the header path, with one
   deliberate exception: `key`, `code`, `state`, `sid`, `sess`, `sig` stay
   **exact**, because over-redaction is *not* free for a URL the way it is for
   a header — a recorded URL is the primary diagnostic signal, and a Spanish
   real-estate portal legitimately carries `provincia_code`, `estado`,
   `residencial`, `design`. `redactUrl` now also covers:
   - **URL fragments**, which it never touched (`url.searchParams` does not see
     `url.hash`), so `#access_token=…` — the OAuth implicit-flow shape —
     survived whole. An SPA hash route keeps its route and loses only the
     credential half; an untouched fragment is returned byte-identical rather
     than round-tripped through `URLSearchParams`.
   - **path segments**: a literal JWT anywhere, and a ≥8-char segment whose
     preceding segment is credential-shaped (`/api/v1/session/<jwt>/…`). Narrow
     on purpose — a listing id or a slug is the diagnostic.

5. **Response bodies are NOT sanitised, and D-153's "credentials stripped
   before anything is sent" must not be read as covering them.** A body is
   truncated at 20 KB (always visibly) and scrubbed of the three credential
   shapes that carry zero diagnostic value — a JSON value under a
   credential-shaped key, a `Bearer …`/`Basic …` literal, a bare JWT — and that
   is all. Whatever else the portal returned, **including personal data about
   an owner**, reaches `extension_diagnostic.network` verbatim. This is
   inherent to the feature's purpose: the body IS the payload the diagnostic
   exists to show. The bound on it is `purge_extension_diagnostics()` (30 days,
   D-153 point 6), which covers `network` because it is a column on
   `extension_diagnostic` and the purge DELETEs the row — pinned by a real-DB
   test rather than left as an inference.
   **Request bodies are never captured at all** (neither wrapper reads
   `init.body` nor `send()`'s argument). Good for privacy; it also means a
   POST's payload is invisible, so "what did the app *send* to that endpoint"
   is a question this feature cannot answer.

6. **The relay requires a nonce, and says plainly what that is worth.** PR
   #675's relay forwarded any message with `event.source === window`,
   `event.origin === location.origin` and `data.source ===
   "inmo-diag-recorder"` — all three trivially forgeable by any script on the
   page, so a portal could fabricate entries into a diagnostic. Every envelope
   must now echo a per-session nonce the background minted at arm time and
   handed to the relay over `chrome.runtime` (out of band from the page); the
   background re-checks it. **Honest limit**: the relay passes that nonce on to
   the MAIN world by `window.postMessage`, because MAIN↔ISOLATED has no
   page-invisible channel — isolated worlds share the DOM but not expandos, and
   a transferred `MessagePort` is delivered to every `message` listener on the
   window, page ones included. Both messages go out at `document_start`, before
   the page's first script runs, so an attacker must be built to race this
   specific handshake. That is a raised bar, not a proof, and it is recorded as
   such rather than as "the relay is now authenticated".

7. **Fingerprinting markers removed; `toString` deliberately not faked.** The
   recorder no longer sets `self.__inmoDiagRecorderInstalled` /
   `self.__inmoDiagT0` on the page's own `window`, no longer stamps
   `__inmoDiag*` expandos on every `XMLHttpRequest` the page creates (a
   `WeakMap` now), and no longer installs a function named `inmoDiagFetch`. Any
   portal script could read those and identify the browser as running a capture
   extension — a self-inflicted detection risk on exactly the WAF-protected
   sites this repo keeps getting 403'd by (D-026 Sareb/Incapsula, D-027
   Altamira/Akamai). The install guard is a non-enumerable `Symbol.for` property
   whose key names neither the extension nor the vendor.
   **What is deliberately NOT done**: `Function.prototype.toString` is not
   overridden to report `[native code]`, so a page that stringifies
   `window.fetch` can still see it is wrapped. Removing gratuitous markers is
   hygiene; lying about the browser's own state to defeat detection is evasion,
   and that is the line issue #1 §15 / D-026 / D-027 / D-033 draw. The wrapper
   remains a pure passthrough — `originalFetch.apply(this, arguments)`, issued
   once, nothing spoofed, nothing retried or replayed.

8. **A host grant the recording created is handed back on disarm; one it did
   not create is left alone.** `chrome.permissions.remove` appeared nowhere
   before, so every origin the owner ever diagnosed kept a standing grant. The
   popup (the only context with a user-activation signal) reports whether its
   `permissions.request` is what *created* the grant, and disarm revokes only
   in that case — revoking an origin the owner had already granted for capture
   would silently break batch capture as a side effect of a diagnostic.

**Alternatives rejected**:
- *Keep the in-memory `Map` and add a `storage.session` mirror alongside it* —
  rejected: two sources of truth for the same fact is how the original bug got
  written. Teardown reads durable state, full stop.
- *Sweep by mirroring what we registered into `storage.local`* — rejected in
  favour of reconciling against `getRegisteredContentScripts()`. A mirror
  cannot see a registration written by a build that predates the mirror, which
  is precisely the 0.18.0-persistent-recorder case the sweep exists for.
- *Delay installing the MAIN-world wrappers until the armed handshake
  completes*, so a non-armed tab is never wrapped at all — rejected: the
  wrapper must be in place before the SPA's bundle issues its first `fetch`,
  which is the entire reason a reload is required. Buffer-then-uninstall keeps
  the capture correct and confines the exposure to a round-trip.
- *`chrome.debugger` instead of monkey-patching* — rejected (unchanged from PR
  #675): it means a permanent "being debugged" infobar on every tab, a far
  heavier grant for an occasional diagnostic. `chrome.webRequest` cannot
  substitute: MV3 gives it no response bodies.
- *Substring-matching every query-param name, including `code`/`state`/`key`* —
  rejected: it shreds a Spanish portal's own filters and the URL is the
  diagnostic. Two tiers instead.
- *Redacting response bodies generically* — rejected as impossible without
  destroying the feature; stated plainly as a residual exposure instead, with
  the 30-day purge as the bound.
- *Faking `fetch.toString()`* — rejected as evasion; see point 7.

**Rationale**: the half that shipped in #675 answered "what did the page look
like"; this half answers "what did the app actually fetch", which is the
question three separate investigations (#654, #547, the Hipoges 0-of-17
results page) needed. It is only worth shipping if an armed recorder cannot
outlive the moment the owner armed it — a `fetch` wrapper left running on a
third party's site is a worse bug than the one it diagnoses.

## What is NOT verified, and the smoke test that would verify it

**A MAIN-world wrapper cannot be verified without a browser, and the original
author could not verify it either — that gap is part of why this was pulled.
Do not read the unit suite as proof the lifecycle is fixed.**

What the tests do cover: `disarmNetworkRecording` unregisters with nothing
buffered and with nothing registered; `persistAcrossSessions: false` on both
scripts; the respawn sweep unregisters stranded ids, spares an active session's,
and ignores ids that are not ours; `onRemoved` disarms; expiry disarms past
`expiresAt` and spares a live session; a buffer written before a simulated
worker respawn is still readable after it; the `NETWORK_RECORDER_HELLO` reply
for the armed tab vs. any other; a forged/nonce-less/cross-origin `postMessage`
is rejected by the relay; no `__inmoDiag*` own-property on `window` or on an
`XMLHttpRequest`; the wrapper is anonymous; the MAIN recorder emits nothing
before the verdict, flushes on ARMED and restores `fetch`/XHR on NOT_ARMED; the
redaction cases for `#access_token=…`, a JWT path segment and
`password`/`jwt`/`code`. All of that runs against a hand-written `chrome` stub
in Node, or in jsdom.

What no test here can reach: a real MV3 service worker being evicted, a real
browser restart, real `document_start` ordering against a page's own scripts, a
real second tab, and whether Chrome's `registerContentScripts` behaves as
assumed.

**Smoke test the owner should run** (extension 0.19.0, on a real Angular portal
page):

1. Open the page, click **Grabar red y recargar**, accept the `confirm()`. The
   page reloads and the popup shows `● Grabando red · N llamadas`.
2. **Wait 60 s without touching the popup or the page**, so the service worker
   is evicted. (`chrome://serviceworker-internals` or the extension's card on
   `chrome://extensions` shows it stop.)
3. Click **Forzar captura + diagnóstico**. It must arrive at
   `/admin/diagnostics` with a **non-empty** network entry count — that is the
   half of B1 that used to return `network: null` every time.
4. On `chrome://extensions` → the extension's **service worker** link, run in
   the console:
   `await chrome.scripting.getRegisteredContentScripts()`
   The result must contain **no** id starting with `inmo-diag-`. That is the
   other half of B1.
5. Repeat steps 1–2, then **close the tab** instead of sending, and re-run the
   step-4 check. Then repeat again and simply **wait 6 minutes**, and re-run it.
   Both must come back clean.
6. With a recording armed for tab A, open a second tab B on the same origin and
   confirm in B's console that `window.fetch` is back to
   `function fetch() { [native code] }` shortly after load, and that the
   diagnostic from A contains no request that only B made.
7. Finally, **quit and reopen Chrome** with a recording armed, and re-run the
   step-4 check on the fresh session.

**See**: `browser-extension/background.js` (the "armed-recorder lifecycle"
block: `armNetworkRecording`, `disarmNetworkRecording`, `recordNetworkEntry`,
`sweepStrandedNetworkRecorders`, `expireStaleNetworkRecordings`),
`browser-extension/network-recorder.js`,
`browser-extension/network-recorder-main.js`,
`browser-extension/network-recorder-relay.js`, `browser-extension/popup.js`,
`etl/schema/init.sql` (`extension_diagnostic.network`,
`purge_extension_diagnostics`),
`dashboard/__tests__/extension-diagnostic-background.test.ts`,
`dashboard/__tests__/extension-network-recorder.test.ts`,
`dashboard/__tests__/extension-network-recorder-wiring.test.ts`,
`dashboard/app/api/extension/__tests__/diagnostic-persistence.integration.test.ts`,
D-153, D-161 (the manifest bump that makes 0.19.0 reachable), D-026, D-027,
D-033, issues #671, #684, PR #675.
