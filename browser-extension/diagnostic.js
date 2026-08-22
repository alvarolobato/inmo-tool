/**
 * diagnostic.js — Pure "forzar captura + diagnóstico" payload builder (issue
 * #671).
 *
 * Owner's proposal: a one-click way to send any page's HTML plus what the
 * extension THOUGHT about that page, so a mismatch between its view and the
 * owner's is visible without re-deriving it by hand. Three separate
 * investigations in one day depended on page HTML surviving BY ACCIDENT (a
 * purge that hadn't run, an uncalibrated connector, a failed capture) before
 * this existed.
 *
 * This module builds the DIAGNOSTIC BLOCK only (detection state — not the
 * HTML itself, which the caller already has from `document.documentElement
 * .outerHTML`). It is a PURE function of its inputs — no `window`/`document`
 * access beyond the injected `doc`, no `chrome` — so it is unit-testable
 * against fabricated DOM fixtures exactly like detect.js
 * (dashboard/__tests__/extension-diagnostic.test.ts), and it works on ANY
 * page: a supported detail page, a supported results page, an unsupported
 * host, or a challenge/WAF page — every input it reads from `D` (the
 * self.InmoDetect API) already degrades to null/false/[] for a page it
 * doesn't recognise, by construction (see detect.js's own docstrings).
 *
 * CRITICAL: the `isRenderReady` verdict here is NOT a re-derivation — it
 * calls `D.isRenderReadyDetail`, the EXACT SAME function auto-capture's
 * `pollUntilReady`/`handleListingWhenReady` (via `D.isRenderReady`, now a
 * thin wrapper over the same detail function) and `detectBlockSignals`'s
 * corroboration step all call. Two implementations of one predicate drift —
 * that has bitten this repo three times this week (Hipoges' empty shell,
 * idealista's photo gallery, and the class this issue names outright).
 *
 * Loaded after detect.js (self.InmoDetect) in manifest.json's content_scripts
 * array, and via the same on-demand injection popup.js already uses for
 * CAPTURE_HTML/DETECT_PAGE on unsupported hosts. Publishes on
 * `self.InmoDiagnostic` (classic-script global, same pattern as detect.js)
 * and via CommonJS `module.exports` for tests.
 */

(function () {
  "use strict";

  /**
   * Build the diagnostic block for `url`/`doc`.
   *
   * @param {object} D - the self.InmoDetect API (passed in, not read off
   *   `self`, so this stays a pure function of its arguments for testing).
   * @param {Document|object} doc - the page document (or a fabricated
   *   fixture with the same shape: querySelector/body/readyState).
   * @param {string} url - the page URL (window.location.href).
   * @param {object} [opts]
   * @param {string[]} [opts.hrefs] - every anchor href on the page, already
   *   resolved to absolute URLs (`[...document.querySelectorAll('a[href]')]
   *   .map(a => a.href)`). Defaults to [].
   * @param {string} [opts.extensionVersion] - chrome.runtime.getManifest().version.
   * @param {boolean} [opts.autoCaptureEnabled] - the owner's current
   *   chrome.storage.sync `autoCaptureEnabled` setting (default true, mirrors
   *   content-script.js AUTO_CAPTURE_DEFAULT — pass the resolved value).
   * @param {boolean} [opts.validationActive] - this tab's content-script
   *   validation-mode flag (issue #478 P3), if known.
   * @returns {object} the diagnostic block — see the field comments below.
   */
  function buildDiagnosticBlock(D, doc, url, opts) {
    var o = opts || {};
    var hrefs = Array.isArray(o.hrefs) ? o.hrefs : [];

    var detailPortal = null;
    var listingPortal = null;
    var supportedPortal = null;
    var pageRole = null;
    try {
      detailPortal = D.detailPortalForUrl(url);
      listingPortal = D.listingPortalForUrl(url);
      supportedPortal = D.supportedPortalForUrl(url);
      pageRole = D.pageRoleForUrl(url);
    } catch (e) {
      /* a malformed url degrades every one of these to null already — this
         catch is only for an unexpectedly-broken D, never expected live. */
    }

    // Same portal-resolution order the auto-capture loops use for their own
    // isRenderReady/detectBlockSignals calls: prefer the detail portal, then
    // the listing portal, then "supported host, unknown role" — so the
    // reported readySelectors match what auto-capture would actually check
    // on THIS page, not a generic fallback that happens to differ.
    var effectivePortal = detailPortal || listingPortal || supportedPortal || null;

    var renderReady = { ready: false, selector: null, reason: "no_doc", bodyTextLength: 0 };
    try {
      renderReady = D.isRenderReadyDetail(doc, effectivePortal);
    } catch (e) {
      /* never let a diagnostic crash the page it's diagnosing */
    }

    var blockVerdict = { blocked: false, signature: null };
    try {
      blockVerdict = D.detectBlockSignals(doc, effectivePortal, url);
    } catch (e) {
      /* best-effort */
    }

    var anchorCount = hrefs.length;
    var extractDetailUrlsCount = 0;
    try {
      // Anchors, as always, from the hrefs the CALLER collected — that stays
      // the contract, so this function is still testable from a plain array.
      var anchorUrls = D.extractDetailUrls(hrefs, effectivePortal || undefined);
      extractDetailUrlsCount = anchorUrls.length;
      // …plus the media-derived ones (issue #701). Without this the diagnostic
      // would report 0 on a Hipoges results page whose cards ARE harvestable —
      // they carry no <a href>, so the reference comes off the photo CDN path
      // — and would go on corroborating a bug that had already been fixed.
      // Deduplicated on matchKey against the anchor set, exactly as the real
      // harvest does, so a portal exposing both never double-counts.
      if (D.detailUrlsFromMedia && D.mediaSourcesFromDoc && D.matchKey) {
        var seenKeys = Object.create(null);
        for (var ai = 0; ai < anchorUrls.length; ai++) {
          seenKeys[D.matchKey(anchorUrls[ai])] = true;
        }
        var mediaUrls = D.detailUrlsFromMedia(
          D.mediaSourcesFromDoc(doc),
          url,
          effectivePortal || undefined
        );
        for (var mi = 0; mi < mediaUrls.length; mi++) {
          var mk = D.matchKey(mediaUrls[mi]);
          if (!mk || seenKeys[mk]) continue;
          seenKeys[mk] = true;
          extractDetailUrlsCount += 1;
        }
      }
    } catch (e) {
      /* best-effort */
    }
    // Loading placeholders still on the page (issue #701) — on a portal that
    // paints its results progressively this is the difference between "there
    // are no adverts here" and "the adverts have not arrived yet", which is
    // exactly the distinction the Hipoges reports turned on.
    var pendingPlaceholders = 0;
    try {
      pendingPlaceholders = D.pendingPlaceholderCount
        ? D.pendingPlaceholderCount(doc, effectivePortal || undefined)
        : 0;
    } catch (e) {
      /* best-effort */
    }

    var discoverSignalPresent = false;
    var validateSignalPresent = false;
    try {
      discoverSignalPresent = !!D.discoverSignalPresent(url);
      validateSignalPresent = !!D.validateSignalPresent(url);
    } catch (e) {
      /* best-effort */
    }

    var validationActive = !!o.validationActive || validateSignalPresent;
    var inValidationMode = false;
    try {
      inValidationMode = !!D.inValidationMode(url, validationActive);
    } catch (e) {
      inValidationMode = validationActive;
    }

    var autoCaptureEnabled = o.autoCaptureEnabled !== false; // default true, mirrors AUTO_CAPTURE_DEFAULT

    // Structural predicate for "would detail auto-capture fire on THIS
    // render" — the same gates startAutoCaptureLoop/pollUntilReady/
    // waitForQuiescenceThenFire apply, MINUS the per-tab fire-once guard
    // (which has no meaning for a one-off diagnostic snapshot: the question
    // this answers is "is everything about this page/setting/moment such
    // that a fresh load would auto-capture it", not "has it already fired").
    var autoCaptureWouldFire =
      !!detailPortal &&
      !inValidationMode &&
      !discoverSignalPresent &&
      autoCaptureEnabled &&
      renderReady.ready &&
      !blockVerdict.blocked;

    return {
      url: url,
      timestamp: new Date().toISOString(),
      extensionVersion: o.extensionVersion || null,
      detection: {
        detailPortal: detailPortal,
        listingPortal: listingPortal,
        supportedPortal: supportedPortal,
        pageRole: pageRole,
      },
      renderReady: {
        ready: renderReady.ready,
        // The single field that would have explained the Hipoges empty
        // shell instantly: WHICH selector satisfied isRenderReady, so a
        // too-generic match (e.g. bare "main") is visible at a glance.
        selector: renderReady.selector,
        reason: renderReady.reason,
        bodyTextLength: renderReady.bodyTextLength,
      },
      harvest: {
        anchorCount: anchorCount,
        extractDetailUrlsCount: extractDetailUrlsCount,
        pendingPlaceholders: pendingPlaceholders,
      },
      block: {
        blocked: blockVerdict.blocked,
        signature: blockVerdict.signature,
      },
      mode: {
        discoverSignalPresent: discoverSignalPresent,
        validationActive: inValidationMode,
        autoCaptureEnabled: autoCaptureEnabled,
      },
      autoCaptureWouldFire: autoCaptureWouldFire,
    };
  }

  var api = {
    buildDiagnosticBlock: buildDiagnosticBlock,
  };

  if (typeof self !== "undefined") {
    self.InmoDiagnostic = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
