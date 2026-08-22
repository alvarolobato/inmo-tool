/**
 * network-recorder.js — Pure redaction/truncation/shaping helpers for the
 * OPT-IN network-capture extension of "forzar captura + diagnóstico" (issue
 * #671 follow-up scope: the owner asked for XHR/fetch capture too, because a
 * DOM snapshot can never contain data that arrives by XHR after render —
 * Hipoges' results page is an Angular shell with the listing data fetched
 * separately; idealista's gallery lazy-loads photos the same way).
 *
 * This file holds ONLY the parts that don't need a live `window`/`fetch`/
 * `XMLHttpRequest` — the actual monkey-patching wiring lives in
 * network-recorder-main.js (installed into the page's MAIN world) and
 * network-recorder-relay.js (the ISOLATED-world bridge to the extension).
 * Keeping the redaction logic here, pure, is what makes it unit-testable
 * (dashboard/__tests__/extension-network-recorder.test.ts) without a browser
 * — which matters because this is the SECURITY-CRITICAL half of network
 * capture: it decides what leaves the page at all.
 *
 * ## Why this exists and what it must never become
 *
 * D-033 ruled Cimenta2 not-buildable specifically because its only data path
 * was a guest API that over-exposed confidential/personal fields — "even
 * scoped" was the rule, not "unless it's useful". A network recorder must not
 * become a back door around that: it is a DIAGNOSTIC tool the owner
 * explicitly arms for one reload, never an ingestion channel, and nothing it
 * captures may feed a connector without its own separate decision (see the
 * D-153 record for this feature).
 *
 * Concretely, before anything is buffered for possible storage:
 *   - `Authorization`, `Cookie`, `Set-Cookie`, and any header/query-param that
 *     looks like a credential (token/key/secret/session/auth) is stripped —
 *     never merely masked-but-present, REMOVED.
 *   - response bodies are capped at MAX_BODY_BYTES with truncation always
 *     recorded explicitly (never silent).
 *   - nothing here issues a request the page didn't already make, or retries
 *     one — it only observes (issue #1 §15 / D-033 / D-075's "no evasion,
 *     capture what the browser already rendered" rule extends naturally to
 *     "what it already requested").
 */

(function () {
  "use strict";

  /** Response/request bodies are capped here; truncation is always visible. */
  var MAX_BODY_BYTES = 20000;

  /** Bounded ring buffer size for a single recording session (background.js). */
  var MAX_ENTRIES = 200;

  // Header names stripped OUTRIGHT (case-insensitive) — never stored, not even
  // truncated/masked. Anything that authenticates the owner's own session.
  var REDACTED_HEADER_NAMES = [
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
    "proxy-authorization",
  ];

  // Substrings that flag a header name as credential-shaped even under an
  // unanticipated portal-specific name (e.g. `x-hipoges-session`). Broad on
  // purpose — a false-positive redaction costs nothing; a missed credential
  // costs everything.
  var REDACTED_HEADER_SUBSTRINGS = ["token", "secret", "session", "auth", "apikey", "api-key"];

  // Query-string parameter NAMES stripped from any recorded URL (case-
  // insensitive exact match on the param name, not a substring — a URL path
  // shouldn't be mangled by an overzealous substring match).
  var REDACTED_QUERY_PARAM_NAMES = [
    "token",
    "access_token",
    "id_token",
    "refresh_token",
    "api_key",
    "apikey",
    "key",
    "secret",
    "session",
    "sessionid",
    "auth",
  ];

  function isRedactedHeaderName(name) {
    var n = String(name || "").toLowerCase().trim();
    if (!n) return false;
    if (REDACTED_HEADER_NAMES.indexOf(n) !== -1) return true;
    for (var i = 0; i < REDACTED_HEADER_SUBSTRINGS.length; i++) {
      if (n.indexOf(REDACTED_HEADER_SUBSTRINGS[i]) !== -1) return true;
    }
    return false;
  }

  function isRedactedQueryParamName(name) {
    var n = String(name || "").toLowerCase().trim();
    return REDACTED_QUERY_PARAM_NAMES.indexOf(n) !== -1;
  }

  /**
   * Redact a headers collection. Accepts a plain object OR an array of
   * [name, value] pairs (both `Headers` iteration and a manually-built XHR
   * header map end up as one of these). Returns a plain object with every
   * credential-shaped header REMOVED (key absent, not blanked) plus a count
   * of how many were removed, so removal is visible rather than silent.
   */
  function redactHeaders(headers) {
    var out = {};
    var redactedCount = 0;
    var entries = [];
    if (!headers) {
      entries = [];
    } else if (Array.isArray(headers)) {
      entries = headers;
    } else if (typeof headers === "object") {
      for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k)) entries.push([k, headers[k]]);
      }
    }
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i][0];
      var value = entries[i][1];
      if (isRedactedHeaderName(name)) {
        redactedCount++;
        continue;
      }
      out[String(name)] = value == null ? "" : String(value);
    }
    return { headers: out, redactedCount: redactedCount };
  }

  /**
   * Redact credential-shaped query parameters from a URL string. Leaves the
   * rest of the URL (path, other params) intact. Never throws — an
   * unparseable URL is returned unchanged (nothing to strip from a string we
   * can't parse, and this must never crash the recorder).
   */
  function redactUrl(rawUrl) {
    var url;
    try {
      url = new URL(String(rawUrl));
    } catch (e) {
      return { url: String(rawUrl), redactedCount: 0 };
    }
    var redactedCount = 0;
    var toDelete = [];
    url.searchParams.forEach(function (_value, name) {
      if (isRedactedQueryParamName(name)) toDelete.push(name);
    });
    for (var i = 0; i < toDelete.length; i++) {
      url.searchParams.delete(toDelete[i]);
      redactedCount++;
    }
    return { url: url.toString(), redactedCount: redactedCount };
  }

  /**
   * Cap `text` (a body already decoded to a JS string) at MAX_BODY_BYTES
   * (measured as UTF-16 code units — good enough for a visibility cap, not a
   * byte-exact guarantee). Truncation is ALWAYS reported explicitly.
   */
  function truncateBody(text) {
    var s = typeof text === "string" ? text : "";
    var originalLength = s.length;
    if (originalLength <= MAX_BODY_BYTES) {
      return { body: s, truncated: false, originalLength: originalLength };
    }
    return { body: s.slice(0, MAX_BODY_BYTES), truncated: true, originalLength: originalLength };
  }

  /**
   * Shape ONE raw captured request/response into the redacted, size-capped
   * form that's safe to buffer/send. `raw` — built by network-recorder-main.js
   * inside the page — carries:
   *   { url, method, status, requestHeaders, responseHeaders, body,
   *     bodyReadable, type: 'fetch'|'xhr', startedAtMs, finishedAtMs }
   * `bodyReadable` is false when the response body couldn't be read as text
   * (e.g. an XHR with responseType 'blob'/'arraybuffer') — recorded, body
   * left null, never guessed at.
   *
   * Pure: no chrome/window access, so every redaction/truncation rule is
   * unit-tested directly against fabricated `raw` objects.
   */
  function summarizeEntry(raw) {
    var r = raw || {};
    var urlRedaction = redactUrl(r.url);
    var reqHeaders = redactHeaders(r.requestHeaders);
    var resHeaders = redactHeaders(r.responseHeaders);
    var bodyResult = r.bodyReadable === false
      ? { body: null, truncated: false, originalLength: 0 }
      : truncateBody(r.body);

    return {
      url: urlRedaction.url,
      method: r.method ? String(r.method).toUpperCase() : "GET",
      status: typeof r.status === "number" ? r.status : null,
      type: r.type === "xhr" ? "xhr" : "fetch",
      requestHeaders: reqHeaders.headers,
      responseHeaders: resHeaders.headers,
      redactedHeaderCount: reqHeaders.redactedCount + resHeaders.redactedCount,
      redactedQueryParamCount: urlRedaction.redactedCount,
      body: bodyResult.body,
      bodyTruncated: bodyResult.truncated,
      bodyOriginalLength: bodyResult.originalLength,
      bodyReadable: r.bodyReadable !== false,
      // Milliseconds since the recorder installed (page navigation start) —
      // NOT wall-clock — so the diagnostic can compute "listing data arrived
      // at T+900ms" relative to when the DOM snapshot was taken, without
      // leaking/depending on absolute client clock skew.
      startedAtMs: typeof r.startedAtMs === "number" ? r.startedAtMs : null,
      finishedAtMs: typeof r.finishedAtMs === "number" ? r.finishedAtMs : null,
    };
  }

  /**
   * Cap a list of already-summarized entries to MAX_ENTRIES, keeping the
   * MOST RECENT ones (a long recording session should not silently lose the
   * data that arrived right before the owner clicked "capturar" — it's the
   * oldest, least-relevant-to-"what just happened" entries that get dropped).
   * Returns the kept list plus how many were dropped, so dropping is visible.
   */
  function capEntries(entries) {
    var list = Array.isArray(entries) ? entries : [];
    if (list.length <= MAX_ENTRIES) {
      return { entries: list, droppedCount: 0 };
    }
    var dropped = list.length - MAX_ENTRIES;
    return { entries: list.slice(dropped), droppedCount: dropped };
  }

  var api = {
    MAX_BODY_BYTES: MAX_BODY_BYTES,
    MAX_ENTRIES: MAX_ENTRIES,
    isRedactedHeaderName: isRedactedHeaderName,
    isRedactedQueryParamName: isRedactedQueryParamName,
    redactHeaders: redactHeaders,
    redactUrl: redactUrl,
    truncateBody: truncateBody,
    summarizeEntry: summarizeEntry,
    capEntries: capEntries,
  };

  if (typeof self !== "undefined") {
    self.InmoNetworkRecorder = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
