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
 * ## What is stripped, and what ISN'T (issue #684's audit, verbatim)
 *
 * STRIPPED, before anything is buffered for possible storage:
 *   - request/response HEADERS whose name is credential-shaped
 *     (`authorization`, `cookie`, `set-cookie`, `x-api-key`, … plus any name
 *     CONTAINING token/secret/session/auth/apikey) — REMOVED, key and all,
 *     never masked-but-present.
 *   - URL QUERY PARAMS, PATH SEGMENTS and FRAGMENT PARAMS that are
 *     credential-shaped — including `#access_token=…` (the OAuth
 *     implicit-flow shape) and `/api/v1/session/<jwt>/…`, both of which PR
 *     #675's version let through whole because it only ever looked at
 *     `url.searchParams`.
 *   - in a response body, a JSON value under a credential-shaped KEY, a
 *     `Bearer …`/`Basic …` literal, and a bare JWT.
 *
 * NOT STRIPPED — state this plainly, because D-153's "credentials stripped
 * before anything is sent" must not be read as covering it:
 *   - **response bodies themselves.** They are TRUNCATED at MAX_BODY_BYTES
 *     (always visibly), and scrubbed of the three unambiguous credential
 *     shapes above, and that is all. A body is the payload the feature exists
 *     to show — an SPA's listing JSON that never reaches the DOM — so
 *     whatever personal data the portal returned about an owner reaches
 *     `extension_diagnostic.network` intact. The bound on that is
 *     `purge_extension_diagnostics()` (30 days), not this module.
 *   - REQUEST bodies are never captured at all — neither wrapper reads
 *     `init.body` nor `send()`'s argument. Good for privacy; it also means a
 *     POST's payload is invisible in a diagnostic, so "what did the app SEND
 *     to that endpoint" is a question this feature cannot answer.
 *
 * Nothing here issues a request the page didn't already make, or retries one —
 * it only observes (issue #1 §15 / D-033 / D-075's "no evasion, capture what
 * the browser already rendered" rule extends naturally to "what it already
 * requested").
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

  // ── URL credential matching (issue #684 redaction audit) ────────────────
  //
  // PR #675's version matched query-param names by EXACT name only, justified
  // in a comment as avoiding "an overzealous substring match" mangling the
  // path. That justification was simply wrong: `URLSearchParams.forEach`
  // iterates parameter NAMES, and structurally cannot reach the path. So the
  // exact-match rule bought nothing and missed `password`, `pwd`, `passwd`,
  // `jwt`, `bearer`, `credential`, `signature` and every portal-specific
  // `x_session_token`-shaped name. Aligned with the header path now: substring
  // first, exact only where the English word is genuinely ambiguous.
  //
  // The two tiers exist because over-redaction is NOT free here, contrary to
  // the header rule. A recorded URL is the primary diagnostic signal — the
  // whole point is seeing WHICH endpoint the SPA called with WHICH filters —
  // and a Spanish real-estate portal legitimately carries `provincia_code`,
  // `estado`, `residencial`, `design`-shaped params that a naive substring
  // list for `code`/`state`/`sid`/`sig`/`key` would shred. Those five stay
  // exact; everything unambiguous is substring.
  var REDACTED_QUERY_PARAM_SUBSTRINGS = [
    "token",
    "secret",
    "session",
    "sessid", // sessionid / phpsessid / jsessionid
    "auth",
    "apikey",
    "api-key",
    "api_key",
    "password",
    "passwd",
    "pwd",
    "jwt",
    "bearer",
    "credential",
    "signature",
  ];
  var REDACTED_QUERY_PARAM_EXACT = ["key", "code", "state", "sid", "sess", "sig"];

  // A path segment that IS a JWT, wherever it sits. Three base64url parts, the
  // header part starting `ey` (i.e. `{"` base64url-encoded) — specific enough
  // that a listing slug or a numeric id can never collide with it.
  var JWT_SEGMENT_RE = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}$/;
  // Same shape, found anywhere inside a body or an opaque fragment.
  var JWT_ANYWHERE_RE = /ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;
  var BEARER_ANYWHERE_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
  // `"key": "value"` in a JSON-ish body. Bounded on both sides so a 20 KB body
  // cannot drive pathological backtracking.
  var JSON_PAIR_RE = /"([^"\\]{1,64})"(\s*:\s*)"((?:[^"\\]|\\.){0,8192})"/g;

  var REDACTION_PLACEHOLDER = "[redacted]";

  function isRedactedHeaderName(name) {
    var n = String(name || "").toLowerCase().trim();
    if (!n) return false;
    if (REDACTED_HEADER_NAMES.indexOf(n) !== -1) return true;
    for (var i = 0; i < REDACTED_HEADER_SUBSTRINGS.length; i++) {
      if (n.indexOf(REDACTED_HEADER_SUBSTRINGS[i]) !== -1) return true;
    }
    return false;
  }

  /**
   * Is this name credential-shaped? Used for query params, for fragment
   * params, for JSON body keys, and for the PRECEDING path segment that makes
   * the next one a credential (`/api/v1/session/<jwt>`).
   */
  function isRedactedQueryParamName(name) {
    var n = String(name || "").toLowerCase().trim();
    if (!n) return false;
    if (REDACTED_QUERY_PARAM_EXACT.indexOf(n) !== -1) return true;
    for (var i = 0; i < REDACTED_QUERY_PARAM_SUBSTRINGS.length; i++) {
      if (n.indexOf(REDACTED_QUERY_PARAM_SUBSTRINGS[i]) !== -1) return true;
    }
    return false;
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
   * Redact credential-bearing PATH segments (issue #684: `redactUrl` used to
   * touch `searchParams` only, so `/api/v1/session/<jwt>/refresh` sailed
   * through whole).
   *
   * Two rules, both narrow on purpose — a path is how you recognise WHICH
   * endpoint the SPA called, so shredding it destroys the diagnostic:
   *   1. A segment that is literally a JWT, wherever it sits.
   *   2. A segment whose PRECEDING segment is credential-shaped
   *      (`.../token/<x>`, `.../session/<x>`, `.../apikey/<x>`) and which is
   *      long enough (>= 8 chars) to be a secret rather than a route word.
   * Anything else — a listing id, a slug, a province name — is untouched.
   */
  function redactPathname(pathname) {
    var raw = String(pathname || "");
    if (!raw || raw.indexOf("/") === -1) return { pathname: raw, redactedCount: 0 };
    var parts = raw.split("/");
    var redactedCount = 0;
    var previous = "";
    for (var i = 0; i < parts.length; i++) {
      var segment = parts[i];
      if (!segment) {
        previous = "";
        continue;
      }
      var decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch (e) {
        decoded = segment;
      }
      if (JWT_SEGMENT_RE.test(decoded)) {
        parts[i] = REDACTION_PLACEHOLDER;
        redactedCount++;
      } else if (previous && decoded.length >= 8 && isRedactedQueryParamName(previous)) {
        parts[i] = REDACTION_PLACEHOLDER;
        redactedCount++;
      }
      previous = decoded;
    }
    return { pathname: redactedCount ? parts.join("/") : raw, redactedCount: redactedCount };
  }

  /**
   * Redact a URL FRAGMENT (issue #684: `url.searchParams` never touches
   * `url.hash`, so `#access_token=…` — the OAuth implicit-flow shape, the one
   * place a live bearer token routinely lives in a URL — survived intact).
   *
   * Handles the three fragment shapes that actually occur:
   *   `#access_token=…&expires_in=…`  → param-shaped, redact by name
   *   `#/route?access_token=…`        → SPA hash route + query, redact the
   *                                     query half only, keep the route
   *   `#eyJhbGciOi….…..…`             → opaque; redact if it IS a JWT
   * When nothing matched, the fragment is returned BYTE-IDENTICAL — never
   * round-tripped through URLSearchParams, which would re-encode an Angular
   * hash route into unreadable percent-escapes for no benefit.
   */
  function redactFragment(hash) {
    var raw = String(hash || "").replace(/^#/, "");
    if (!raw) return { hash: "", redactedCount: 0 };

    var prefix = "";
    var queryPart = raw;
    var q = raw.indexOf("?");
    if (q !== -1) {
      prefix = raw.slice(0, q + 1);
      queryPart = raw.slice(q + 1);
    }

    if (queryPart.indexOf("=") !== -1) {
      var params;
      try {
        params = new URLSearchParams(queryPart);
      } catch (e) {
        params = null;
      }
      if (params) {
        var toDelete = [];
        params.forEach(function (_value, name) {
          if (isRedactedQueryParamName(name)) toDelete.push(name);
        });
        if (toDelete.length) {
          for (var i = 0; i < toDelete.length; i++) params.delete(toDelete[i]);
          var rebuilt = params.toString();
          // A fragment (or a hash route's query half) that was ONLY
          // credentials collapses away rather than leaving a bare `#` or a
          // dangling `?`.
          var kept = rebuilt ? prefix + rebuilt : prefix.replace(/\?$/, "");
          return { hash: kept ? "#" + kept : "", redactedCount: toDelete.length };
        }
      }
    }

    // Opaque fragment: only a literal JWT is unambiguous enough to strip.
    if (JWT_SEGMENT_RE.test(queryPart)) {
      return { hash: "#" + prefix + REDACTION_PLACEHOLDER, redactedCount: 1 };
    }
    return { hash: "#" + raw, redactedCount: 0 };
  }

  /**
   * Redact credential-shaped query parameters, path segments and fragment
   * params from a URL string. Leaves everything else intact. Never throws — an
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

    var pathResult = redactPathname(url.pathname);
    if (pathResult.redactedCount) {
      url.pathname = pathResult.pathname;
      redactedCount += pathResult.redactedCount;
    }

    var hashResult = redactFragment(url.hash);
    if (hashResult.redactedCount) {
      url.hash = hashResult.hash;
      redactedCount += hashResult.redactedCount;
    }

    return { url: url.toString(), redactedCount: redactedCount };
  }

  /**
   * BEST-EFFORT credential scrub of a response body (issue #684).
   *
   * ── Read this before trusting it ──────────────────────────────────────
   * A response body is NOT sanitised. It is the payload the feature exists to
   * show — an SPA's listing JSON, the thing that never reaches the DOM — so
   * there is no rule that could strip "the sensitive parts" without also
   * stripping the diagnostic. What this function does is remove the three
   * credential shapes that are unambiguous and carry ZERO diagnostic value:
   *   - a JSON string value under a credential-shaped KEY
   *     (`"access_token": "…"`, `"password": "…"`),
   *   - an `Authorization: Bearer …` / `Basic …` literal,
   *   - a bare JWT anywhere in the text.
   * Everything else in the body — including whatever personal data the portal
   * returned about an owner — reaches `extension_diagnostic.network` intact.
   * `purge_extension_diagnostics()` (30 days, D-153 point 6) is the bound on
   * that, not this function.
   */
  function redactBodyText(text) {
    var s = typeof text === "string" ? text : "";
    if (!s) return { body: s, redactedCount: 0 };
    var redactedCount = 0;

    s = s.replace(JSON_PAIR_RE, function (match, key, sep) {
      if (!isRedactedQueryParamName(key)) return match;
      redactedCount++;
      return '"' + key + '"' + sep + '"' + REDACTION_PLACEHOLDER + '"';
    });
    s = s.replace(BEARER_ANYWHERE_RE, function (_match, scheme) {
      redactedCount++;
      return scheme + " " + REDACTION_PLACEHOLDER;
    });
    s = s.replace(JWT_ANYWHERE_RE, function () {
      redactedCount++;
      return REDACTION_PLACEHOLDER;
    });

    return { body: s, redactedCount: redactedCount };
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
    // Truncate FIRST, then scrub: the regex pass runs over at most
    // MAX_BODY_BYTES, never over a multi-MB response.
    var bodyRedaction = bodyResult.body == null
      ? { body: null, redactedCount: 0 }
      : redactBodyText(bodyResult.body);

    return {
      url: urlRedaction.url,
      method: r.method ? String(r.method).toUpperCase() : "GET",
      status: typeof r.status === "number" ? r.status : null,
      type: r.type === "xhr" ? "xhr" : "fetch",
      requestHeaders: reqHeaders.headers,
      responseHeaders: resHeaders.headers,
      redactedHeaderCount: reqHeaders.redactedCount + resHeaders.redactedCount,
      // Renamed from PR #675's `redactedQueryParamCount`: `redactUrl` now
      // covers the path and the fragment too, so "query param" was a lie
      // about its own scope (issue #684). Nothing outside this module read
      // the old name.
      redactedUrlPartCount: urlRedaction.redactedCount,
      redactedBodyValueCount: bodyRedaction.redactedCount,
      body: bodyRedaction.body,
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
    redactPathname: redactPathname,
    redactFragment: redactFragment,
    redactBodyText: redactBodyText,
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
