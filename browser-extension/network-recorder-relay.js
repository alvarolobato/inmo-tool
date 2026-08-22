/**
 * network-recorder-relay.js — ISOLATED-world bridge for network capture
 * (issue #671 follow-up; lifecycle rebuilt in #684). MAIN-world scripts
 * (network-recorder-main.js) can't call `chrome.runtime.sendMessage` — only an
 * ISOLATED-world content script can talk to the background service worker.
 *
 * It does two jobs, in this order:
 *
 *  1. **Tab scoping** (#684 B2). `chrome.scripting.registerContentScripts` has
 *     no per-tab filter, so arming a recording for one tab installs this pair
 *     on EVERY tab of that origin. This file asks the worker
 *     `NETWORK_RECORDER_HELLO` at document_start; the worker answers from
 *     `_sender.tab.id` — which the page cannot forge — and a tab that is not
 *     the armed one is told so, whereupon the MAIN-world recorder UNINSTALLS
 *     itself and drops everything it buffered. Interception still exists for
 *     the few milliseconds of that round-trip; that is unavoidable without a
 *     per-tab registration API, and the popup's confirm() discloses it.
 *
 *  2. **Forwarding**, with a nonce (#684 S5). PR #675's version relayed any
 *     message where `event.source === window`, `event.origin ===
 *     location.origin` and `data.source === "inmo-diag-recorder"` — all three
 *     trivially forgeable by ANY script on the page, so a portal could
 *     fabricate entries into a diagnostic. Every envelope now has to echo a
 *     per-session nonce the background generated at arm time and handed to
 *     this file over `chrome.runtime` (out of band from the page); the
 *     background re-checks it too.
 *
 *  3. **Teardown of the ALREADY-INJECTED wrapper** (#684 H1). Unregistering
 *     the content scripts governs FUTURE injections only — it does nothing to
 *     a document that already has the MAIN-world wrapper installed. Without
 *     this, `window.fetch` and the three `XMLHttpRequest.prototype` methods
 *     stayed wrapped for the life of the document after STOP / send / expiry
 *     / a sweep, still `postMessage`-ing summarised entries (URLs, headers,
 *     up-to-20 KB bodies) onto the page's own message bus where any page
 *     script could read them — reduced from #684's "every tab, forever" but
 *     the same shape, and flatly contrary to what the popup's confirm() tells
 *     the owner. The background now sends `NETWORK_RECORDER_DISARM` to the
 *     tab on every teardown path; this file turns that into the same
 *     `INMO_DIAG_NOT_ARMED` verdict the not-the-armed-tab path already used,
 *     which makes the MAIN world restore `fetch`/XHR and drop its buffer.
 *
 *     HONEST LIMIT: this file passes the nonce on to the MAIN world by
 *     `window.postMessage`, because MAIN↔ISOLATED has NO page-invisible
 *     channel — isolated worlds share the DOM but not expandos, and a
 *     transferred MessagePort is delivered to every `message` listener on the
 *     window, page ones included. Both messages are sent at document_start,
 *     before the page's first script runs, so a page that wants the nonce has
 *     to be built to race this handshake. That raises the bar from "any
 *     same-origin postMessage is trusted" to "an attacker must target this
 *     protocol specifically"; it is not a proof.
 *
 * Dynamically registered ALONGSIDE network-recorder-main.js/network-
 * recorder.js for the same origin (background.js `armNetworkRecording`,
 * world:'ISOLATED', run_at:'document_start', persistAcrossSessions:false) —
 * never in manifest.json's static content_scripts.
 */

(function () {
  "use strict";

  var RELAY_SOURCE = "inmo-diag-relay";
  var RECORDER_SOURCE = "inmo-diag-recorder";

  function tellMainWorld(message) {
    try {
      window.postMessage(message, window.location.origin);
    } catch (e) {
      /* best-effort — never break the page */
    }
  }

  // Set once the recording is over, by any route: the worker said this tab was
  // never the armed one, the handshake failed closed, or the background sent
  // NETWORK_RECORDER_DISARM. Latched, because teardown must be idempotent —
  // STOP followed by the expiry alarm followed by a sweep is a normal sequence.
  var disarmed = false;

  /** Tell the MAIN world to uninstall its wrapper and drop its buffer. */
  function goOff() {
    if (disarmed) return;
    disarmed = true;
    tellMainWorld({ source: RELAY_SOURCE, type: "INMO_DIAG_NOT_ARMED" });
  }

  function install(nonce) {
    window.addEventListener("message", function (event) {
      // Stop forwarding the instant the recording ends. The MAIN world stops
      // emitting too, but that is its decision to make — this side must not
      // depend on it to keep entries out of a torn-down session.
      if (disarmed) return;
      // Same-origin, same-window messages only — never relay anything from an
      // embedded cross-origin iframe.
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      var data = event.data;
      if (!data || data.source !== RECORDER_SOURCE || data.type !== "NETWORK_ENTRY") return;
      // …and it must carry this session's nonce. Everything above is forgeable
      // by page script; this is the part that isn't guessable.
      if (!nonce || data.nonce !== nonce) return;
      try {
        chrome.runtime.sendMessage(
          { type: "NETWORK_ENTRY", entry: data.entry, nonce: nonce },
          function () {
            // Best-effort: swallow "receiving end does not exist" if the worker
            // is asleep between messages — a lost entry doesn't break capture.
            void chrome.runtime.lastError;
          },
        );
      } catch (e) {
        /* extension context may be gone (reload race) — never break the page */
      }
    });
    // Only NOW does the MAIN world learn it may emit: it buffers until this
    // arrives, so nothing is lost while the handshake is in flight.
    tellMainWorld({ source: RELAY_SOURCE, type: "INMO_DIAG_ARMED", nonce: nonce });
  }

  // Registered BEFORE the HELLO goes out, so a disarm that lands while the
  // handshake is still in flight is not missed. `goOff` latches, so the
  // `install()` below is skipped if that happens.
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === "NETWORK_RECORDER_DISARM") goOff();
      // No `return true`: the background does not wait for a reply, it only
      // swallows `lastError` when the tab has no relay listening.
    });
  } catch (e) {
    /* extension context already gone — the timeout in the MAIN world is the
       remaining net */
  }

  try {
    chrome.runtime.sendMessage({ type: "NETWORK_RECORDER_HELLO" }, function (response) {
      // A missing worker / missing response is treated exactly like "not armed":
      // fail CLOSED, so the recorder uninstalls rather than sitting installed
      // with nowhere to send.
      void chrome.runtime.lastError;
      // A disarm beat the handshake — never arm after that.
      if (disarmed) return;
      if (response && response.armed === true && response.nonce) {
        install(response.nonce);
      } else {
        goOff();
      }
    });
  } catch (e) {
    goOff();
  }
})();
