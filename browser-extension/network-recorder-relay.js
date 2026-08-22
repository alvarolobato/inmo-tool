/**
 * network-recorder-relay.js — ISOLATED-world bridge for network capture
 * (issue #671 follow-up). MAIN-world scripts (network-recorder-main.js) can't
 * call `chrome.runtime.sendMessage` directly — only an ISOLATED-world content
 * script can talk to the background service worker. This file's only job is
 * to listen for the `window.postMessage` envelope the MAIN-world recorder
 * emits and forward it, unchanged (it is already redacted/truncated by
 * network-recorder.js's `summarizeEntry` before it ever leaves the page's own
 * JS context), to background.js.
 *
 * Dynamically registered ALONGSIDE network-recorder-main.js/network-
 * recorder.js for the same origin (background.js `armNetworkRecording`,
 * world:'ISOLATED', run_at:'document_start') — never in manifest.json's
 * static content_scripts, and unregistered the moment the session ends
 * (background.js `disarmNetworkRecording`).
 */

(function () {
  "use strict";

  window.addEventListener("message", function (event) {
    // Same-origin, same-window messages only — never relay anything from an
    // embedded cross-origin iframe or a page script pretending to be us.
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    var data = event.data;
    if (!data || data.source !== "inmo-diag-recorder" || data.type !== "NETWORK_ENTRY") return;
    try {
      chrome.runtime.sendMessage({ type: "NETWORK_ENTRY", entry: data.entry }, function () {
        // Best-effort: swallow "receiving end does not exist" if the worker
        // is asleep between messages — a lost entry doesn't break capture.
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* extension context may be gone (reload race) — never break the page */
    }
  });
})();
