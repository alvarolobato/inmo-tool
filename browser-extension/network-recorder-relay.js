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

  function install(nonce) {
    window.addEventListener("message", function (event) {
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

  try {
    chrome.runtime.sendMessage({ type: "NETWORK_RECORDER_HELLO" }, function (response) {
      // A missing worker / missing response is treated exactly like "not armed":
      // fail CLOSED, so the recorder uninstalls rather than sitting installed
      // with nowhere to send.
      void chrome.runtime.lastError;
      if (response && response.armed === true && response.nonce) {
        install(response.nonce);
      } else {
        tellMainWorld({ source: RELAY_SOURCE, type: "INMO_DIAG_NOT_ARMED" });
      }
    });
  } catch (e) {
    tellMainWorld({ source: RELAY_SOURCE, type: "INMO_DIAG_NOT_ARMED" });
  }
})();
