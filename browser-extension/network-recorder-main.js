/**
 * network-recorder-main.js — MAIN-world fetch/XHR interception (issue #671
 * follow-up; rebuilt for #684). Captures the REST calls Angular/React pages
 * make, because the DOM never contains data that arrives by XHR after render —
 * see network-recorder.js's header for the full rationale, the exact redaction
 * inventory, and the D-033/no-back-door constraint this obeys.
 *
 * WHY MAIN world + monkey-patching, not `chrome.debugger`: this extension has
 * no `debugger` permission and adding one means a permanent "being debugged"
 * infobar on every tab it's used on — a much heavier, more alarming grant for
 * a diagnostic feature the owner reaches for occasionally. Wrapping
 * `window.fetch`/`XMLHttpRequest` from the page's OWN JS context, installed
 * BEFORE the app boots, is the standard way to see request/response bodies in
 * MV3 without it — `chrome.webRequest` alone cannot: MV3 gives no response
 * bodies there.
 *
 * This is why a RELOAD is required and owner-initiated (never silent): the
 * wrapper has to be in place before Angular/React's own bundle runs its first
 * `fetch`, i.e. before the page's own script starts executing at all.
 *
 * ## Armed-or-not, and why nothing is emitted until we know (#684 B2)
 *
 * `chrome.scripting.registerContentScripts` has no per-tab filter, so this
 * file is installed on every tab of the armed ORIGIN, not just the armed tab.
 * It therefore starts in a `waiting` state: wrappers installed (they must be,
 * to catch the boot fetches), entries buffered locally, NOTHING posted. The
 * ISOLATED-world relay asks the service worker whether THIS tab is the armed
 * one and answers back:
 *   INMO_DIAG_ARMED     → flush the buffer and stream from then on
 *   INMO_DIAG_NOT_ARMED → UNINSTALL (restore `fetch` and the XHR prototype
 *                         methods), discard the buffer, emit nothing ever
 * and if neither arrives within HANDSHAKE_TIMEOUT_MS (no relay, extension
 * context gone, worker wedged) it uninstalls too. Fail closed.
 *
 * ## Fingerprinting (#684 S6)
 *
 * PR #675's version set `self.__inmoDiagRecorderInstalled` / `self.__inmoDiagT0`
 * as plain string-keyed properties on the PAGE's `window`, and installed a
 * function literally named `inmoDiagFetch`. Any portal script could read
 * either property, or `String(window.fetch)`, and identify the browser as
 * running a capture extension — a self-inflicted detection risk on exactly the
 * WAF-protected sites this repo keeps getting 403'd by (D-026 Sareb/Incapsula,
 * D-027 Altamira/Akamai). The install guard is now a non-enumerable
 * Symbol-keyed property, T0 stays in the closure, per-XHR state lives in a
 * WeakMap instead of `__inmoDiag*` expandos, and the wrapper is anonymous.
 *
 * What is deliberately NOT done: `Function.prototype.toString` is not
 * overridden to report `[native code]`. A page that stringifies `window.fetch`
 * can still see it is wrapped. Faking that would be spoofing the browser's own
 * state to defeat detection, which is the line issue #1 §15 / D-026 / D-027 /
 * D-033 draw and this feature does not cross. Removing gratuitous markers is
 * hygiene; lying about them is evasion.
 *
 * Loaded together with network-recorder.js (same MAIN-world registration, this
 * file second) so both share `self`.
 */

(function () {
  "use strict";

  // Idempotency guard: a stale registration racing a fresh one must not
  // double-wrap fetch/XHR. Symbol-keyed and non-enumerable, and the key names
  // neither the extension nor the vendor — PR #675 used
  // `self.__inmoDiagRecorderInstalled`, a plain string property that told any
  // portal script exactly which extension was watching.
  //
  // It has to be `Symbol.for`, not `Symbol()`: two separate injections are two
  // separate script executions with two separate closures, so a non-registry
  // symbol would guard nothing. That means the property IS discoverable, via
  // `Object.getOwnPropertySymbols(window)` or by guessing the key. The gain is
  // real but bounded: no `__inmoDiag*` string, nothing that identifies WHICH
  // extension. See the header for where the line between hygiene and evasion
  // sits.
  var GUARD = Symbol.for("net-capture-guard");
  try {
    if (self[GUARD]) return;
    Object.defineProperty(self, GUARD, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch (e) {
    /* a frozen global — proceed uninstrumented rather than throw into the page */
    return;
  }

  var NR = self.InmoNetworkRecorder;
  // network-recorder.js failed to load — nothing safe to do (we must not
  // record raw, unredacted entries without it). Leave fetch/XHR untouched.
  if (!NR) return;

  // Reference point EVERY recorded timestamp is relative to (not wall-clock —
  // see network-recorder.js summarizeEntry's startedAtMs/finishedAtMs
  // comment). Installed as early as document_start allows, i.e. as close to
  // "navigation start" as this technique can get without `chrome.debugger`.
  // Kept in the closure: PR #675 published it as `self.__inmoDiagT0`.
  var T0 = Date.now();

  var RELAY_SOURCE = "inmo-diag-relay";
  var RECORDER_SOURCE = "inmo-diag-recorder";
  // How long to wait for the relay's verdict before uninstalling. Generous
  // enough for a service-worker cold start, short enough that a tab which is
  // NOT the armed one is back to stock `fetch` well inside a page's lifetime.
  var HANDSHAKE_TIMEOUT_MS = 10000;

  var state = "waiting"; // 'waiting' | 'armed' | 'off'
  var nonce = null;
  var pending = [];
  var uninstall = null;

  // Client-side cap independent of background.js's storage cap (NR.MAX_ENTRIES)
  // — stop even LOOKING at new requests once this many have been recorded in
  // this page's lifetime, so a chatty SPA can't grow this file's own memory
  // footprint unboundedly.
  var MAX_RAW_ENTRIES = 500;
  var recordedCount = 0;

  // Only attempt to read a response body as text for content-types where that
  // makes sense — never a video/image/binary blob (wasted read, no useful
  // diagnostic value). A response with no content-type header still gets a
  // best-effort text read (many JSON APIs omit it).
  var TEXT_LIKE_CONTENT_TYPE = /json|text|xml|javascript|html|form-urlencoded/i;
  var MAX_BODY_READ_BYTES = 2 * 1024 * 1024; // don't even attempt a multi-MB body

  function emit(entry) {
    try {
      window.postMessage(
        { source: RECORDER_SOURCE, type: "NETWORK_ENTRY", entry: entry, nonce: nonce },
        window.location.origin,
      );
    } catch (e) {
      /* best-effort — a lost entry is not worth breaking the page over */
    }
  }

  function postEntry(raw) {
    if (state === "off") return;
    if (recordedCount >= MAX_RAW_ENTRIES) return;
    recordedCount++;
    var entry;
    try {
      entry = NR.summarizeEntry(raw);
    } catch (e) {
      return; // never let a shaping bug crash the page
    }
    if (state === "armed") emit(entry);
    // 'waiting': hold it until the relay says whether this tab is the armed
    // one. Bounded by MAX_RAW_ENTRIES above.
    else pending.push(entry);
  }

  // ── Handshake with the ISOLATED-world relay ────────────────────────────
  var handshakeTimer = null;

  function settleArmed(sessionNonce) {
    if (state !== "waiting") return;
    state = "armed";
    nonce = sessionNonce;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    var queued = pending;
    pending = [];
    for (var i = 0; i < queued.length; i++) emit(queued[i]);
  }

  function settleOff() {
    if (state === "off") return;
    state = "off";
    pending = [];
    if (handshakeTimer) clearTimeout(handshakeTimer);
    // Put `fetch` and XMLHttpRequest back. This is what makes "every tab on
    // the origin is wrapped" a few-millisecond fact rather than a permanent
    // one for the tabs that are not being diagnosed.
    if (uninstall) {
      try {
        uninstall();
      } catch (e) {
        /* leave the wrapper in place rather than throw into the page; it is
           inert now that state === 'off' */
      }
      uninstall = null;
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    var data = event.data;
    if (!data || data.source !== RELAY_SOURCE) return;
    if (data.type === "INMO_DIAG_ARMED" && data.nonce) settleArmed(data.nonce);
    else if (data.type === "INMO_DIAG_NOT_ARMED") settleOff();
  });

  try {
    handshakeTimer = setTimeout(settleOff, HANDSHAKE_TIMEOUT_MS);
  } catch (e) {
    /* no timers?  the relay verdict is still the normal path */
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

  var restoreFetch = null;
  var restoreXhr = null;

  // ── fetch() ────────────────────────────────────────────────────────────
  var originalFetch = self.fetch;
  if (typeof originalFetch === "function") {
    // ANONYMOUS on purpose (#684 S6): PR #675 named this `inmoDiagFetch`.
    var wrappedFetch = function (input, init) {
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
              if (Object.prototype.hasOwnProperty.call(initHeaders, k)) {
                reqHeaders.push([k, initHeaders[k]]);
              }
            }
          }
        }
      } catch (e) {
        reqHeaders = [];
      }

      // PURE PASSTHROUGH — the request the page made, unmodified, issued once.
      // Nothing here spoofs a header, retries, or replays (issue #1 §15).
      return originalFetch.apply(this, arguments).then(
        function (response) {
          try {
            var resHeaders = headerEntriesFromHeadersObj(response.headers);
            var contentLength =
              response.headers && response.headers.get && response.headers.get("content-length");
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
    // An unnamed function expression assigned to a MEMBER expression gets
    // name "" — more conspicuous than the real thing, not less. Match the
    // shape of what it replaces; do not fake toString() (see the header).
    try {
      Object.defineProperty(wrappedFetch, "name", { value: "fetch", configurable: true });
      Object.defineProperty(wrappedFetch, "length", { value: originalFetch.length, configurable: true });
    } catch (e) {
      /* non-configurable in some engine — harmless */
    }
    self.fetch = wrappedFetch;
    restoreFetch = function () {
      // Only take back what is still ours: a page that wrapped `fetch` AFTER
      // us must not be clobbered by our restore.
      if (self.fetch === wrappedFetch) self.fetch = originalFetch;
    };
  }

  // ── XMLHttpRequest ────────────────────────────────────────────────────
  var OriginalXHR = self.XMLHttpRequest;
  if (typeof OriginalXHR === "function") {
    var originalOpen = OriginalXHR.prototype.open;
    var originalSend = OriginalXHR.prototype.send;
    var originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;
    // Per-request state OFF the instance (#684 S6): PR #675 stamped
    // `__inmoDiagMethod`/`__inmoDiagUrl`/`__inmoDiagReqHeaders` onto every XHR
    // the page created, which any page script holding its own XHR could read.
    var xhrState = new WeakMap();

    var wrappedOpen = function (method, url) {
      try {
        xhrState.set(this, { method: method, url: url, reqHeaders: [] });
      } catch (e) {
        /* best-effort */
      }
      return originalOpen.apply(this, arguments);
    };

    var wrappedSetRequestHeader = function (name, value) {
      try {
        var st = xhrState.get(this);
        if (st) st.reqHeaders.push([name, value]);
      } catch (e) {
        /* best-effort */
      }
      return originalSetRequestHeader.apply(this, arguments);
    };

    var wrappedSend = function () {
      var xhr = this;
      var startedAtMs = Date.now() - T0;
      try {
        xhr.addEventListener("loadend", function () {
          try {
            var st = xhrState.get(xhr) || { method: undefined, url: undefined, reqHeaders: [] };
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
              url: st.url,
              method: st.method,
              status: xhr.status,
              type: "xhr",
              requestHeaders: st.reqHeaders,
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

    try {
      Object.defineProperty(wrappedOpen, "name", { value: "open", configurable: true });
      Object.defineProperty(wrappedSetRequestHeader, "name", {
        value: "setRequestHeader",
        configurable: true,
      });
      Object.defineProperty(wrappedSend, "name", { value: "send", configurable: true });
    } catch (e) {
      /* harmless */
    }

    OriginalXHR.prototype.open = wrappedOpen;
    OriginalXHR.prototype.setRequestHeader = wrappedSetRequestHeader;
    OriginalXHR.prototype.send = wrappedSend;

    restoreXhr = function () {
      if (OriginalXHR.prototype.open === wrappedOpen) OriginalXHR.prototype.open = originalOpen;
      if (OriginalXHR.prototype.setRequestHeader === wrappedSetRequestHeader) {
        OriginalXHR.prototype.setRequestHeader = originalSetRequestHeader;
      }
      if (OriginalXHR.prototype.send === wrappedSend) OriginalXHR.prototype.send = originalSend;
    };
  }

  uninstall = function () {
    if (restoreFetch) restoreFetch();
    if (restoreXhr) restoreXhr();
    try {
      delete self[GUARD];
    } catch (e) {
      /* harmless */
    }
  };
})();
