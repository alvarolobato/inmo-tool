/**
 * network-recorder-main.js — MAIN-world fetch/XHR interception (issue #671
 * follow-up: capture the REST calls Angular/React pages make, not just the
 * DOM snapshot, because the DOM never contains data that arrives by XHR
 * after render — see network-recorder.js's header comment for the full
 * rationale and the D-033/no-back-door constraint this obeys).
 *
 * WHY MAIN world + monkey-patching, not `chrome.debugger`: this extension has
 * no `debugger` permission and adding one means a permanent "being debugged"
 * infobar on every tab it's used on — a much heavier, more alarming grant for
 * a diagnostic feature the owner reaches for occasionally. Wrapping
 * `window.fetch`/`XMLHttpRequest` from the page's OWN JS context, installed
 * BEFORE the app boots, is the standard way to see request/response bodies
 * in MV3 without it — `chrome.webRequest` alone cannot: MV3 gives no
 * response bodies there.
 *
 * This is why a RELOAD is required and owner-initiated (never silent): the
 * wrapper has to be in place before Angular/React's own bundle runs its
 * first `fetch`, which means before the page's own script starts executing
 * at all.
 *
 * This file is dynamically registered (background.js `armNetworkRecording`,
 * `chrome.scripting.registerContentScripts`, world:'MAIN', run_at:
 * 'document_start') scoped to ONE origin for ONE recording session — it is
 * NEVER declared in manifest.json's static content_scripts, so it is not
 * present on a normal page load. It is unregistered again as soon as the
 * diagnostic is sent (or the session times out) — see background.js
 * `disarmNetworkRecording`. A recorder left running silently would be both a
 * privacy and a storage problem; this file makes no attempt to detect "am I
 * still wanted" itself — that lifecycle is background.js's job entirely.
 *
 * Loaded together with network-recorder.js (same MAIN-world registration,
 * this file second) so both share `self` — same classic-script sharing
 * pattern as detect.js/content-script.js in the isolated world.
 */

(function () {
  "use strict";

  // Idempotency guard: a stale registration racing a fresh one (or a page
  // that somehow gets this injected twice) must not double-wrap fetch/XHR.
  if (self.__inmoDiagRecorderInstalled) return;
  self.__inmoDiagRecorderInstalled = true;

  // Reference point EVERY recorded timestamp is relative to (not wall-clock —
  // see network-recorder.js summarizeEntry's startedAtMs/finishedAtMs
  // comment). Installed as early as document_start allows, i.e. as close to
  // "navigation start" as this technique can get without `chrome.debugger`.
  var T0 = Date.now();
  self.__inmoDiagT0 = T0;

  var NR = self.InmoNetworkRecorder;
  // network-recorder.js failed to load — nothing safe to do (we must not
  // record raw, unredacted entries without it). Leave fetch/XHR untouched.
  if (!NR) return;

  // Client-side cap independent of background.js's storage cap (NR.MAX_ENTRIES)
  // — stop even LOOKING at new requests once this many have been recorded in
  // this page's lifetime, so a chatty SPA can't grow this file's own memory
  // footprint unboundedly between relay flushes.
  var MAX_RAW_ENTRIES = 500;
  var recordedCount = 0;

  // Only attempt to read a response body as text for content-types where that
  // makes sense — never a video/image/binary blob (wasted read, no useful
  // diagnostic value). Response with no content-type header still gets a
  // best-effort text read (many JSON APIs omit it during dev).
  var TEXT_LIKE_CONTENT_TYPE = /json|text|xml|javascript|html|form-urlencoded/i;
  var MAX_BODY_READ_BYTES = 2 * 1024 * 1024; // don't even attempt to read a multi-MB body

  function postEntry(raw) {
    if (recordedCount >= MAX_RAW_ENTRIES) return;
    recordedCount++;
    var entry;
    try {
      entry = NR.summarizeEntry(raw);
    } catch (e) {
      return; // never let a shaping bug crash the page
    }
    try {
      window.postMessage(
        { source: "inmo-diag-recorder", type: "NETWORK_ENTRY", entry: entry },
        window.location.origin,
      );
    } catch (e) {
      /* best-effort — a lost entry is not worth breaking the page over */
    }
  }

  function headerEntriesFromHeadersObj(headers) {
    var out = [];
    if (!headers || typeof headers.forEach !== "function") return out;
    try {
      headers.forEach(function (value, name) {
        out.push([name, value]);
      });
    } catch (e) {
      /* best-effort */
    }
    return out;
  }

  function shouldReadBody(headers, contentLengthHeader) {
    var len = parseInt(contentLengthHeader, 10);
    if (!isNaN(len) && len > MAX_BODY_READ_BYTES) return false;
    var contentType = "";
    try {
      contentType = (headers && headers.get && headers.get("content-type")) || "";
    } catch (e) {
      contentType = "";
    }
    if (!contentType) return true; // best-effort — many JSON APIs omit it
    return TEXT_LIKE_CONTENT_TYPE.test(contentType);
  }

  // ── fetch() ────────────────────────────────────────────────────────────
  var originalFetch = self.fetch;
  if (typeof originalFetch === "function") {
    self.fetch = function inmoDiagFetch(input, init) {
      var startedAtMs = Date.now() - T0;
      var method = (init && init.method) || (input && input.method) || "GET";
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      var reqHeaders = [];
      try {
        var initHeaders = (init && init.headers) || (input && input.headers);
        if (initHeaders) {
          if (initHeaders instanceof Headers) reqHeaders = headerEntriesFromHeadersObj(initHeaders);
          else if (Array.isArray(initHeaders)) reqHeaders = initHeaders;
          else {
            for (var k in initHeaders) {
              if (Object.prototype.hasOwnProperty.call(initHeaders, k)) reqHeaders.push([k, initHeaders[k]]);
            }
          }
        }
      } catch (e) {
        reqHeaders = [];
      }

      return originalFetch.apply(this, arguments).then(
        function (response) {
          try {
            var resHeaders = headerEntriesFromHeadersObj(response.headers);
            var contentLength = response.headers && response.headers.get && response.headers.get("content-length");
            if (shouldReadBody(response.headers, contentLength)) {
              response
                .clone()
                .text()
                .then(
                  function (bodyText) {
                    postEntry({
                      url: url,
                      method: method,
                      status: response.status,
                      type: "fetch",
                      requestHeaders: reqHeaders,
                      responseHeaders: resHeaders,
                      body: bodyText,
                      bodyReadable: true,
                      startedAtMs: startedAtMs,
                      finishedAtMs: Date.now() - T0,
                    });
                  },
                  function () {
                    postEntry({
                      url: url,
                      method: method,
                      status: response.status,
                      type: "fetch",
                      requestHeaders: reqHeaders,
                      responseHeaders: resHeaders,
                      bodyReadable: false,
                      startedAtMs: startedAtMs,
                      finishedAtMs: Date.now() - T0,
                    });
                  },
                );
            } else {
              postEntry({
                url: url,
                method: method,
                status: response.status,
                type: "fetch",
                requestHeaders: reqHeaders,
                responseHeaders: resHeaders,
                bodyReadable: false,
                startedAtMs: startedAtMs,
                finishedAtMs: Date.now() - T0,
              });
            }
          } catch (e) {
            /* recording must never break the page's own fetch consumer */
          }
          return response;
        },
        function (err) {
          postEntry({
            url: url,
            method: method,
            status: null,
            type: "fetch",
            requestHeaders: reqHeaders,
            responseHeaders: [],
            bodyReadable: false,
            startedAtMs: startedAtMs,
            finishedAtMs: Date.now() - T0,
          });
          throw err;
        },
      );
    };
  }

  // ── XMLHttpRequest ────────────────────────────────────────────────────
  var OriginalXHR = self.XMLHttpRequest;
  if (typeof OriginalXHR === "function") {
    var originalOpen = OriginalXHR.prototype.open;
    var originalSend = OriginalXHR.prototype.send;
    var originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;

    OriginalXHR.prototype.open = function (method, url) {
      this.__inmoDiagMethod = method;
      this.__inmoDiagUrl = url;
      this.__inmoDiagReqHeaders = [];
      return originalOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.setRequestHeader = function (name, value) {
      if (this.__inmoDiagReqHeaders) this.__inmoDiagReqHeaders.push([name, value]);
      return originalSetRequestHeader.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function () {
      var xhr = this;
      var startedAtMs = Date.now() - T0;
      try {
        xhr.addEventListener("loadend", function () {
          try {
            var rawHeaders = xhr.getAllResponseHeaders() || "";
            var resHeaders = rawHeaders
              .trim()
              .split(/\r?\n/)
              .filter(Boolean)
              .map(function (line) {
                var idx = line.indexOf(":");
                if (idx === -1) return [line, ""];
                return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
              });
            var readable = xhr.responseType === "" || xhr.responseType === "text";
            var body = readable ? xhr.responseText : undefined;
            if (readable && typeof body === "string" && body.length > MAX_BODY_READ_BYTES) {
              readable = false;
              body = undefined;
            }
            postEntry({
              url: xhr.__inmoDiagUrl,
              method: xhr.__inmoDiagMethod,
              status: xhr.status,
              type: "xhr",
              requestHeaders: xhr.__inmoDiagReqHeaders || [],
              responseHeaders: resHeaders,
              body: body,
              bodyReadable: readable,
              startedAtMs: startedAtMs,
              finishedAtMs: Date.now() - T0,
            });
          } catch (e) {
            /* recording must never break the page's own XHR consumer */
          }
        });
      } catch (e) {
        /* addEventListener best-effort */
      }
      return originalSend.apply(this, arguments);
    };
  }
})();
