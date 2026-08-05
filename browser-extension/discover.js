/**
 * discover.js — Pure URL-building discovery helpers (issue #336).
 *
 * NO side effects at load time: no `window`/`document`/`chrome` access at the
 * top level, no listeners. Every function is a pure function of its arguments
 * so it is unit-testable outside a browser
 * (dashboard/__tests__/extension-discover.test.ts) — the timing/wiring that
 * touches the DOM and chrome APIs lives in content-script.js.
 *
 * Loaded as a content script (shared isolated world) via manifest.json, after
 * detect.js. Since classic content scripts don't share top-level bindings, the
 * API is published on `self.InmoDiscover` for content-script.js and via
 * `module.exports` for the unit tests.
 *
 * WHAT THIS DOES (and does NOT): on a portal's SEARCH page, it enumerates the
 * search FORM's filter OPTIONS (property type as the portal labels them) and
 * the URL FRAGMENT each option produces — reading the portal's own embedded
 * config JSON where available, else the live <select>/<option> elements. It
 * reads FORM METADATA and URL SHAPES only; it never paginates, fetches, or
 * harvests listing results (scope/robots per docs/skills/connectors.md).
 */

(function () {
  "use strict";

  // ── Portal detection ──────────────────────────────────────────────────────
  //
  // Host suffix → connector key. Mirrors CAPTURE_PORTALS in
  // dashboard/lib/worklist.ts; only Aliseda has an enumerator wired today, but
  // the detection list is kept in step so adding a portal is a local edit.
  var PORTAL_HOSTS = [
    { portal: "aliseda", hostSuffix: "alisedainmobiliaria.com" },
    { portal: "idealista", hostSuffix: "idealista.com" },
  ];

  /** The portal a URL's host belongs to, or null. Pure; null on parse error. */
  function discoverPortalForUrl(url) {
    var host;
    try {
      host = new URL(String(url).trim()).hostname.toLowerCase().replace(/^www\./, "");
    } catch (e) {
      return null;
    }
    for (var i = 0; i < PORTAL_HOSTS.length; i++) {
      var p = PORTAL_HOSTS[i];
      if (host === p.hostSuffix || host.endsWith("." + p.hostSuffix)) return p.portal;
    }
    return null;
  }

  // ── Generic option extraction ─────────────────────────────────────────────

  /** Trim a URL/path to just its path (drop origin/query/hash). */
  function pathOf(urlOrPath) {
    var s = String(urlOrPath || "").trim();
    if (!s) return "";
    try {
      // Absolute URL → its pathname.
      return new URL(s).pathname;
    } catch (e) {
      // Relative path → strip query/hash, ensure a single leading slash.
      var p = s.split(/[?#]/)[0];
      if (!p) return "";
      return p.charAt(0) === "/" ? p : "/" + p;
    }
  }

  /** First truthy string among the given object keys, else "". */
  function firstString(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }

  /** First finite number among the given object keys, else undefined. */
  function firstNumber(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (typeof v === "number" && isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v))) return Number(v);
    }
    return undefined;
  }

  /**
   * Normalize one raw option-like object into a catalog option
   * {label, portalValue?, urlFragment, category?, subtipo?}, or null when it
   * has no usable label or fragment. Tolerant of the many shapes an embedded
   * config / form option can take (label vs nombre vs name; url vs href vs slug).
   */
  function normalizeOption(raw) {
    if (!raw || typeof raw !== "object") return null;
    var label = firstString(raw, ["label", "nombre", "name", "text", "title"]);
    if (!label) return null;

    // Prefer an explicit URL/path the portal exposes; else build one from a slug.
    var explicit = firstString(raw, ["urlFragment", "url", "href", "path", "link"]);
    var slug = firstString(raw, ["slug"]);
    var fragment = explicit ? pathOf(explicit) : slug ? "/comprar-viviendas/" + slug : "";
    if (!fragment) return null;

    var opt = { label: label, urlFragment: fragment };
    var portalValue = firstString(raw, ["value", "id", "codigo", "code"]);
    if (portalValue) opt.portalValue = portalValue;
    var category = firstString(raw, ["category", "categoria", "seccion"]);
    if (category) opt.category = category;
    var subtipo = firstNumber(raw, ["subtipo", "subtype", "subTipo"]);
    if (subtipo !== undefined) opt.subtipo = subtipo;
    return opt;
  }

  /**
   * Deep-scan a parsed JSON value for arrays of option-like objects (each with
   * a label-ish field AND a url/slug-ish field), returning the normalized
   * options from the first such array found (breadth-first, largest wins).
   * Pure; caps recursion depth to stay bounded on huge app bundles.
   */
  function extractOptionsFromJson(value) {
    var best = [];
    function looksLikeOption(o) {
      if (!o || typeof o !== "object") return false;
      var hasLabel = firstString(o, ["label", "nombre", "name", "text", "title"]) !== "";
      var hasLink =
        firstString(o, ["urlFragment", "url", "href", "path", "link", "slug"]) !== "";
      return hasLabel && hasLink;
    }
    function walk(node, depth) {
      if (depth > 6 || node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        var optionish = node.filter(looksLikeOption);
        if (optionish.length > best.length) {
          var normalized = [];
          for (var i = 0; i < optionish.length; i++) {
            var n = normalizeOption(optionish[i]);
            if (n) normalized.push(n);
          }
          if (normalized.length > best.length) best = normalized;
        }
        for (var j = 0; j < node.length; j++) walk(node[j], depth + 1);
        return;
      }
      for (var k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k], depth + 1);
      }
    }
    walk(value, 0);
    return best;
  }

  /**
   * Try to read property-type options from a single <script>'s text: parse it
   * as JSON directly, else pull out the largest `[...]`/`{...}` JSON literal it
   * contains and parse that. Returns [] when nothing parses. Pure.
   */
  function extractEmbeddedOptions(scriptText) {
    var text = String(scriptText || "").trim();
    if (!text) return [];
    // Direct JSON (e.g. a <script type="application/json"> facet blob).
    try {
      return extractOptionsFromJson(JSON.parse(text));
    } catch (e) {
      /* not pure JSON — fall through to literal extraction */
    }
    // Largest bracketed literal (e.g. `config = {...}` inside a JS bundle).
    var candidates = text.match(/[[{][\s\S]*[\]}]/g);
    if (!candidates) return [];
    var best = [];
    for (var i = 0; i < candidates.length; i++) {
      try {
        var opts = extractOptionsFromJson(JSON.parse(candidates[i]));
        if (opts.length > best.length) best = opts;
      } catch (e2) {
        /* not valid JSON — skip */
      }
    }
    return best;
  }

  /**
   * Read property-type options from the live search form: <select> <option>
   * pairs (value + visible text) and their derivable URL fragment. Options with
   * an empty/placeholder value (e.g. "Todos") are skipped. Pure over `doc`.
   */
  function extractFormOptions(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") return [];
    var out = [];
    var seen = {};
    var selects = doc.querySelectorAll(
      'select[name*="tipo" i], select[id*="tipo" i], select[name*="type" i], select[data-filter="property-type"]',
    );
    for (var s = 0; s < selects.length; s++) {
      var options = selects[s].querySelectorAll("option");
      for (var o = 0; o < options.length; o++) {
        var el = options[o];
        var label = (el.textContent || "").trim();
        var value = (el.getAttribute("value") || "").trim();
        // Skip empty / placeholder options.
        if (!label || !value || /^(todos?|cualquiera|--)/i.test(label)) continue;
        var href = (el.getAttribute("data-url") || el.getAttribute("data-href") || "").trim();
        var slug = value.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
        var fragment = href ? pathOf(href) : "/comprar-viviendas/" + slug;
        var key = label + "|" + fragment;
        if (seen[key]) continue;
        seen[key] = true;
        var opt = { label: label, portalValue: value, urlFragment: fragment };
        var code = Number(value);
        if (isFinite(code) && value !== "") opt.subtipo = code;
        out.push(opt);
      }
    }
    return out;
  }

  /** Collect embedded options across every <script> in the document. Pure over `doc`. */
  function collectEmbeddedOptions(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") return [];
    var scripts = doc.querySelectorAll("script");
    var best = [];
    for (var i = 0; i < scripts.length; i++) {
      var opts = extractEmbeddedOptions(scripts[i].textContent || "");
      if (opts.length > best.length) best = opts;
    }
    return best;
  }

  /**
   * Build the discovery catalog for a page: try the least-brittle source first
   * (embedded config JSON), fall back to the live form's <option> elements.
   * Returns { source, axes } with the property_type axis populated, or null
   * when no options could be enumerated. Pure over (portal, doc).
   *
   * Only `property_type` is enumerated today (the axis Aliseda is wired for);
   * the axes object is open so more axes slot in without a shape change.
   */
  function buildDiscoveryAxes(portal, doc) {
    if (portal !== "aliseda") return null; // only Aliseda is wired end-to-end
    var embedded = collectEmbeddedOptions(doc);
    if (embedded.length > 0) {
      return { source: "embedded-config", axes: { property_type: embedded } };
    }
    var form = extractFormOptions(doc);
    if (form.length > 0) {
      return { source: "form-options", axes: { property_type: form } };
    }
    return null;
  }

  /**
   * Assemble the full POST body for the ingest route from a page: derive the
   * connector from `pageUrl`, enumerate its options, and stamp `capturedAt`.
   * Returns null when the page isn't a wired portal or yields no options. The
   * caller (content-script.js) POSTs this to /api/extension/filter-catalog via
   * the background service worker. `now` is injectable for deterministic tests.
   */
  function buildDiscoveryPayload(pageUrl, doc, now) {
    var portal = discoverPortalForUrl(pageUrl);
    if (!portal) return null;
    var built = buildDiscoveryAxes(portal, doc);
    if (!built) return null;
    return {
      pageUrl: String(pageUrl),
      source: built.source,
      capturedAt: (now instanceof Date ? now : new Date()).toISOString(),
      axes: built.axes,
    };
  }

  var api = {
    PORTAL_HOSTS: PORTAL_HOSTS,
    discoverPortalForUrl: discoverPortalForUrl,
    normalizeOption: normalizeOption,
    extractOptionsFromJson: extractOptionsFromJson,
    extractEmbeddedOptions: extractEmbeddedOptions,
    extractFormOptions: extractFormOptions,
    collectEmbeddedOptions: collectEmbeddedOptions,
    buildDiscoveryAxes: buildDiscoveryAxes,
    buildDiscoveryPayload: buildDiscoveryPayload,
  };

  // Publish for content-script.js (shared isolated world).
  if (typeof self !== "undefined") {
    self.InmoDiscover = api;
  }
  // Publish for the unit tests (Node/vitest).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
