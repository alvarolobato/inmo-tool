/**
 * content-script.js — Injected into supported listing pages (Idealista, Aliseda).
 *
 * Two jobs:
 *   1. Manual capture (unchanged): reply to CAPTURE_HTML from popup.js with the
 *      current rendered DOM.
 *   2. Auto-capture on render (issue #254): when the human lands on a real
 *      listing-DETAIL page that has actually rendered, automatically POST the
 *      capture through the SAME background → /api/extension/capture path the
 *      popup button uses (message type EXTRACT). No new ingest path, no click.
 *
 * The auto-capture NEVER navigates anything — it only captures the page the
 * human already chose to open. Pure detection logic lives in detect.js
 * (self.InmoDetect); this file is the timing/DOM/chrome wiring.
 */

(() => {
  // ── 1. Manual capture responder (popup.js path — unchanged) ───────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "CAPTURE_HTML") {
      sendResponse({
        html: document.documentElement.outerHTML,
        url: window.location.href,
        title: document.title,
      });
      return true;
    }

    // Batch capture (issue #262): the popup asks whether THIS tab is a
    // listing/search page and, if so, for the detail URLs it links to. The
    // pure classification + extraction lives in detect.js (self.InmoDetect);
    // here we just read the current URL and the anchor hrefs off the live DOM.
    if (msg.type === "DETECT_PAGE") {
      const D = self.InmoDetect;
      const url = window.location.href;
      if (!D) {
        sendResponse({ isListing: false, isDetail: false, portal: null, detailUrls: [] });
        return true;
      }
      const listingPortal = D.listingPortalForUrl(url);
      const detailPortal = D.detailPortalForUrl(url);
      let detailUrls = [];
      if (listingPortal) {
        const hrefs = Array.from(document.querySelectorAll("a[href]")).map(
          (a) => a.href,
        );
        detailUrls = D.extractDetailUrls(hrefs, listingPortal);
      }
      // Map-view "convert" hint (issue #529): on an Idealista map search (pins,
      // zero anchors) the popup's "Capturar todas" would be dead (n === 0). Hand
      // it the listing (card) form of the same search, already tagged with the
      // auto-start signal, so it can offer a live "Ver como lista y capturar"
      // that opens straight into capture. Null for every other page.
      const verdict = D.listingCaptureAction(url, detailUrls);
      sendResponse({
        isListing: !!listingPortal,
        isDetail: !!detailPortal,
        portal: listingPortal || detailPortal,
        convertUrl:
          verdict.action === "convert" ? D.withCaptureSignal(verdict.listingUrl) : null,
        // Guided capture (issue #237): the supported portal for this HOST
        // regardless of page role, plus the page role itself, so the popup can
        // show GUIDANCE on a supported-portal page that is neither a detail nor
        // a listing page (home / saved search / filter form) instead of
        // blind-capturing it.
        supportedPortal: D.supportedPortalForUrl(url),
        role: D.pageRoleForUrl(url),
        detailUrls,
      });
      return true;
    }

    // Pagination walk (issue #362): the background enumeration navigates a tab
    // through each results page and asks THIS content script — running in the
    // real, authenticated, JS-RENDERED page (the only way to enumerate a
    // client-side-rendered portal like Aliseda, where a raw fetch returns an
    // empty SPA shell) — to wait for render, then hand back the detail URLs it
    // links to AND the URL of the next results page. Pure classification lives
    // in detect.js; here we just poll render-readiness and read the live DOM.
    if (msg.type === "HARVEST_LISTING_PAGE") {
      const D = self.InmoDetect;
      const url = window.location.href;
      const portal = D ? D.listingPortalForUrl(url) : null;
      if (!D || !portal) {
        sendResponse({ portal: null, detailUrls: [], nextUrl: null });
        return true;
      }
      const HARVEST_POLL_MS = 500;
      const deadline = Date.now() + 20000;
      const reply = () => {
        const hrefs = Array.from(document.querySelectorAll("a[href]")).map(
          (a) => a.href,
        );
        const detailUrls = D.extractDetailUrls(hrefs, portal);
        // Prefer the portal's clean URL scheme; fall back to the rendered
        // "siguiente" anchor for client-side-rendered pagination.
        const nextUrl =
          D.nextResultsUrl(url) || D.nextResultsUrlFromHrefs(hrefs, url, portal);
        sendResponse({ portal, detailUrls, nextUrl });
      };
      const tick = () => {
        if (D.isRenderReady(document, portal) || Date.now() > deadline) {
          reply();
          return;
        }
        setTimeout(tick, HARVEST_POLL_MS);
      };
      tick();
      return true; // async response
    }

    return true; // Keep message channel open for async response
  });

  // ── 2. Auto-capture on render (issue #254) ────────────────────────────────
  const D = self.InmoDetect;
  if (!D) return; // detect.js failed to load — manual capture still works.

  const AUTO_CAPTURE_DEFAULT = true; // see options page justification / PR notes.
  const READY_POLL_MS = 500; // how often to re-check render-readiness
  const MAX_WAIT_MS = 20000; // give up auto-capturing after this (manual still works)
  const QUIESCENCE_MS = 800; // DOM must be mutation-quiet this long after "ready"

  const guard = D.createCaptureGuard();
  let loopKey = null; // key of the detail page we're currently watching

  // Validation mode (issue #478 P3): true when this tab was opened from "Validar
  // filtros" (the `#inmo-validate` signal) — the owner is tuning the search, so
  // ALL capture is suppressed (no autostart, no banner, no detail auto-capture).
  // Held here so it SURVIVES in-portal navigation after the fragment is stripped;
  // seeded from the URL signal on first load and from the background's per-tab
  // session state on a plain reload / in-portal nav (see initValidationMode).
  let validationActive = false;

  async function autoCaptureEnabled() {
    try {
      const cfg = await chrome.storage.sync.get("autoCaptureEnabled");
      return cfg.autoCaptureEnabled === undefined
        ? AUTO_CAPTURE_DEFAULT
        : !!cfg.autoCaptureEnabled;
    } catch {
      return AUTO_CAPTURE_DEFAULT;
    }
  }

  function currentDetail() {
    const url = window.location.href;
    const portal = D.detailPortalForUrl(url);
    if (!portal) return null;
    return { url, portal, key: D.matchKey(url) };
  }

  // ── 0. Block/challenge detection (issue #634) ─────────────────────────────
  //
  // Runs on EVERY render of a page on one of this extension's matched hosts —
  // home, search/listing, or detail — independent of validation mode, the
  // detail auto-capture switch, and whether any batch/auto run is even
  // active. Detection itself is a small, portal-agnostic marker library in
  // detect.js (self.InmoDetect.detectBlockSignals); this is just the "when to
  // check, who to tell" wiring. A match is reported to the background worker,
  // which records the episode, alerts at most once per episode, pauses
  // whatever capture run is active (D-043/D-112's pending queue survives —
  // see background.js's handleBlockDetected), and reports it to the
  // dashboard. An unrecognised page — including a genuinely empty search or a
  // 404/removed listing — never reaches the sendMessage below:
  // detectBlockSignals returns blocked:false for it by construction (see its
  // own module comment + the false-positive tests).
  let lastBlockCheckHref = null;
  function checkForBlock() {
    try {
      const url = window.location.href;
      if (lastBlockCheckHref === url) return; // already checked this exact URL
      lastBlockCheckHref = url;
      const portal = D.supportedPortalForUrl(url);
      if (!portal) return; // not one of our portals — nothing to report
      const verdict = D.detectBlockSignals(document, portal);
      if (verdict.blocked) {
        chrome.runtime.sendMessage({
          type: "BLOCK_DETECTED",
          portal,
          signature: verdict.signature,
        });
      }
    } catch {
      /* detection must never break the page or capture */
    }
  }

  function showToast(text) {
    try {
      const el = document.createElement("div");
      el.textContent = text;
      el.setAttribute("data-inmo-toast", "1");
      Object.assign(el.style, {
        position: "fixed",
        bottom: "20px",
        right: "20px",
        zIndex: "2147483647",
        background: "#0f172a",
        color: "#fff",
        font: "600 13px/1.4 -apple-system, Segoe UI, sans-serif",
        padding: "10px 16px",
        borderRadius: "10px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        opacity: "0",
        transition: "opacity .25s ease",
        pointerEvents: "none",
      });
      document.body.appendChild(el);
      requestAnimationFrame(() => {
        el.style.opacity = "1";
      });
      setTimeout(() => {
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 300);
      }, 3500);
    } catch {
      /* a toast failure must never break capture */
    }
  }

  function fireCapture(info) {
    // info.key was already claim()ed by the caller.
    let html;
    try {
      html = document.documentElement.outerHTML;
    } catch {
      guard.release(info.key);
      return;
    }
    let responded = false;
    try {
      chrome.runtime.sendMessage(
        { type: "EXTRACT", url: window.location.href, html },
        (res) => {
          responded = true;
          if (chrome.runtime.lastError || !res || !res.success) {
            // Failed to enqueue — allow a later retry (next mutation / poll).
            guard.release(info.key);
            return;
          }
          guard.settle(info.key);
          showToast("Inmo-Tool: anuncio capturado automáticamente ✓");
          // Ask the service worker to flash the toolbar badge for this tab.
          try {
            chrome.runtime.sendMessage({ type: "AUTO_CAPTURE_DONE" });
          } catch {
            /* badge is cosmetic */
          }
        },
      );
    } catch {
      guard.release(info.key);
      return;
    }
    // If the service worker was asleep and the callback never fires, don't
    // leave the key wedged in-flight forever.
    setTimeout(() => {
      if (!responded) guard.release(info.key);
    }, MAX_WAIT_MS);
  }

  // After the page is "ready", wait for the DOM to go quiet (no mutations for
  // QUIESCENCE_MS) so async widgets finish before we snapshot the HTML.
  function waitForQuiescenceThenFire(info) {
    let settleTimer = null;
    let obs = null;

    const done = () => {
      if (settleTimer) clearTimeout(settleTimer);
      if (obs) obs.disconnect();
      // Re-check we're still on the same detail page and haven't fired.
      const now = currentDetail();
      if (!now || now.key !== info.key) return;
      // Last-moment block guard (issue #634): a challenge that appeared AFTER
      // this detail page's initial render (e.g. a late JS-injected
      // interstitial) would otherwise get captured as if it were the real
      // listing. Re-check right before snapshotting the DOM; on a match,
      // report it and leave the guard key un-claimed instead of firing — a
      // challenge page must never be ingested as listing data, and a later
      // retry (once the block clears) can still claim this key.
      const blockVerdict = D.detectBlockSignals(document, info.portal);
      if (blockVerdict.blocked) {
        try {
          chrome.runtime.sendMessage({
            type: "BLOCK_DETECTED",
            portal: info.portal,
            signature: blockVerdict.signature,
          });
        } catch {
          /* best-effort */
        }
        return;
      }
      if (guard.claim(info.key)) fireCapture(info);
    };

    try {
      obs = new MutationObserver(() => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(done, QUIESCENCE_MS);
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch {
      /* observer unavailable — fall through to the timer */
    }
    settleTimer = setTimeout(done, QUIESCENCE_MS);
  }

  function pollUntilReady(info, deadline) {
    if (guard.isDone(info.key)) return;
    const now = currentDetail();
    if (!now || now.key !== info.key) return; // navigated away — stop
    if (D.isRenderReady(document, info.portal)) {
      waitForQuiescenceThenFire(info);
      return;
    }
    if (Date.now() > deadline) return; // gave up; manual popup still works
    setTimeout(() => pollUntilReady(info, deadline), READY_POLL_MS);
  }

  function startAutoCaptureLoop() {
    // A tab in VALIDATION MODE (#478 P3) never auto-captures a detail page — the
    // owner is validating the search filters, not capturing. Same early-return
    // shape as the discover guard below; survives in-portal navigation via the
    // per-tab `validationActive` flag once the URL fragment is stripped.
    if (D.inValidationMode(window.location.href, validationActive)) return;
    // A page opened for URL-building DISCOVERY (#inmo-discover) is NOT a capture
    // target — bail so the listing-capture banner/auto-start never fires there
    // (issue #377: the /etl/discovery page was still offering "capturar N").
    if (D.discoverSignalPresent(window.location.href)) return;
    const info = currentDetail();
    if (!info) return; // not a detail page
    if (guard.isDone(info.key)) return; // already captured this listing
    if (loopKey === info.key) return; // already watching this page
    loopKey = info.key;
    pollUntilReady(info, Date.now() + MAX_WAIT_MS);
  }

  // ── 3. Listing/search pages: in-page banner + auto-start (issue #297) ──────
  //
  // On a recognized SEARCH/RESULTS page the owner previously got nothing until
  // they hunted for "Capturar todas" in the popup. Now, once the page renders:
  //   - if the URL carries the app's auto-start signal (#inmo-capture — set by
  //     the dashboard's "Abrir búsqueda") → auto-start the SAME batch the popup
  //     would (START_BATCH → background), no click needed;
  //   - otherwise → inject a small, dismissible, branded banner whose "Capturar
  //     todas" button starts that same batch.
  // Both reuse the existing batch queue (issue #262/#279) verbatim — this file
  // only decides WHEN to fire START_BATCH and (for the banner) renders the
  // trigger. N = extractDetailUrls(...).length.
  let listingHandled = false; // fired the banner/auto-start for the current URL
  let bannerEl = null;

  function currentListing() {
    const url = window.location.href;
    const portal = D.listingPortalForUrl(url);
    if (!portal) return null;
    return { url, portal };
  }

  function harvestDetailUrls(portal) {
    const hrefs = Array.from(document.querySelectorAll("a[href]")).map(
      (a) => a.href,
    );
    return D.extractDetailUrls(hrefs, portal);
  }

  function removeBanner() {
    if (bannerEl) {
      try {
        bannerEl.remove();
      } catch {
        /* already gone */
      }
      bannerEl = null;
    }
  }

  // Kick off the SAME batch run as the popup's "Capturar todas": seed + drive
  // the sequential/jittered queue in the background service worker (batch.js).
  // We pass this search page's OWN url as `searchUrl` so the background's
  // capture-to-infer piggyback (issue #303) learns its grammar exactly as the
  // popup path does — signal-stripped so our synthetic #inmo-capture (and,
  // issue #556, our synthetic ?inmo-capture-queue) never pollute the learned
  // example.
  //
  // `queue` (issue #556, optional) carries the REST of the dashboard's
  // "Capturar todo" ticked tasks — `{portal, searchUrl}[]`, parsed by the
  // caller via `D.parseCaptureQueue`. background.js's `startBatch` appends
  // each entry to the #555/D-112 pending-search queue right behind this
  // search, regardless of whether THIS search claims the run or is itself
  // queued — the extension then opens each one itself, one at a time.
  function startBatchFromPage(portal, urls, queue) {
    removeBanner();
    const searchUrl = D.stripCaptureQueue(D.stripCaptureSignal(window.location.href));
    const extra = Array.isArray(queue) ? queue : [];
    let responded = false;
    try {
      chrome.runtime.sendMessage(
        { type: "START_BATCH", portal, urls, searchUrl, queue: extra },
        (res) => {
          responded = true;
          if (chrome.runtime.lastError || !res) {
            showToast("Inmo-Tool: no se pudo iniciar la captura por lotes");
            return;
          }
          // Queued behind a live run (issue #554) — a real, expected outcome
          // on this feature's own workflow (firing off several searches in a
          // row via the D-053 banner / D-048 auto-start signal), never a
          // failure. Reported distinctly so the owner isn't told "no se pudo
          // iniciar" for a search that queued correctly.
          if (res.queued) {
            showToast(
              res.aheadCount > 0
                ? `Inmo-Tool: búsqueda en cola (${res.aheadCount} por delante)`
                : "Inmo-Tool: búsqueda en cola",
            );
            return;
          }
          if (!res.started) {
            showToast("Inmo-Tool: no se pudo iniciar la captura por lotes");
            return;
          }
          showToast(
            extra.length > 0
              ? `Inmo-Tool: capturando ${res.total} anuncio(s); ${extra.length} búsqueda(s) más en cola…`
              : `Inmo-Tool: capturando ${res.total} anuncio(s) en varias pestañas…`,
          );
        },
      );
    } catch {
      showToast("Inmo-Tool: no se pudo iniciar la captura por lotes");
      return;
    }
    // Service worker asleep and no callback — surface it rather than hang silent.
    setTimeout(() => {
      if (!responded) showToast("Inmo-Tool: no se pudo iniciar la captura");
    }, MAX_WAIT_MS);
  }

  function showBanner(portal, urls) {
    if (document.getElementById("inmo-capture-banner")) return; // already shown
    const el = D.buildCaptureBanner(document, {
      count: urls.length,
      // issue #556 review N2: a tab carrying the "Capturar todo" queue param
      // can ALSO land on the manual-banner path (e.g. no auto-start signal
      // present, just the queue riding along some other way) — forward the
      // parsed queue here too, exactly like the autostart branch does, so a
      // manual "Capturar todas" click never silently drops the rest.
      onCapture: () => startBatchFromPage(portal, urls, D.parseCaptureQueue(window.location.href)),
      onDismiss: () => removeBanner(),
    });
    if (!el || !document.body) return;
    document.body.appendChild(el);
    bannerEl = el;
  }

  // Map-view → listing-view "convert" banner (issue #529). A drawn-zone Idealista
  // search renders as a MAP of pins with no detail anchors, so nothing can be
  // captured HERE — but the listing (card) form of the same search can. Offer a
  // one-click navigation there (tagged with the auto-start signal so capture arms
  // on arrival). We NEVER silently redirect a page the owner opened themselves.
  function showConvertBanner(listingUrl) {
    if (document.getElementById("inmo-capture-banner")) return; // already shown
    const target = D.withCaptureSignal(listingUrl);
    const el = D.buildCaptureBanner(document, {
      label: "Inmo-Tool: ver esta zona como lista y capturar",
      buttonText: "Ver como lista y capturar",
      onCapture: () => window.location.assign(target),
      onDismiss: () => removeBanner(),
    });
    if (!el || !document.body) return;
    document.body.appendChild(el);
    bannerEl = el;
  }

  function handleListingWhenReady(info, deadline) {
    if (listingHandled) return;
    const now = currentListing();
    if (!now || now.url !== info.url) return; // navigated away — nav handler re-arms
    if (D.isRenderReady(document, info.portal)) {
      const urls = harvestDetailUrls(info.portal);
      const verdict = D.listingCaptureAction(info.url, urls);
      if (verdict.action === "none") {
        // Rendered but no detail links harvested yet — keep polling to deadline
        // (anchors may still be streaming in) before giving up.
        if (Date.now() > deadline) return;
        setTimeout(() => handleListingWhenReady(info, deadline), READY_POLL_MS);
        return;
      }
      listingHandled = true;
      if (verdict.action === "autostart") {
        // issue #556: forward any "Capturar todo" queue riding on this URL
        // (the dashboard's batch button) to the same batch start.
        startBatchFromPage(verdict.portal, urls, D.parseCaptureQueue(window.location.href));
      } else if (verdict.action === "convert") {
        // Idealista map-view (pins, zero anchors) — capture can't run here (#529).
        // If the tab already carries the auto-start signal (an app-opened URL, or
        // a hand URL we tagged), redirect straight to the listing form (the signal
        // rides along the preserved hash) so it autostarts there. Otherwise offer
        // a one-click banner — never silently move a page the owner opened.
        if (D.captureSignalPresent(window.location.href)) {
          // Carry the #556 queue param forward through the redirect too — it
          // rides in the query string (the fragment slot is CAPTURE_SIGNAL's),
          // which withCaptureSignal doesn't touch, so re-apply it explicitly.
          let target = D.withCaptureSignal(verdict.listingUrl);
          try {
            const rawQueue = new URL(window.location.href).searchParams.get(
              D.CAPTURE_QUEUE_SIGNAL,
            );
            if (rawQueue) {
              const t = new URL(target);
              t.searchParams.set(D.CAPTURE_QUEUE_SIGNAL, rawQueue);
              target = t.toString();
            }
          } catch {
            /* best-effort — never block the redirect over this */
          }
          window.location.replace(target);
        } else {
          showConvertBanner(verdict.listingUrl);
        }
      } else {
        showBanner(verdict.portal, urls);
      }
      return;
    }
    if (Date.now() > deadline) return; // never rendered enough — nothing to do
    setTimeout(() => handleListingWhenReady(info, deadline), READY_POLL_MS);
  }

  function startListingLoop() {
    if (listingHandled) return;
    // Validation mode (#478 P3): never show the "Capturar todas" banner or
    // auto-start a batch while the owner is validating this tab's search URL.
    if (D.inValidationMode(window.location.href, validationActive)) return;
    // Discovery-signalled pages (#inmo-discover) run the enumeration pass only —
    // suppress the "Capturar todas" listing banner/auto-start there (issue #377).
    if (D.discoverSignalPresent(window.location.href)) return;
    const info = currentListing();
    if (!info) return; // not a listing/search page
    handleListingWhenReady(info, Date.now() + MAX_WAIT_MS);
  }

  // Detect SPA route changes (URL changes without a full reload).
  let lastHref = window.location.href;
  function onMaybeNavigated() {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      loopKey = null;
      // A new URL is a fresh listing decision: drop any stale banner and re-arm.
      listingHandled = false;
      removeBanner();
      checkForBlock();
      startAutoCaptureLoop();
      startListingLoop();
      startObserveLoop();
    }
  }

  // ── 3. URL-building discovery pass (issue #336) ───────────────────────────
  //
  // When the dashboard's /etl/discovery opens a portal SEARCH page with the
  // `#inmo-discover` signal, enumerate the search form's filter OPTIONS + the
  // URL fragment each produces (self.InmoDiscover, pure) and POST the catalog
  // through the background worker. Reads FORM METADATA only — never listings.
  const DISCOVER_POLL_MS = 500;
  const DISCOVER_MAX_WAIT_MS = 20000;
  let discoveryHandled = false;

  function runDiscoveryWhenReady(url, deadline) {
    if (discoveryHandled) return;
    if (window.location.href !== url) return; // navigated away
    const Disc = self.InmoDiscover;
    if (!Disc) return; // discover.js failed to load — nothing to do
    const payload = Disc.buildDiscoveryPayload(url, document, new Date());
    if (payload) {
      discoveryHandled = true;
      let responded = false;
      try {
        chrome.runtime.sendMessage({ type: "DISCOVER_CATALOG", payload }, (res) => {
          responded = true;
          if (chrome.runtime.lastError || !res || !res.success) {
            showToast("Inmo-Tool: no se pudo guardar el catálogo de filtros");
            return;
          }
          showToast(
            "Inmo-Tool: catálogo de filtros capturado (" + (res.optionsCount || 0) + " opciones)",
          );
        });
      } catch {
        showToast("Inmo-Tool: no se pudo enviar el catálogo de filtros");
        return;
      }
      setTimeout(() => {
        if (!responded) showToast("Inmo-Tool: no se pudo enviar el catálogo de filtros");
      }, MAX_WAIT_MS);
      return;
    }
    // Options not enumerated yet (form/config may still be rendering) — retry.
    if (Date.now() > deadline) return;
    setTimeout(() => runDiscoveryWhenReady(url, deadline), DISCOVER_POLL_MS);
  }

  function startDiscoveryLoop() {
    if (discoveryHandled) return;
    const url = window.location.href;
    if (!D.discoverSignalPresent(url)) return; // not a discovery-signalled page
    runDiscoveryWhenReady(url, Date.now() + DISCOVER_MAX_WAIT_MS);
  }

  // ── 3b. Passive search-URL observer (issue #488, part of #471) ────────────
  //
  // As the owner browses a supported portal's SEARCH/RESULTS pages (idealista /
  // aliseda / altamira — #510), forward each distinct URL to the dashboard so
  // each portal's drawn-zone/filtering grammar can be analysed in bulk (#471,
  // and #514 for altamira). This is OBSERVE-ONLY: it never captures a listing,
  // never
  // navigates, and never interferes with the capture/validation flows. It is:
  //   - gated by the popup toggle "modo observación" (chrome.storage.sync
  //     `observeMode`, default ON) so the owner can silence it if noisy;
  //   - suppressed entirely in validation mode (#478 P3);
  //   - de-duped twice: an in-memory guard so a single page load forwards once,
  //     and a per-session set in the background worker so the same search isn't
  //     re-sent across reloads/tabs (see background.js postObservedSearchUrl).
  // Pure detection lives in observe-search-url.js (self.InmoObserve); this only
  // decides WHEN to forward and reads document.title off the live page.
  const OBSERVE_DEFAULT = true;
  let observedThisLoad = null; // normalised key already forwarded for this URL

  async function observeModeEnabled() {
    try {
      const cfg = await chrome.storage.sync.get("observeMode");
      return cfg.observeMode === undefined ? OBSERVE_DEFAULT : !!cfg.observeMode;
    } catch {
      return OBSERVE_DEFAULT;
    }
  }

  async function startObserveLoop() {
    const O = self.InmoObserve;
    if (!O) return; // observe-search-url.js failed to load — nothing to do
    // Never observe while validating (#478 P3): observe-only, but stay out of
    // the way of the owner tuning a search URL.
    if (D.inValidationMode(window.location.href, validationActive)) return;
    const url = window.location.href;
    if (!O.isObservableSearchUrl(url)) return; // not a search/results page on a supported portal
    const key = O.normalizeObservedUrl(url);
    if (!key || observedThisLoad === key) return; // already forwarded this URL
    if (!(await observeModeEnabled())) return; // toggle off
    const payload = O.buildObservedCapture({ url, title: document.title });
    if (!payload) return;
    observedThisLoad = key;
    try {
      chrome.runtime.sendMessage({ type: "OBSERVE_SEARCH_URL", payload }, () => {
        // Best-effort: swallow "receiving end does not exist" when the worker is
        // asleep — a later navigation re-arms the observer.
        void chrome.runtime.lastError;
      });
    } catch {
      /* worker unavailable — observation is passive, never surface an error */
    }
  }

  // ── 4. Validation mode bootstrap (issue #478 P3) ──────────────────────────
  //
  // On load, decide whether this tab is validating a search URL. Two entry
  // points, because the signal fragment is stripped off the visible URL:
  //   • FIRST open from "Validar filtros" → the URL carries
  //     `#inmo-validate=<pid>:<connector>`: register the tab with the background
  //     (so suppression survives in-portal navigation) and history.replaceState
  //     the fragment away so it's never persisted / bookmarked.
  //   • a plain RELOAD or in-portal navigation (fragment already gone) → ask the
  //     background whether this tab is still a validation tab.
  // Sets `validationActive` BEFORE the loops arm so nothing captures.
  async function initValidationMode() {
    const url = window.location.href;
    const payload = D.validateSignalPayload(url);
    if (payload) {
      validationActive = true;
      try {
        chrome.runtime.sendMessage({
          type: "START_VALIDATION",
          profileId: payload.profileId,
          connector: payload.connector,
        });
      } catch {
        /* background asleep — the URL signal still suppresses this load */
      }
      try {
        const clean = D.stripValidateSignal(url);
        if (clean !== url) history.replaceState(null, "", clean);
      } catch {
        /* replaceState best-effort — the signal is harmless if it lingers */
      }
      return;
    }
    // No signal on the URL: this may be a reload / in-portal nav of a tab that
    // is still validating. Ask the background for the per-tab state.
    try {
      const state = await chrome.runtime.sendMessage({ type: "GET_VALIDATION_STATE" });
      if (state && state.active) validationActive = true;
    } catch {
      /* background unavailable — default to NOT validating (normal capture) */
    }
  }

  (async () => {
    // Block detection (issue #634) runs FIRST and unconditionally — a
    // challenge takes priority over every other decision on this page, and
    // must not wait on the validation-mode round trip below.
    checkForBlock();
    // Resolve validation mode first so the loops below see the right verdict.
    await initValidationMode();
    // The banner + app-signal auto-start are ALWAYS available (the banner is a
    // manual button; the signal is an explicit per-open intent), independent of
    // the detail auto-capture kill switch.
    startListingLoop();
    startDiscoveryLoop();
    // Passive search-URL observer (#488) — observe-only, suppressed in
    // validation mode, gated by the "modo observación" toggle.
    startObserveLoop();
    if (await autoCaptureEnabled()) startAutoCaptureLoop();
    try {
      const navObs = new MutationObserver(onMaybeNavigated);
      navObs.observe(document, { childList: true, subtree: true });
    } catch {
      /* SPA-nav detection best-effort; first page load is already covered */
    }
    window.addEventListener("popstate", onMaybeNavigated);
    window.addEventListener("hashchange", onMaybeNavigated);
  })();
})();
