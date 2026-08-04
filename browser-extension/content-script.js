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
      sendResponse({
        isListing: !!listingPortal,
        isDetail: !!detailPortal,
        portal: listingPortal || detailPortal,
        detailUrls,
      });
      return true;
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
    const info = currentDetail();
    if (!info) return; // not a detail page
    if (guard.isDone(info.key)) return; // already captured this listing
    if (loopKey === info.key) return; // already watching this page
    loopKey = info.key;
    pollUntilReady(info, Date.now() + MAX_WAIT_MS);
  }

  // Detect SPA route changes (URL changes without a full reload).
  let lastHref = window.location.href;
  function onMaybeNavigated() {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      loopKey = null;
      startAutoCaptureLoop();
    }
  }

  (async () => {
    if (!(await autoCaptureEnabled())) return;
    startAutoCaptureLoop();
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
