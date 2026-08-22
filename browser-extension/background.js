/**
 * background.js — Service worker for the extension.
 * Handles API communication, badge logic, and the batch-capture queue.
 *
 * Forked from property_web_scraper's chrome-extensions/property-scraper/ —
 * see NOTICE.md. The haul/multi-tenant machinery (CREATE_HAUL, haul_id,
 * haul-history.js) is removed: this extension talks to exactly one
 * self-hosted inmo-tool backend, not an anonymous multi-tenant SaaS.
 *
 * Batch capture (issue #262, bounded concurrency #318): the pure queue logic
 * lives in batch.js (self.InmoBatch); this worker drives the chrome-tab
 * lifecycle around it — open+activate up to N detail tabs, staggered by a
 * jittered pace, wait for each content script's AUTO_CAPTURE_DONE, close it,
 * top the pool back up. See the "Batch capture" section below and D-043.
 */

// Pure queue state machine (makeBatchState/launchNext/recordResultAt/…) and the
// pure results-page pagination URL helpers (nextResultsUrl/resultsPageUrl,
// issue #362). Both are side-effect-free at load (no window/document/chrome),
// so the classic MV3 worker can synchronously importScripts them and read the
// URL helpers off self.InmoDetect.
importScripts("detect.js");
importScripts("batch.js");
// Pure helpers for the "Capturar URL de búsqueda" action (issue #475): validate
// an Idealista results URL and shape the capture payload. Side-effect-free at
// load; publishes self.InmoSearchUrl.
importScripts("capture-search-url.js");
// Pure helpers for the PASSIVE search-URL observer (issue #488): validate +
// normalize an Idealista search/results URL and shape the observe payload.
// Side-effect-free at load; publishes self.InmoObserve.
importScripts("observe-search-url.js");
// Pure redaction/truncation/shaping helpers for network capture (issue #671
// follow-up) — loaded here too (not just in the MAIN-world page recorder) so
// disarmNetworkRecording's entry-capping uses the SAME NR.capEntries the page
// recorder's own MAX_ENTRIES accounting mirrors, one implementation only.
// Side-effect-free at load; publishes self.InmoNetworkRecorder.
importScripts("network-recorder.js");

/**
 * Supported capture hosts are BACKEND-DRIVEN (issue #237): the dashboard's
 * GET /api/extension/config returns the current list (mirroring the ETL's
 * capture connectors), so adding a new portal lights up the badge with no
 * extension redeploy. This list only gates the cosmetic ✓ badge — capture
 * itself works on any http(s) tab (popup.js injects the content script on
 * demand) — so a stale cache or a failed fetch degrades gracefully to this
 * hardcoded default.
 */
const DEFAULT_CAPTURE_HOSTS = [
  'idealista.com',
  'alisedainmobiliaria.com',
  'altamirainmuebles.com',
  'realestate.hipoges.com',
];
// Refresh the cached host list at most this often (ms). Cached in
// chrome.storage.session so it survives the MV3 service worker being torn
// down and respawned, without re-fetching on every single badge update.
const CAPTURE_HOSTS_TTL_MS = 5 * 60 * 1000;

/**
 * Check if a hostname matches one of `hosts` (exact host or a subdomain).
 */
function isSupportedHost(hostname, hosts) {
  const h = hostname.replace(/^www\./, '');
  return hosts.some((s) => h === s || h.endsWith('.' + s));
}

/**
 * Return the current capture-host list, fetching it from the backend when the
 * cache is missing or stale. Never throws — falls back to DEFAULT_CAPTURE_HOSTS
 * on any error (unreachable backend, missing/invalid admin key, etc.).
 */
async function getCaptureHosts() {
  try {
    const cached = await chrome.storage.session.get(['captureHosts', 'captureHostsAt']);
    const fresh =
      Array.isArray(cached.captureHosts) &&
      typeof cached.captureHostsAt === 'number' &&
      Date.now() - cached.captureHostsAt < CAPTURE_HOSTS_TTL_MS;
    if (fresh) return cached.captureHosts;

    const { apiUrl, apiKey } = await getApiConfig();
    const response = await fetch(`${apiUrl}/api/extension/config`, {
      headers: { 'x-admin-key': apiKey },
    });
    if (!response.ok) throw new Error(`config ${response.status}`);
    const data = await response.json();
    const hosts = Array.isArray(data.capture_hosts) && data.capture_hosts.length > 0
      ? data.capture_hosts
      : DEFAULT_CAPTURE_HOSTS;
    await chrome.storage.session.set({ captureHosts: hosts, captureHostsAt: Date.now() });
    return hosts;
  } catch {
    return DEFAULT_CAPTURE_HOSTS;
  }
}

// ─── Badge updates on tab change ─────────────────────────────────

async function updateBadge(tabId, url) {
  try {
    const hostname = new URL(url).hostname;
    const hosts = await getCaptureHosts();
    if (isSupportedHost(hostname, hosts)) {
      chrome.action.setBadgeText({ tabId, text: '✓' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#22c55e' });
      chrome.action.setTitle({ tabId, title: 'Inmo-Tool Listing Capture — Supported site' });
    } else {
      chrome.action.setBadgeText({ tabId, text: '' });
      chrome.action.setTitle({ tabId, title: 'Inmo-Tool Listing Capture' });
    }
  } catch {
    chrome.action.setBadgeText({ tabId, text: '' });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    updateBadge(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) updateBadge(tab.id, tab.url);
  } catch {
    /* ignore */
  }
});

// ─── API communication ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'EXTRACT') {
    handleExtraction(msg)
      .then((res) => {
        // A real capture succeeding is the resolve signal for a block episode
        // (issue #634) — see clearBlockIfActive's docstring for why this is
        // preferred over "a render didn't show a marker".
        if (res && res.success) {
          const portal = self.InmoDetect && self.InmoDetect.detailPortalForUrl(msg.url);
          if (portal) clearBlockIfActive(portal).catch(() => {});
        }
        sendResponse(res);
      })
      .catch((err) => {
        sendResponse({ success: false, error: { message: err.message } });
      });
    return true; // async response
  }

  // Block/challenge detection (issue #634) — see content-script.js's
  // checkForBlock/the detail-page last-moment guard for what triggers this,
  // and handleBlockDetected's docstring for the full stop/alert/report
  // response. Fire-and-forget: no response needed.
  if (msg.type === 'BLOCK_DETECTED') {
    handleBlockDetected(msg.portal, msg.signature).catch(() => {
      /* best-effort — a failure here must never surface to the page */
    });
    return false;
  }

  if (msg.type === 'CHECK_CAPTURE_STATUS') {
    handleCheckStatus(msg.captureId).then(sendResponse).catch((err) => {
      sendResponse({ success: false, error: { message: err.message } });
    });
    return true; // async response
  }

  if (msg.type === 'CHECK_SUPPORT') {
    getCaptureHosts()
      .then((hosts) => sendResponse({ supported: isSupportedHost(msg.hostname, hosts) }))
      .catch(() => sendResponse({ supported: false }));
    return true; // async response (host list may need a backend fetch)
  }

  // Guided capture (issue #237): the popup lands on a supported portal on a page
  // it can't capture (home / saved search / filter form) and asks for that
  // portal's worklist progress so it can GUIDE the owner — show N/M captured and
  // open the next pending listing — instead of blind-capturing junk. Needs the
  // admin key, which only the background worker holds.
  if (msg.type === 'GET_WORKLIST_PROGRESS') {
    fetchWorklistProgress(msg.portal)
      .then((progress) => sendResponse({ success: true, progress }))
      .catch((err) => sendResponse({ success: false, error: { message: err.message } }));
    return true; // async response
  }

  // Capturar URL de búsqueda (issue #475, part of #471): the popup captured the
  // active Idealista results-page URL (with its `shape=` drawn-zone param) and
  // asks the worker to persist it to the dashboard. Needs the admin key, which
  // only the background worker holds.
  if (msg.type === 'CAPTURE_SEARCH_URL') {
    postCapturedSearchUrl(msg.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: { message: err.message } }));
    return true; // async response
  }

  // Passive search-URL observation (issue #488, part of #471): the content
  // script forwards every Idealista search/results URL the owner browses. The
  // worker DE-DUPS against a per-session set (so the same normalised search is
  // sent once per session) and, when new, POSTs it to the dashboard. Needs the
  // admin key, which only the background worker holds. Best-effort — a failure
  // never affects the page.
  if (msg.type === 'OBSERVE_SEARCH_URL') {
    postObservedSearchUrl(msg.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: { message: err.message } }));
    return true; // async response
  }

  // Validation mode (issue #478 P3): the content script detected the
  // `#inmo-validate` signal on load and asks the worker to remember this tab as a
  // validation tab (so suppression survives in-portal navigation once the
  // fragment is stripped). No admin key needed — pure per-tab session state.
  if (msg.type === 'START_VALIDATION') {
    const tabId = _sender.tab && _sender.tab.id;
    startValidation(tabId, msg.profileId, msg.connector)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true; // async
  }

  // Both the content script (loops) and the popup (validation panel) read the
  // per-tab validation state. The popup passes the active tab's id explicitly;
  // the content script omits it and we use the sender tab.
  if (msg.type === 'GET_VALIDATION_STATE') {
    const tabId = msg.tabId != null ? msg.tabId : _sender.tab && _sender.tab.id;
    getValidationState(tabId)
      .then(sendResponse)
      .catch(() => sendResponse({ active: false }));
    return true; // async
  }

  // "Salir del modo validación" from the popup — clear this tab's validation
  // state so the normal capture flows resume.
  if (msg.type === 'END_VALIDATION') {
    const tabId = msg.tabId != null ? msg.tabId : _sender.tab && _sender.tab.id;
    endValidation(tabId)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true; // async
  }

  // "Usar esta URL como filtro" from the popup (issue #478 P3): pin the tab's
  // current (signal-stripped) URL as the (profile × connector) filter via the
  // admin-gated PUT. The admin key only ever lives in this worker (like #475);
  // the profile id + connector come from the tab's validation state, never the
  // untrusted message.
  if (msg.type === 'SAVE_VALIDATION_URL') {
    const tabId = msg.tabId != null ? msg.tabId : _sender.tab && _sender.tab.id;
    saveValidationUrl(tabId, msg.url)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: { message: err.message } }));
    return true; // async
  }

  // URL-building discovery (issue #336): the content script enumerated a
  // portal's search-form filter options and the URL fragment each produces;
  // persist the catalog via the ingest route so the connector's URL builder can
  // read it. Needs the admin key, which only the background worker holds.
  if (msg.type === 'DISCOVER_CATALOG') {
    postFilterCatalog(msg.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: { message: err.message } }));
    return true; // async response
  }

  // Auto-capture (issue #254) fired in the content script — flash the toolbar
  // badge for that tab so the auto-capture is never silent. Cosmetic only; no
  // response needed. ALSO the settle signal for a batch run (issue #262): if
  // this is one of the tabs the batch loop is waiting on, unblock that tab's
  // wait. With bounded concurrency (issue #318) there may be several concurrent
  // waits — one per open tab — so we look the resolver up by tab id.
  if (msg.type === 'AUTO_CAPTURE_DONE') {
    const tabId = _sender.tab && _sender.tab.id;
    if (tabId != null) {
      chrome.action.setBadgeText({ tabId, text: '✓' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#22c55e' });
      chrome.action.setTitle({ tabId, title: 'Inmo-Tool — Capturado automáticamente' });
      const finish = batchWaiters.get(tabId);
      if (finish) finish(true);
    }
    return false; // no async response
  }

  // ── Batch capture control (issue #262) ─────────────────────────────────
  if (msg.type === 'START_BATCH') {
    startBatch(msg).then(sendResponse).catch((err) => {
      sendResponse({ started: false, error: { message: err.message } });
    });
    return true; // async
  }
  if (msg.type === 'GET_BATCH_STATE') {
    // Opening the popup is also our instant eviction-recovery trigger: if the
    // run is stranded (state running, loop dead), re-attach now rather than
    // waiting for the 30 s watchdog alarm.
    reattachIfStranded();
    (async () => {
      // Pending-search queue depth + what's next (issue #554) rides along on
      // every progress read so the popup can render it without a second
      // round trip.
      const q = await queueSummary();
      // The enumeration phase (issue #362) runs before the capture queue exists;
      // surface it as a distinct 'enumerating' status with the growing count.
      const enumState = await getEnumState();
      if (enumState && enumState.status === 'enumerating') {
        const discovered = enumState.discovered || 0;
        return {
          status: 'enumerating',
          total: discovered,
          done: 0,
          captured: 0,
          failed: 0,
          inflight: 0,
          discovered,
          page: enumState.page || 1,
          ...q,
        };
      }
      return { ...InmoBatch.progress(await getBatchState()), ...q };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ ...InmoBatch.progress(null), queueDepth: 0, queueNext: null }));
    return true; // async
  }
  if (msg.type === 'PAUSE_BATCH') {
    mutateBatch(InmoBatch.pause).then(sendResponse);
    return true; // async
  }
  if (msg.type === 'RESUME_BATCH') {
    mutateBatch(InmoBatch.resume)
      .then((p) => {
        runBatchLoop(); // restart the driver if it had exited
        sendResponse(p);
      });
    return true; // async
  }
  if (msg.type === 'STOP_BATCH') {
    stopBatch().then(sendResponse);
    return true; // async
  }

  // ── Pending-search queue control (issue #554) ──────────────────────────
  // "Detener" is a full stop, so it also drains the queue — see stopBatch's
  // docstring. These two act only on searches that HAVEN'T started yet.
  if (msg.type === 'GET_SEARCH_QUEUE') {
    queueSummary().then(sendResponse).catch(() => sendResponse({ queueDepth: 0, queueNext: null }));
    return true; // async
  }
  if (msg.type === 'REMOVE_QUEUED_SEARCH') {
    (async () => {
      const queue = InmoBatch.removeSearchAt(await getSearchQueue(), msg.index);
      await setSearchQueue(queue);
      return queueSummary();
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ queueDepth: 0, queueNext: null }));
    return true; // async
  }
  if (msg.type === 'CLEAR_SEARCH_QUEUE') {
    setSearchQueue(InmoBatch.clearSearchQueue())
      .then(() => sendResponse({ queueDepth: 0, queueNext: null }))
      .catch(() => sendResponse({ queueDepth: 0, queueNext: null }));
    return true; // async
  }

  // ── Auto-capture continuous driver (issue #424) ────────────────────────────
  if (msg.type === 'START_AUTO') {
    startAuto(msg.portal || null)
      .then(sendResponse)
      .catch((err) => sendResponse({ enabled: false, error: { message: err.message } }));
    return true; // async
  }
  if (msg.type === 'STOP_AUTO') {
    stopAuto().then(sendResponse);
    return true; // async
  }
  if (msg.type === 'GET_AUTO_STATE') {
    getAutoProgress().then(sendResponse).catch(() => sendResponse(null));
    return true; // async
  }
  if (msg.type === 'SET_AUTO_FORCE') {
    setAutoForce(msg.force === true)
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true; // async
  }

  // "Forzar captura + diagnóstico" (issue #671). The popup already asked the
  // content script for {html, url, title, diagnostic}; this sends it to the
  // dashboard's dedicated diagnostic endpoint — NEVER /api/extension/capture,
  // a completely separate table/route that no ingest path reads (see
  // sendDiagnostic's docstring). If a network recording was armed for this
  // tab, the buffered redacted entries ride along and the recorder is torn
  // down (STOP_NETWORK_RECORDING semantics, inlined) regardless of send
  // success — a recorder must never keep running after the owner asked to
  // send what it had.
  if (msg.type === 'SEND_DIAGNOSTIC') {
    const tabId = msg.tabId != null ? msg.tabId : _sender.tab && _sender.tab.id;
    (async () => {
      const network = await disarmNetworkRecording(tabId);
      try {
        const res = await sendDiagnostic({
          url: msg.url,
          html: msg.html,
          title: msg.title,
          diagnostic: msg.diagnostic,
          network,
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ success: false, error: { message: err.message } });
      }
    })();
    return true; // async
  }

  // "Grabar red y recargar" (issue #671 follow-up): arm the MAIN-world
  // fetch/XHR recorder for this tab's origin, then the popup reloads it. The
  // host-permission grant (chrome.permissions.request) MUST happen in the
  // popup itself — a service worker has no user-activation signal, so
  // permissions.request would silently fail here (Chrome requires a real
  // user gesture on an extension page). This handler only registers the
  // dynamic content scripts once the popup confirms permission was granted.
  if (msg.type === 'ARM_NETWORK_RECORDING') {
    const tabId = msg.tabId != null ? msg.tabId : _sender.tab && _sender.tab.id;
    armNetworkRecording(tabId, msg.origin)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: { message: err.message } }));
    return true; // async
  }

  // Issue #705: which pending prospective-site origins still lack a host
  // permission. Only the POPUP can request one (Chrome needs a user gesture on
  // an extension page), so the worker can only report what to ask for.
  if (msg.type === 'GET_SPIKE_PERMISSIONS') {
    spikeOriginsNeedingPermission()
      .then((origins) => sendResponse({ origins }))
      .catch(() => sendResponse({ origins: [] }));
    return true; // async
  }

  if (msg.type === 'GET_NETWORK_RECORDING_STATE') {
    const tabId = msg.tabId != null ? msg.tabId : _sender.tab && _sender.tab.id;
    sendResponse(getNetworkRecordingState(tabId));
    return true;
  }

  // Explicit stop without sending (owner changed their mind) — tears the
  // recorder down and discards the buffer, same lifecycle guarantee as
  // SEND_DIAGNOSTIC's implicit disarm.
  if (msg.type === 'STOP_NETWORK_RECORDING') {
    const tabId = msg.tabId != null ? msg.tabId : _sender.tab && _sender.tab.id;
    disarmNetworkRecording(tabId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: { message: err.message } }));
    return true; // async
  }

  // The MAIN-world recorder → ISOLATED-world relay → here. Buffer per tab,
  // capped (network-recorder.js NR.capEntries at flush time keeps the MOST
  // RECENT MAX_ENTRIES — recording only happens while a session is actively
  // armed, so an entry arriving for a tab with no active session is dropped
  // silently (a race on disarm, or a stray postMessage from a stale page).
  if (msg.type === 'NETWORK_ENTRY') {
    const tabId = _sender.tab && _sender.tab.id;
    recordNetworkEntry(tabId, msg.entry);
    return false; // fire-and-forget
  }
});

// ═══ Batch capture ══════════════════════════════════════════════════════════
//
// A fully-automated BOUNDED-CONCURRENCY queue (issue #262 + #318, D-043). The
// operator clicks "Capturar todas (N)" once on a listing page; from there this
// worker:
//   1. seeds the harvested detail URLs into capture_worklist (added_via
//      'derived'), then loads the portal's PENDING set as the queue,
//   2. opens up to `concurrency` URLs at a time (operator-configured, clamped to
//      [1, 8] — issue #410), each in a NEW tab. By default it ACTIVATES the tab
//      — an active tab renders normally (background tabs are throttled, which is
//      why an unbounded wall of tabs never works, see the issue) — so the content
//      script's existing auto-capture (issue #254) fires and posts the capture.
//      An opt-in "background-tab" mode opens the tab UNFOCUSED instead (no focus
//      theft) for fast-rendering portals — see captureOnePage,
//   3. STAGGERS launches by a JITTERED delay (WAF safety — never a simultaneous
//      burst; base+spread are operator dials), waits for each tab's
//      AUTO_CAPTURE_DONE (or a timeout), closes the tab, and keeps the in-flight
//      pool topped up to the cap.
// Progress lives in chrome.storage.session so a reopened popup (or a respawned
// worker) can render N/M with stop/resume.
//
// Why concurrency stays bounded (see D-043): WAF safety (idealista CAPTCHA /
// aliseda `Disallow: /`) AND Chrome background-tab render throttling — in the
// default ACTIVE mode only the focused tab renders reliably, so the jittered
// stagger gives each tab a foreground window to render+capture before the next
// launch steals focus. Past a point, later in-flight tabs sit throttled in the
// background and time out, so MORE concurrency HURTS reliability. Default N=3;
// the hard cap is 8 (raised from 5 in #410 to give the owner headroom). The
// speed/reliability/WAF trade-off is the operator's to tune.
//
// MV3 eviction: the driver loop is in-memory. Chrome can evict the worker
// mid-run (e.g. a slow/CAPTCHA page emitting no events for ~30 s). The queue
// STATE survives (storage.session), and a watchdog (chrome.alarms +
// onStartup/onInstalled, plus every popup open) re-attaches the loop: it closes
// the tabs orphaned at eviction time (their ids are persisted), resets those
// in-flight slots back to pending, and restarts the driver.

const BATCH_KEY = 'inmoBatch';
// Results-page ENUMERATION phase (issue #362). Before the capture queue runs, a
// batch started from a results page walks every results page (rendered, in the
// authenticated session — the only way to enumerate a client-side-rendered
// portal like Aliseda) and seeds each page's detail URLs. This session key
// holds that phase's progress ({status:'enumerating', portal, discovered,
// page}) so a reopened popup can render "Descubriendo…" while it runs; it's
// cleared the moment enumeration finishes and the capture queue takes over.
const BATCH_ENUM_KEY = 'inmoBatchEnum';
// The tabs the loop currently has open (an array), persisted so a respawned
// worker can reconcile (close) them after an eviction rather than leaking them.
const BATCH_TABS_KEY = 'inmoBatchTabs';
// Pending-search queue (issue #554): searches fired off while a run is
// already live queue up here instead of clobbering BATCH_KEY. Same
// chrome.storage.session lifetime as the batch state it queues behind — see
// batch.js's "Pending-search queue" section for the pure array ops
// (enqueueSearch/dequeueSearch/…) that operate on it.
const BATCH_QUEUE_KEY = 'inmoBatchSearchQueue';
// Watchdog alarm that recovers a stranded run without any user action.
const BATCH_ALARM = 'inmoBatchWatchdog';
// 0.5 min = 30 s, Chrome's minimum periodic-alarm interval. Short enough to
// recover an unattended run promptly, long enough not to churn. (A popup open
// recovers instantly via GET_BATCH_STATE; this is the no-user-present net.)
const BATCH_ALARM_PERIOD_MIN = 0.5;
// Capture tuning is USER-CONFIGURABLE (issue #410) via chrome.storage.sync,
// read through getBatchConfig() and clamped by batch.js. These consts are only
// the fallbacks used when a value is absent (getBatchConfig applies the same
// clamps, which default to these).
//   • concurrency — how many detail tabs may be open at once (clamped to
//     [1, InmoBatch.MAX_CONCURRENCY=8]). Kept small by default (3) — WAF safety
//     + Chrome background-tab render throttling. See D-043 for why more isn't
//     always better.
//   • stagger BASE/SPREAD — a randomised dwell between launches whose BASE
//     lengthens as the run gets long (InmoBatch.paceBaseMs); the jitter/spread
//     is the WAF pacing guarantee that keeps the N tabs from opening at once.
// The enumeration phase (one reused tab) still uses these default constants.
const BATCH_PACE_SPREAD_MS = InmoBatch.DEFAULT_PACE_SPREAD_MS;
const BATCH_PACE_BASE_MS = InmoBatch.DEFAULT_PACE_BASE_MS;
// Give one page this long to render + auto-capture before counting it failed
// and moving on (mirrors the content script's own MAX_WAIT_MS, plus slack for
// tab creation).
const BATCH_CAPTURE_TIMEOUT_MS = 30000;

// Transient (not persisted): the tabs the loop currently has open, the per-tab
// resolvers that unblock each in-flight wait (keyed by tab id, since with
// concurrency several waits are outstanding at once), and a re-entrancy guard
// so only one driver loop runs at a time.
const batchTabIds = new Set();
const batchWaiters = new Map(); // tabId -> finish(ok)
let batchLooping = false;
// In-memory liveness flag for the results-page ENUMERATION phase (issue #516).
// Unlike the capture queue (whose `running` state + slot array survive eviction
// and are re-attached by the watchdog), the enumeration walk has no resumable
// persisted state — so a worker eviction mid-enumeration would strand its
// session `BATCH_ENUM_KEY` with no loop driving it, and isBatchActive() would
// then report "active" forever (auto wedged). This flag lets the harvest
// eviction-recovery (recoverStrandedHarvest) tell "actively enumerating in THIS
// worker" (true) from "a persisted enum state with no live walk" (false, e.g.
// after a respawn). It is intentionally NOT persisted.
let enumRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the operator's capture-tuning knobs (issue #410) from chrome.storage.sync
 * and clamp every value through batch.js so a bad/garbage config can never burst
 * tabs or remove the WAF-safety stagger:
 *   • concurrency   — [1, MAX_CONCURRENCY=8]         (default 3)
 *   • paceBaseMs    — [MIN, MAX] stagger base ms      (default 2000)
 *   • paceSpreadMs  — [MIN, MAX] stagger spread ms    (default 5000)
 *   • backgroundTabs — open detail tabs unfocused     (default false = active)
 * Defaults reproduce the previous behaviour, so an operator who never touches
 * options gets the (now faster) out-of-the-box cadence with no surprises.
 */
async function getBatchConfig() {
  const c = await chrome.storage.sync.get([
    'batchConcurrency',
    'batchPaceBaseMs',
    'batchPaceSpreadMs',
    'batchBackgroundTabs',
  ]);
  return {
    concurrency: InmoBatch.clampConcurrency(c.batchConcurrency),
    paceBaseMs: InmoBatch.clampPaceBase(c.batchPaceBaseMs),
    paceSpreadMs: InmoBatch.clampSpread(c.batchPaceSpreadMs),
    // Opt-in: only true when explicitly enabled. The safe default is the ACTIVE
    // (focus-stealing) mode that renders reliably (D-043).
    backgroundTabs: c.batchBackgroundTabs === true,
  };
}

async function getBatchState() {
  const o = await chrome.storage.session.get(BATCH_KEY);
  return o[BATCH_KEY] || null;
}

async function setBatchState(state) {
  await chrome.storage.session.set({ [BATCH_KEY]: state });
}

// ── Pending-search queue (issue #554) ─────────────────────────────────────
async function getSearchQueue() {
  const o = await chrome.storage.session.get(BATCH_QUEUE_KEY);
  return Array.isArray(o[BATCH_QUEUE_KEY]) ? o[BATCH_QUEUE_KEY] : [];
}
async function setSearchQueue(queue) {
  await chrome.storage.session.set({
    [BATCH_QUEUE_KEY]: Array.isArray(queue) ? queue : [],
  });
}

/**
 * The popup-friendly view of the pending-search queue: depth, what's next,
 * and the full list (so the popup can offer removing any one entry, not just
 * the next). Small payload — only non-empty while searches are actually
 * waiting.
 */
async function queueSummary() {
  const queue = await getSearchQueue();
  const next = InmoBatch.peekNextSearch(queue);
  return {
    queueDepth: InmoBatch.searchQueueDepth(queue),
    queueNext: next ? { portal: next.portal, searchUrl: next.searchUrl } : null,
    queueList: queue.map((e) => ({ portal: e.portal, searchUrl: e.searchUrl })),
  };
}

// ── Enumeration-phase state (issue #362) ──────────────────────────────────
async function getEnumState() {
  const o = await chrome.storage.session.get(BATCH_ENUM_KEY);
  return o[BATCH_ENUM_KEY] || null;
}
async function setEnumState(state) {
  await chrome.storage.session.set({ [BATCH_ENUM_KEY]: state });
}
async function clearEnumState() {
  await chrome.storage.session.remove(BATCH_ENUM_KEY);
}
/**
 * True once the run was stopped mid-enumeration (enum state cleared), OR a
 * block episode is now active for `portal` (issue #634) — a challenge
 * detected on the enumeration tab must break the results-page walk on its
 * very next iteration, same as an operator STOP_BATCH. `portal` is optional
 * so existing call sites that only care about the STOP_BATCH case keep
 * working unchanged.
 */
async function enumerationStopped(portal) {
  if ((await getEnumState()) == null) return true;
  if (portal && (await isPortalBlocked(portal))) return true;
  return false;
}

// ── Block/challenge episodes (issue #634) ──────────────────────────────────
//
// Persisted per-portal in chrome.storage.session (same lifetime as the rest
// of the run state — a browser restart naturally clears a stale block, since
// the owner would be starting fresh anyway). The pure state machine
// (recordBlock/clearBlock/isPortalBlocked) lives in batch.js; this is the
// storage + response wiring: pause whatever run is active, alert at most once
// per episode, and report to the dashboard so /etl/salud shows it without the
// browser open.
const BLOCK_STATE_KEY = 'inmoBlockState';
// In-memory (NOT persisted — a worker respawn just means a claim is
// forgotten, which self-heals on the next detection): which portals
// currently have a report POST in flight, so a burst of concurrent
// detections (review B2) can't all decide to retry the SAME dropped report
// at once. Claimed atomically inside handleBlockDetected's exclusive
// section; released by tryReportBlockEpisode's `finally`.
const reportInFlight = new Set();

async function getBlockState() {
  const o = await chrome.storage.session.get(BLOCK_STATE_KEY);
  return o[BLOCK_STATE_KEY] || {};
}
async function setBlockState(state) {
  await chrome.storage.session.set({ [BLOCK_STATE_KEY]: state || {} });
}
async function isPortalBlocked(portal) {
  return InmoBatch.isPortalBlocked(await getBlockState(), portal);
}
/** The single active block episode, if any — for the popup's armed-status line. */
async function activeBlockSummary() {
  const state = await getBlockState();
  for (const portal of Object.keys(state)) {
    const entry = InmoBatch.blockEntry(state, portal);
    if (entry) return { portal, signature: entry.signature, detectedAt: entry.detectedAt };
  }
  return null;
}

/**
 * A challenge page was detected (content-script.js, on any of the
 * extension's supported portals). Stop the run — do not grind on: pause the
 * batch loop (never drain — D-043/D-112's pending queue and search queue
 * must survive untouched so a resume picks up exactly where it left off)
 * and let the in-flight enumeration walk see the block on its own next
 * per-page check (enumerationStopped, above). Alerts + reports to the
 * dashboard ONLY on a NEW episode (isNewEpisode) — a repeat detection for an
 * already-active episode never re-notifies, per the "one alert per episode,
 * not per tab" rule, but DOES retry the dashboard report if the first
 * attempt never landed (review "a dropped report is lost permanently").
 */
async function handleBlockDetected(portal, signature) {
  if (typeof portal !== 'string' || !portal) return;
  const now = Date.now();

  // Atomic read-modify-write (issue #634 review B2). D-043's concurrency cap
  // means up to N (default 3, hard cap 8) capture tabs can be open at once,
  // and a WAF flip is per-egress-IP, not per-tab — every in-flight tab can
  // render the SAME challenge within milliseconds of each other. Without
  // this serializer, N concurrent BLOCK_DETECTED messages would all read the
  // same "not active yet" snapshot and all decide isNewEpisode:true, firing
  // N notifications/reports for one episode. Every other shared-state
  // mutation in this file (batch state, the enumeration claim, the search
  // queue) already goes through this same serializer for exactly this
  // reason — this closes the same class of race for block state.
  // `shouldReport` is decided ATOMICALLY in the SAME exclusive section as the
  // record itself — deciding it afterward (a separate in-memory
  // check-then-add) would reopen the exact concurrency race this whole
  // function exists to close: N concurrent repeat-detections could all read
  // `reported: false` before any of them finishes reporting and all attempt
  // it. Claiming the attempt (adding to reportInFlight) here, inside the
  // lock, makes "who gets to report right now" as race-free as "who gets to
  // record the episode".
  const { entry, isNewEpisode, shouldReport } = await runBatchStateExclusive(async () => {
    const prev = await getBlockState();
    const recorded = InmoBatch.recordBlock(prev, portal, signature, now);
    await setBlockState(recorded.state);
    const ent = recorded.state[portal];
    const claim = !!ent && ent.reported !== true && !reportInFlight.has(portal);
    if (claim) reportInFlight.add(portal);
    return { entry: ent, isNewEpisode: recorded.isNewEpisode, shouldReport: claim };
  });

  // Stop the run — do not grind on. SCOPED to this portal (issue #634 review
  // B4 "cross-portal collateral"): checkForBlock runs on every render,
  // including a manual tab on a DIFFERENT portal than whatever batch/auto
  // happens to be looping right now — an idealista challenge must never
  // pause an aliseda run. `batchState.portal` is null only for a
  // mixed/unrestricted Auto drain (no single portal to attribute a run to),
  // where pausing conservatively on ANY block remains the safer default.
  if (batchLooping) {
    const current = await getBatchState();
    if (!current || !current.portal || current.portal === portal) {
      // pauseForBlock, not pause (issue #692): also returns every in-flight
      // slot to `pending`. Those tabs are all staring at the same wall, and
      // leaving them inflight lets their capture-signal timeout mark them
      // `failed` — silently consuming pages the owner never saw. See
      // InmoBatch.pauseForBlock for the full argument.
      await mutateBatch(InmoBatch.pauseForBlock);
    }
  }

  if (!isNewEpisode) {
    // Already alerted for this episode (D-047 "once") — but if the very
    // first report attempt failed (network hiccup, dashboard down), retry it
    // here on every later detection while it's still active/unreported AND
    // no other concurrent detection already claimed the retry (shouldReport).
    // Never a second local notification.
    if (shouldReport) {
      await tryReportBlockEpisode(portal, entry.signature, entry.detectedAt);
    }
    return;
  }

  notifyBlocked(portal, entry.signature);
  if (shouldReport) {
    await tryReportBlockEpisode(portal, entry.signature, entry.detectedAt);
  }
}

/**
 * POST the episode to the dashboard and, only on success, mark it reported
 * (InmoBatch.markBlockReported) so a later retry doesn't resend a delivered
 * report. Best-effort — a failure here must never surface to the caller; the
 * pause + local notification already happened regardless.
 */
async function tryReportBlockEpisode(portal, signature, detectedAt) {
  try {
    await reportBlockEpisode(portal, signature, detectedAt);
    await runBatchStateExclusive(async () => {
      const state = await getBlockState();
      await setBlockState(InmoBatch.markBlockReported(state, portal));
    });
  } catch {
    /* best-effort — the next detection (while this episode is still
       active) retries the report */
  } finally {
    // Release the claim regardless of outcome — a failure must be retryable
    // by the NEXT detection, and a success already flipped `reported` above
    // so no later caller will even attempt to claim it again.
    reportInFlight.delete(portal);
  }
}

/**
 * A real capture just succeeded for `portal` — the operator went and fixed
 * whatever was challenging it (or it was transient). Resolve the episode so
 * the NEXT challenge (if any) is treated as a fresh one and alerts again.
 */
async function clearBlockIfActive(portal) {
  if (typeof portal !== 'string' || !portal) return;
  const prev = await getBlockState();
  const { state, wasActive } = InmoBatch.clearBlock(prev, portal);
  if (wasActive) await setBlockState(state);
}

/**
 * chrome.notifications (issue #634) — the one channel that reaches the owner
 * when the browser is unattended on another desktop. Needs the `notifications`
 * permission (manifest.json). A unique id per call means Chrome never
 * silently coalesces/overwrites a still-visible notification, but the "one
 * alert per episode" guarantee itself comes from the isNewEpisode gate in
 * handleBlockDetected, not from this id.
 */
function notifyBlocked(portal, signature) {
  try {
    if (!chrome.notifications || typeof chrome.notifications.create !== 'function') return;
    chrome.notifications.create(`inmo-block-${portal}-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'Inmo-Tool: captura bloqueada',
      message:
        `${portal} está mostrando un reto/bloqueo (${signature}). ` +
        'La captura se ha pausado — resuélvelo en el navegador y pulsa Reanudar.',
      priority: 2,
    });
  } catch {
    /* notifications best-effort — the pause + dashboard report still happened */
  }
}

/**
 * Clicking a block-episode notification opens /etl/salud (issue #634 review
 * "no onClicked handler — clicking the alert does nothing") so the operator
 * lands straight on the "resuelve el reto" section instead of a dead end.
 * Guarded like every other chrome.notifications use — a stub/test
 * environment without the API is a silent no-op, not a crash.
 */
if (typeof chrome !== 'undefined' && chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    if (typeof notificationId !== 'string' || !notificationId.startsWith('inmo-block-')) return;
    (async () => {
      try {
        const { apiUrl } = await getApiConfig();
        await chrome.tabs.create({ url: `${apiUrl}/etl/salud` });
      } catch {
        /* best-effort — the notification itself already delivered the alert */
      }
      try {
        chrome.notifications.clear(notificationId);
      } catch {
        /* best-effort */
      }
    })();
  });
}

/**
 * Report a NEW block episode to the dashboard (issue #634) so /etl/salud
 * shows it without the browser open — which portal, when, and a SIGNATURE of
 * what was detected (the marker id, e.g. 'captcha_wall'), never page content.
 * Fire-and-forget, mirrors sendHeartbeat's pattern exactly (best-effort,
 * skipped when no API key is configured yet).
 */
async function reportBlockEpisode(portal, signature, detectedAt) {
  const { apiUrl, apiKey } = await getApiConfig();
  if (!apiKey) return; // not configured yet — nothing to report
  const response = await fetch(`${apiUrl}/api/extension/block-episode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
    body: JSON.stringify({
      portal,
      signature,
      detectedAt: new Date(detectedAt).toISOString(),
    }),
  });
  // Without this check tryReportBlockEpisode's retry-on-failure never fires:
  // a non-2xx response (dashboard down, 401, 500) would still be treated as
  // "delivered" and markBlockReported would silence every future retry.
  if (!response.ok) throw new Error(`block-episode report: ${response.status}`);
}

// Serialize every get-modify-set of the shared batch state (BATCH_KEY). With
// bounded concurrency (#318) two driveOnePage calls (or a launch racing a
// settle) can interleave their read → modify → write on chrome.storage.session
// and lost-update a slot flip — one write clobbers the other, momentarily
// reverting a `captured` slot to `inflight`. This in-memory async mutex makes
// each read-modify-write atomic so no update is lost (issue #321). It does NOT
// change the concurrency level or the jittered pacing.
const runBatchStateExclusive = InmoBatch.makeSerializer();

/**
 * Atomic read-modify-write of the shared batch state: read the persisted state,
 * apply `fn`, persist the result — all inside the serializer so concurrent
 * callers run strictly one-at-a-time. Returns the new state.
 */
function updateBatchState(fn) {
  return runBatchStateExclusive(async () => {
    const state = await getBatchState();
    const next = fn(state);
    await setBatchState(next);
    return next;
  });
}

/**
 * Persist / read / clear the set of currently-open batch tab ids (eviction
 * recovery). Persisted as a plain array; `persistBatchTabs` snapshots the live
 * `batchTabIds` set each time it changes.
 */
async function persistBatchTabs() {
  await chrome.storage.session.set({ [BATCH_TABS_KEY]: [...batchTabIds] });
}
async function readBatchTabs() {
  const o = await chrome.storage.session.get(BATCH_TABS_KEY);
  const ids = o[BATCH_TABS_KEY];
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'number') : [];
}
async function clearBatchTabs() {
  await chrome.storage.session.remove(BATCH_TABS_KEY);
}

/** Seed harvested detail URLs into the worklist (added_via='derived'). */
async function seedWorklist(urls) {
  const { apiUrl, apiKey } = await getApiConfig();
  const response = await fetch(`${apiUrl}/api/etl/worklist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
    body: JSON.stringify({ urls, via: 'derived' }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `worklist seed: ${response.status}`);
  }
  return response.json();
}

/** The portal's still-`pending` worklist URLs, in list order. */
async function fetchPendingUrls(portal) {
  const { apiUrl, apiKey } = await getApiConfig();
  const response = await fetch(
    `${apiUrl}/api/etl/worklist?portal=${encodeURIComponent(portal)}`,
    { headers: { 'x-admin-key': apiKey } },
  );
  if (!response.ok) throw new Error(`worklist list: ${response.status}`);
  const data = await response.json();
  return (data.rows || [])
    .filter((r) => r.status === 'pending')
    .map((r) => r.url);
}

/**
 * A portal's guided-capture progress for the popup (issue #237): total /
 * captured / pending counts and the FIRST still-pending URL (the "open next"
 * target). Reuses the same GET /api/etl/worklist[?portal=] the dashboard
 * worklist page uses — no new backend surface. Never captures; purely reads.
 */
async function fetchWorklistProgress(portal) {
  const { apiUrl, apiKey } = await getApiConfig();
  const response = await fetch(
    `${apiUrl}/api/etl/worklist?portal=${encodeURIComponent(portal)}`,
    { headers: { 'x-admin-key': apiKey } },
  );
  if (!response.ok) throw new Error(`worklist progress: ${response.status}`);
  const data = await response.json();
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const pending = rows.filter((r) => r.status === 'pending').map((r) => r.url);
  const summary = Array.isArray(data.summaries)
    ? data.summaries.find((s) => s.source_portal === portal)
    : null;
  return {
    portal,
    total: summary ? summary.total : rows.length,
    captured: summary
      ? summary.captured
      : rows.filter((r) => r.status === 'captured').length,
    pending: pending.length,
    nextUrl: pending.length > 0 ? pending[0] : null,
  };
}

/**
 * Learn the search-results page's OWN URL as a capture-to-infer example
 * (issue #293). Fire-and-forget: a failure here must never block the batch —
 * saving the URL grammar is a side-benefit of mining, not a precondition.
 */
async function saveSearchUrlExample(searchUrl, resultCount) {
  if (!searchUrl) return;
  try {
    const { apiUrl, apiKey } = await getApiConfig();
    // Issue #376: on the end-of-enumeration call we carry `resultCount` — the
    // real harvested count enumerateResultsPages() computed (`seen.size`),
    // which used to be discarded — so the zero-results regression monitor has
    // the extension-path count keyed by (portal, search URL). Omitted on the
    // batch-start call (no count yet); the server COALESCEs so the countless
    // start save never wipes a later real count.
    const body = { url: searchUrl };
    if (typeof resultCount === 'number' && Number.isFinite(resultCount)) {
      body.resultCount = resultCount;
    }
    await fetch(`${apiUrl}/api/extension/search-url-example`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort: never let a learned-example save disrupt the capture run */
  }
}

/**
 * Persist a captured Idealista search URL (issue #475, part of #471). Unlike
 * saveSearchUrlExample (fire-and-forget, best-effort mining), this is an
 * explicit owner action, so it DOES report success/failure back to the popup so
 * it can show "URL capturada ✓" or a real error. Re-validates the payload
 * through the same pure helper the popup used (never trust a malformed message)
 * and posts it to the admin-gated endpoint; the server re-derives + re-validates
 * the portal from the URL host.
 */
async function postCapturedSearchUrl(payload) {
  const capture = self.InmoSearchUrl.buildSearchUrlCapture(payload || {});
  if (!capture) {
    return { success: false, error: { message: 'La pestaña activa no es una URL de un portal soportado.' } };
  }
  const { apiUrl, apiKey } = await getApiConfig();
  const response = await fetch(`${apiUrl}/api/captured-search-urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
    body: JSON.stringify({
      url: capture.url,
      title: capture.title,
      capturedAt: capture.capturedAt,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success !== true) {
    const message =
      (body && (body.error?.message || body.error)) || `HTTP ${response.status}`;
    return { success: false, error: { message } };
  }
  return { success: true, id: body.id, portal: body.portal };
}

// ═══ Passive search-URL observation (issue #488, part of #471) ══════════════
//
// As the owner browses Idealista search/results pages, the content script
// forwards each one it sees (OBSERVE_SEARCH_URL). To avoid re-sending the same
// search over and over within a browsing session, the worker keeps a SET of the
// normalised URLs it has already forwarded in chrome.storage.session — which
// survives the MV3 worker being torn down + respawned but resets when the
// browser session ends (so a genuinely-new session re-observes, and the server
// UPSERT bumps the seen count). The server ALSO de-dups (UPSERT by norm_key), so
// this session set is purely a network-traffic optimisation.
const OBSERVED_URLS_KEY = 'inmoObservedUrls';
// Cap the session set so a marathon session can't grow it without bound; oldest
// entries drop first (they're the least likely to be revisited).
const OBSERVED_URLS_CAP = 2000;

/** The set of normalised URLs already forwarded this session (plain array). */
async function readObservedKeys() {
  const o = await chrome.storage.session.get(OBSERVED_URLS_KEY);
  const arr = o[OBSERVED_URLS_KEY];
  return Array.isArray(arr) ? arr : [];
}

/** Record `key` as observed this session (bounded, oldest-first eviction). */
async function markObservedKey(key) {
  const arr = await readObservedKeys();
  if (arr.includes(key)) return;
  arr.push(key);
  if (arr.length > OBSERVED_URLS_CAP) arr.splice(0, arr.length - OBSERVED_URLS_CAP);
  await chrome.storage.session.set({ [OBSERVED_URLS_KEY]: arr });
}

/**
 * Forward a passively-observed Idealista search URL to the dashboard (issue
 * #488). Re-validates + normalises the payload through the shared pure helper
 * (never trust a malformed message), DE-DUPS against the per-session set, and —
 * when new — POSTs it to the admin-gated endpoint. Returns `{ success, deduped }`
 * so the content script can no-op quietly; a failure is non-fatal (observation
 * is passive). The server re-derives the portal + de-dup key from the URL.
 */
async function postObservedSearchUrl(payload) {
  const capture = self.InmoObserve.buildObservedCapture(payload || {});
  if (!capture) {
    return { success: false, error: { message: 'No es una URL de búsqueda observable de un portal soportado.' } };
  }
  const key = self.InmoObserve.normalizeObservedUrl(capture.url);
  if (!key) {
    return { success: false, error: { message: 'No se pudo normalizar la URL observada.' } };
  }
  const seen = await readObservedKeys();
  if (seen.includes(key)) {
    return { success: true, deduped: true };
  }
  // Mark BEFORE the POST so two rapid observations of the same search (e.g. a
  // MutationObserver double-fire) don't both hit the network.
  await markObservedKey(key);

  const { apiUrl, apiKey } = await getApiConfig();
  const response = await fetch(`${apiUrl}/api/observed-search-urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
    body: JSON.stringify({
      url: capture.url,
      title: capture.title,
      observedAt: capture.capturedAt,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success !== true) {
    const message =
      (body && (body.error?.message || body.error)) || `HTTP ${response.status}`;
    return { success: false, error: { message } };
  }
  return { success: true, id: body.id, seen_count: body.seen_count };
}

// ═══ Validation mode (issue #478 P3) ════════════════════════════════════════
//
// The "Validar filtros" page opens a portal search URL with `#inmo-validate=`
// so the owner can tune the search WITHOUT the extension capturing anything.
// The fragment is stripped off the visible URL on load (content-script), so the
// suppression can't ride on the URL alone once the owner navigates in-portal —
// it rides on this PER-TAB session map (tabId → { profileId, connector }),
// mirroring BATCH_TABS_KEY. Cleared when the tab closes or the owner clicks
// "Salir del modo validación".
const VALIDATION_TABS_KEY = 'inmoValidationTabs';

/** The whole tabId → { profileId, connector } map (plain object in session). */
async function getValidationTabsMap() {
  const o = await chrome.storage.session.get(VALIDATION_TABS_KEY);
  const map = o[VALIDATION_TABS_KEY];
  return map && typeof map === 'object' ? map : {};
}
async function setValidationTabsMap(map) {
  await chrome.storage.session.set({ [VALIDATION_TABS_KEY]: map });
}

/** Remember `tabId` as validating (profileId × connector). */
async function startValidation(tabId, profileId, connector) {
  if (tabId == null || !(profileId > 0) || !connector) return { ok: false };
  const map = await getValidationTabsMap();
  map[tabId] = { profileId, connector };
  await setValidationTabsMap(map);
  return { ok: true, profileId, connector };
}

/** The validation state for `tabId`: { active, profileId?, connector? }. */
async function getValidationState(tabId) {
  if (tabId == null) return { active: false };
  const map = await getValidationTabsMap();
  const s = map[tabId];
  return s
    ? { active: true, profileId: s.profileId, connector: s.connector }
    : { active: false };
}

/** Forget `tabId`'s validation state (tab closed / owner exited). */
async function endValidation(tabId) {
  if (tabId == null) return { ok: false };
  const map = await getValidationTabsMap();
  if (Object.prototype.hasOwnProperty.call(map, tabId)) {
    delete map[tabId];
    await setValidationTabsMap(map);
  }
  return { ok: true };
}

/**
 * Pin the tab's current URL as the (profile × connector) filter (issue #478 P3).
 * The profile id + connector come from the tab's VALIDATION STATE (never the
 * untrusted message); the URL is signal-stripped and validated by the shared
 * pure helper (self.InmoDetect.buildValidationSavePayload). PUTs through the
 * admin-key channel — the key only lives here — and the server re-derives +
 * re-validates the portal from the host.
 */
async function saveValidationUrl(tabId, url) {
  const state = await getValidationState(tabId);
  if (!state.active) {
    return { success: false, error: { message: 'Esta pestaña no está en modo validación.' } };
  }
  const payload = self.InmoDetect.buildValidationSavePayload(
    { profileId: state.profileId, connector: state.connector },
    url,
  );
  if (!payload) {
    return { success: false, error: { message: 'La URL de la pestaña no es válida para fijarla.' } };
  }
  const { apiUrl, apiKey } = await getApiConfig();
  const response = await fetch(
    `${apiUrl}/api/profiles/${payload.profileId}/connector-filters`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
      body: JSON.stringify({
        connector: payload.connector,
        url: payload.url,
        source: payload.source,
      }),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success !== true) {
    const message =
      (body && (body.error?.message || body.error)) || `HTTP ${response.status}`;
    return { success: false, error: { message } };
  }
  return { success: true, connector: payload.connector, profileId: payload.profileId };
}

// A closed tab can't be validating — drop its state (mirrors the batch tab
// reconciliation). Best-effort; failures are ignored.
chrome.tabs.onRemoved.addListener((tabId) => {
  endValidation(tabId).catch(() => {
    /* session state cleanup is best-effort */
  });
});

/**
 * POST a discovered filter catalog to the ingest route (issue #336). Unlike
 * the fire-and-forget example save, this DOES report its outcome back to the
 * content script (so the operator sees a success/failure toast) — but it never
 * throws past the caller's `.catch`. `payload` is the body discover.js built
 * (pageUrl + source + capturedAt + axes); the server derives the connector from
 * pageUrl's host and validates the shape.
 */
async function postFilterCatalog(payload) {
  const { apiUrl, apiKey } = await getApiConfig();
  const response = await fetch(`${apiUrl}/api/extension/filter-catalog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || !body.success) {
    return { success: false, error: { message: (body && body.error) || `HTTP ${response.status}` } };
  }
  return {
    success: true,
    stored: !!body.stored,
    connector: body.connector,
    optionsCount: body.options_count || 0,
    axesCount: body.axes_count || 0,
  };
}

/**
 * Begin a batch run for one portal (issue #262, pagination #362). Seeds the
 * harvested page-1 URLs, then ENUMERATES the remaining results pages (rendered,
 * in-session — see enumerateResultsPages) seeding each page's detail URLs as it
 * discovers them, and finally builds+runs the capture queue from the portal's
 * pending set. Enumeration runs async so the popup stays responsive and the
 * discovered count grows as pages arrive; startBatch returns immediately with
 * `enumerating: true`.
 *
 * Queueing (issue #554): if a run is ALREADY active (enumerating or
 * capturing, `isBatchActive()`), this search is queued instead of clobbering
 * the live run's state — the bug this issue fixes. The active-check and the
 * "claim the run" transition (entering the enumerating phase) happen inside
 * ONE critical section (`runBatchStateExclusive`) so two START_BATCH calls
 * racing each other can never both decide "nothing's running" and both
 * clobber BATCH_ENUM_KEY — that race was the original clobbering bug, just
 * one message-timing away from a second click.
 *
 * `queue` (issue #556, optional — `{portal, searchUrl}[]`) is the REST of the
 * dashboard's "Capturar todo" ticked tasks, piggybacked onto this one search's
 * URL because the dashboard can only ever hand off ONE tab (see
 * dashboard/lib/extension-capture.ts). Each entry is appended to the SAME
 * #555/D-112 pending-search queue, in order, behind this search — whether
 * THIS search claims the run or is itself queued. `urls` is always `[]` for
 * these (the dashboard never harvests a DOM it didn't open); that's fine —
 * `enumerateResultsPages` self-renders page 1 the same way it already renders
 * every OTHER results page (issue #554/#362), no dashboard tab required.
 */
async function startBatch({ portal, urls, searchUrl, queue: extraQueue }) {
  const page1 = Array.isArray(urls) ? urls : [];
  const extra = Array.isArray(extraQueue) ? extraQueue : [];
  const claim = await runBatchStateExclusive(async () => {
    let q = await getSearchQueue();
    if (await isBatchActive()) {
      q = InmoBatch.enqueueSearch(q, { portal, urls: page1, searchUrl });
      for (const e of extra) {
        q = InmoBatch.enqueueSearch(q, {
          portal: e && e.portal,
          urls: [],
          searchUrl: e && e.searchUrl,
        });
      }
      await setSearchQueue(q);
      return { claimed: false, queueDepth: q.length };
    }
    // Claim the run atomically: entering the enumerating phase HERE (inside
    // the lock) is what makes isBatchActive() report true for any concurrent
    // START_BATCH/advanceQueueIfIdle call that queues behind the exclusive
    // section. The rest of `extra` is enqueued behind THIS claimed search —
    // still inside the lock, so no interleaved START_BATCH can land between
    // this search and its own tail.
    if (extra.length > 0) {
      for (const e of extra) {
        q = InmoBatch.enqueueSearch(q, {
          portal: e && e.portal,
          urls: [],
          searchUrl: e && e.searchUrl,
        });
      }
      // issue #556 review N6: only write the queue back when `extra` actually
      // changed it — the overwhelmingly common case (a plain single-task
      // START_BATCH, no batch button involved) has nothing to add here, and
      // this claimed-run path already has its OWN storage write below
      // (setEnumState) — no need for a second, no-op chrome.storage.session
      // write on the hot path.
      await setSearchQueue(q);
    }
    await setEnumState({
      status: 'enumerating',
      portal,
      discovered: page1.length,
      page: 1,
    });
    return { claimed: true, queueDepth: q.length };
  });
  if (!claim.claimed) {
    // "en cola (N por delante)": the running search plus any earlier queued
    // ones — which is exactly queueDepth once this entry is the last in line.
    return {
      started: false,
      queued: true,
      queueDepth: claim.queueDepth,
      aheadCount: claim.queueDepth,
    };
  }
  return beginRun({ portal, urls: page1, searchUrl });
}

/**
 * Do the actual (non-blocking) work of a claimed run: learn the search URL,
 * seed page 1, then kick off enumerate→capture in the background. The caller
 * must have ALREADY persisted the 'enumerating' claim (issue #554) — this
 * never touches EnumState itself except via runEnumerationThenCapture's own
 * lifecycle, so it's safe to call from both startBatch's happy path and
 * advanceQueueIfIdle.
 *
 * issue #554 review N5: a `saveSearchUrlExample`/`seedWorklist` failure must
 * not strand the 'enumerating' claim we already persisted with nothing ever
 * driving it — swallow it and fall through to the walk regardless (it
 * re-seeds each page it harvests anyway); `runEnumerationThenCapture` below
 * is unconditionally reached and guarantees the claim always resolves into a
 * capture queue (or is explicitly dropped on failure), never left dangling.
 */
async function beginRun({ portal, urls, searchUrl }) {
  const page1 = Array.isArray(urls) ? urls : [];
  try {
    // Piggyback capture-to-infer: also learn this search page's URL grammar.
    await saveSearchUrlExample(searchUrl);
    if (page1.length > 0) {
      await seedWorklist(page1);
    }
  } catch {
    /* best-effort — see docstring; the claim is resolved below regardless */
  }
  // Fire-and-forget: runEnumerationThenCapture NEVER rejects (it catches
  // every failure internally and always resolves the 'enumerating' claim one
  // way or another), so there is no `.catch()` needed here.
  runEnumerationThenCapture(portal, searchUrl, page1);
  return { started: true, enumerating: true, total: page1.length };
}

/**
 * If nothing is currently running — no live loop, no in-progress
 * enumeration, no running/paused capture queue — and a search is waiting,
 * pop it and start it (issue #554). This is the ONE place that advances the
 * pending-search queue; it's called from:
 *   - runBatchLoop's own `finally` (natural completion advances promptly),
 *   - the watchdog tick / onStartup / onInstalled / every popup open
 *     (`reattachIfStranded`), which is what covers a worker eviction landing
 *     in the gap between "the run just finished" and "the queue got
 *     checked" — a queue that silently stalls after eviction would be worse
 *     than no queue at all, since the owner would believe work is
 *     progressing.
 * The check-and-claim (like startBatch) happens inside the exclusive section
 * so a watchdog tick racing a loop's own finally can't both pop an entry.
 * Best-effort: never throws past the caller — `beginRun` cannot reject
 * (issue #554 review N5), so a popped entry is never silently dropped.
 */
async function advanceQueueIfIdle() {
  const claim = await runBatchStateExclusive(async () => {
    if (await isBatchActive()) return null;
    const popped = InmoBatch.dequeueSearch(await getSearchQueue());
    if (!popped.entry) return null;
    await setSearchQueue(popped.queue);
    await setEnumState({
      status: 'enumerating',
      portal: popped.entry.portal,
      discovered: popped.entry.urls.length,
      page: 1,
    });
    return popped.entry;
  });
  if (!claim) return false;
  await beginRun(claim);
  return true;
}

/**
 * Enumerate every results page, then hand off to the capture queue.
 * `discoveredCount` (issue #554) — when known — is threaded to
 * runCaptureQueue so a same-portal drain (an earlier queued search already
 * captured everything this one found) reports cleanly instead of a bare 0/0;
 * absent it falls back to page1Urls.length (the enumeration-failed path,
 * where no further discovery happened).
 *
 * issue #554 review B1: `enumRunning` is held true for the ENTIRE handoff —
 * the page walk AND the capture-queue build (runCaptureQueue) — not just the
 * walk. Before this, `enumRunning` reset to false the instant the walk's own
 * loop exited, which is BEFORE runCaptureQueue's `fetchPendingUrls` network
 * call — the exact window `shouldRecoverStrandedEnumeration` could
 * misclassify as "stranded" and race a start/advance into. This function
 * NEVER rejects: any failure (enumeration itself, or building the capture
 * queue) is caught and resolved by explicitly dropping the claim, so the
 * 'enumerating' state can never dangle forever.
 */
async function runEnumerationThenCapture(portal, searchUrl, page1Urls) {
  enumRunning = true;
  try {
    let discoveredCount = page1Urls.length;
    try {
      await enumerateResultsPages(portal, searchUrl, page1Urls);
      const enumState = await getEnumState(); // read before the handoff clears it
      if (enumState && typeof enumState.discovered === 'number') {
        discoveredCount = enumState.discovered;
      }
    } catch {
      // Enumeration itself failed outright — still fall through below to
      // capture whatever was seeded (page 1 at minimum), never leaving the
      // claim wedged in the enumerating phase.
    }
    // Block detected during enumeration (issue #634): don't walk straight
    // into opening detail tabs against a portal that's already challenging
    // us. Represent whatever was already seeded into capture_worklist as a
    // PAUSED batch (same shape STOP/PAUSE_BATCH already produce) rather than
    // just dropping the claim — a bare cleared claim would read as "idle" to
    // isBatchActive()/advanceQueueIfIdle and silently pop the NEXT queued
    // search, which is exactly the "grind on" this issue exists to prevent.
    // A PAUSED state keeps isBatchActive() true (nothing advances) and gives
    // the popup a real "Reanudar" once the operator has gone and fixed it.
    if (await isPortalBlocked(portal)) {
      const pending = await fetchPendingUrls(portal).catch(() => []);
      const { concurrency } = await getBatchConfig();
      const paused = InmoBatch.pause(
        InmoBatch.makeBatchState(pending, concurrency, undefined, portal),
      );
      await runBatchStateExclusive(async () => {
        await clearEnumState();
        await setBatchState(paused);
      });
      return;
    }
    try {
      await runCaptureQueue(portal, discoveredCount);
    } catch {
      // Building the capture queue failed (network/storage) — the claim
      // must not dangle either (issue #554 review N5): drop it explicitly
      // so isBatchActive() frees up, then let the pending-search queue
      // advance promptly rather than waiting for the next watchdog tick.
      await clearEnumState().catch(() => {});
      await advanceQueueIfIdle().catch(() => {});
    }
  } finally {
    enumRunning = false;
  }
}

/**
 * Build the capture queue from the portal's pending set and fire the loop.
 * `discoveredCount` (issue #554, optional) is how many detail URLs THIS
 * search found (page 1 + enumeration) — used to classify an empty result as
 * "already captured by an earlier same-portal search" vs. "no results",
 * instead of a bare 0/0 (see InmoBatch.classifyEmptyCapture).
 *
 * ATOMIC handoff (issue #554 review B1). The network calls below
 * (`fetchPendingUrls`/`getBatchConfig`) happen OUTSIDE any lock, but the
 * caller is required to leave the 'enumerating' claim (BATCH_ENUM_KEY)
 * PERSISTED until this function clears it — so `isBatchActive()` reads true
 * for the network call's entire duration, no matter how long it takes. Once
 * the new capture state is ready, `clearEnumState` + `setBatchState` +
 * kicking off `runBatchLoop` all happen inside ONE `runBatchStateExclusive`
 * critical section, so no concurrent `startBatch`/`advanceQueueIfIdle` call
 * can ever observe every claim signal idle at once (the original clobbering
 * bug: a second search claiming the run mid-handoff, then overwriting the
 * first search's state when ITS OWN handoff completes). `runBatchLoop()` is
 * invoked from INSIDE the critical section (not awaited — the loop itself
 * can run for minutes — but CALLING it synchronously flips the in-memory
 * `batchLooping` guard before the lock releases), so even a same-worker
 * caller queued right behind this one sees a fully-committed state.
 *
 * Returns the `runBatchLoop()` promise so a caller that needs to know when
 * the capture actually drains (the Auto harvest path) can await it; the
 * manual path intentionally does not (fire-and-forget — "click once").
 */
async function runCaptureQueue(portal, discoveredCount) {
  const pending = await fetchPendingUrls(portal);
  // Concurrency comes from the operator's config (clamped), issue #410.
  const { concurrency } = await getBatchConfig();
  const emptyReason = InmoBatch.classifyEmptyCapture(
    pending.length,
    discoveredCount,
  );
  const state = InmoBatch.makeBatchState(pending, concurrency, emptyReason, portal);
  let loopPromise;
  await runBatchStateExclusive(async () => {
    await clearEnumState();
    await setBatchState(state);
    loopPromise = runBatchLoop();
  });
  return loopPromise;
}

/**
 * Wait for tab `tabId` to finish loading (status 'complete'), or time out.
 * Resolves true on load, false on timeout. The listener is attached by the
 * caller BEFORE it navigates, so a fast 'complete' is never missed.
 */
function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch {
        /* listener already gone */
      }
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/** Ask the content script on `tabId` to harvest the rendered results page. */
async function sendHarvestMessage(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'HARVEST_LISTING_PAGE' });
  } catch {
    // Content script not injected yet — inject and retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['detect.js', 'discover.js', 'content-script.js'],
      });
      return await chrome.tabs.sendMessage(tabId, { type: 'HARVEST_LISTING_PAGE' });
    } catch {
      return null;
    }
  }
}

/**
 * Render `url` in the (reused) enumeration tab — ACTIVE so Chrome doesn't
 * throttle the render, the same reason capture activates its tabs (D-043) —
 * wait for the load, then ask its content script for the rendered detail URLs +
 * the next-page URL. Returns `{ tabId, result }`; `result` is null when the tab
 * couldn't be opened/navigated or harvest failed. Reuses one tab across pages.
 */
async function renderAndHarvest(url, existingTabId) {
  let tabId = existingTabId;
  if (tabId == null) {
    try {
      const tab = await chrome.tabs.create({ url, active: true });
      tabId = tab.id;
    } catch {
      return { tabId: null, result: null };
    }
    batchTabIds.add(tabId);
    await persistBatchTabs();
    if (!(await waitTabComplete(tabId, BATCH_CAPTURE_TIMEOUT_MS))) {
      return { tabId, result: null };
    }
  } else {
    // Attach the load waiter BEFORE navigating so the 'complete' isn't missed.
    const loaded = waitTabComplete(tabId, BATCH_CAPTURE_TIMEOUT_MS);
    try {
      await chrome.tabs.update(tabId, { url, active: true });
    } catch {
      return { tabId, result: null };
    }
    if (!(await loaded)) return { tabId, result: null };
  }
  let result = null;
  try {
    result = await sendHarvestMessage(tabId);
  } catch {
    result = null;
  }
  return { tabId, result };
}

/**
 * Walk every results page of a search, seeding each page's detail URLs into the
 * worklist as it goes (issue #362). Reuses ONE rendered tab, navigated page to
 * page in the authenticated session — the only reliable enumeration for a
 * client-side-rendered portal (Aliseda) or a WAF-gated one (Idealista /
 * Altamira), where a background fetch returns an empty shell / a 403. Each page
 * is paced by the same jittered dwell capture uses, so the walk never hammers
 * the portal.
 *
 * Stops when: a page beyond the first yields NO new detail URLs, the next-page
 * URL is absent (last page / no numbered pagination), RESULTS_PAGE_CAP pages
 * were walked, or the run was stopped. Page 1's URLs were already seeded by
 * startBatch and pre-seed the de-dup set, so page 1 is re-rendered only to read
 * its "next page" anchor reliably.
 */
async function enumerateResultsPages(portal, searchUrl, page1Urls) {
  if (!searchUrl) return;
  // `enumRunning` (issue #516, widened for #554 review B1) is set by the
  // CALLER around the whole enum→capture handoff, not just this page walk —
  // see runEnumerationThenCapture / runAutoHarvest.
  const D = self.InmoDetect;
  const seen = new Set(
    (page1Urls || []).map((u) => D.matchKey(u)).filter(Boolean),
  );
  // Normalise a map-view search to its listing (card) view BEFORE rendering
  // (issue #506): the map page shows pins, not detail anchors, so harvesting it
  // yields nothing and pagination breaks (`/mapa-google/pagina-2.htm`). No-op
  // for URLs that are already a listing path or for other portals. The pinned
  // searchUrl is still stored/decoded verbatim elsewhere (D-101).
  let current = D.toListingUrl(D.stripCaptureSignal(searchUrl));
  let tabId = null;
  try {
    for (let page = 1; page <= D.RESULTS_PAGE_CAP; page++) {
      if (await enumerationStopped(portal)) break;
      const rendered = await renderAndHarvest(current, tabId);
      tabId = rendered.tabId;
      if (tabId != null && !batchTabIds.has(tabId)) {
        batchTabIds.add(tabId);
        await persistBatchTabs();
      }
      if (!rendered.result) break; // couldn't render/harvest — stop the walk

      const detailUrls = Array.isArray(rendered.result.detailUrls)
        ? rendered.result.detailUrls
        : [];
      const fresh = [];
      for (const u of detailUrls) {
        const k = D.matchKey(u);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        fresh.push(u);
      }
      if (fresh.length > 0) {
        await seedWorklist(fresh).catch(() => {
          /* a page's seed failing must not abort the whole walk */
        });
      }
      await setEnumState({
        status: 'enumerating',
        portal,
        discovered: seen.size,
        page,
      });

      // Stop: a page past the first that added nothing new (end of results, or
      // a portal that renders no navigable pagination — same page re-served).
      if (page > 1 && fresh.length === 0) break;

      // Advance: the rendered DOM's next-page URL (content script already
      // prefers the clean URL scheme, then the "siguiente" anchor), with the
      // clean scheme as a final backstop.
      const next = rendered.result.nextUrl || D.resultsPageUrl(current, page + 1);
      if (!next) break;
      // Didn't-advance guard. Compare the results-PAGE NUMBER, not matchKey:
      // matchKey drops the query string, so for the query-param portals
      // (aliseda/altamira `?pagina=N`) matchKey(next) === matchKey(current)
      // ALWAYS — the page number lives in the query — which would falsely stop
      // the walk after page 1 on the very portal (Aliseda) this fix targets.
      // currentResultsPage reads the page number under every scheme (path or
      // query), so this both advances query portals and still catches a stall
      // (next resolves to the same or an earlier page → break).
      if (D.currentResultsPage(next) <= D.currentResultsPage(current)) break;
      current = next;

      // Polite pacing between results-page loads (mirror the capture jitter).
      // Enumeration is a single reused tab, so it keeps the default pace rather
      // than the operator's capture-concurrency dials.
      await sleep(
        InmoBatch.jitterDelay(
          InmoBatch.paceBaseMs(page - 1, BATCH_PACE_BASE_MS),
          BATCH_PACE_SPREAD_MS,
        ),
      );
    }
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* tab already gone */
      }
      batchTabIds.delete(tabId);
      await persistBatchTabs();
    }
    // Issue #376: persist the REAL harvested count (`seen.size`) for this
    // (portal, search URL) — the count #362 already computed but discarded.
    // Best-effort and keyed by the same search URL the batch-start save used,
    // so the zero-results regression monitor gets the extension-path signal.
    await saveSearchUrlExample(D.stripCaptureSignal(searchUrl), seen.size);
  }
}

/** Apply a pure state transition (pause/resume) and return fresh progress. */
async function mutateBatch(fn) {
  const next = await updateBatchState(fn);
  return InmoBatch.progress(next);
}

/**
 * Stop the run: mark done, unblock every in-flight wait, close all open tabs.
 * Also DRAINS the pending-search queue (issue #554) — "Detener" is the
 * operator's full-stop control, so it cancels everything fired off, not just
 * the one currently running; use "Quitar" on an individual queued search (or
 * just don't queue it) to cancel only that one without touching a live run.
 */
async function stopBatch() {
  // Clear the enumeration claim, drain the pending-search queue, and stop the
  // capture state — all inside ONE critical section (issue #554 hardening
  // alongside review B1) so a concurrent startBatch/advanceQueueIfIdle claim
  // can never land mid-Detener and get silently wiped a moment later.
  const next = await runBatchStateExclusive(async () => {
    // Clearing the enumeration state signals any in-progress results-page
    // walk to bail on its next iteration (issue #362); its reused tab is in
    // batchTabIds (and persisted), so the tab close below reaps it.
    await clearEnumState();
    await setSearchQueue(InmoBatch.clearSearchQueue());
    const state = await getBatchState();
    const stopped = InmoBatch.stop(state);
    await setBatchState(stopped);
    return stopped;
  });
  // Unblock every outstanding wait (each resolves false → recorded as failed,
  // but recordResultAt ignores a DONE queue, so counts stay put).
  for (const finish of batchWaiters.values()) finish(false);
  // Close every open tab — the in-memory set on the fast path, plus any
  // persisted ids in case a respawned worker is stopping a run it didn't start.
  const ids = new Set([...batchTabIds, ...(await readBatchTabs())]);
  for (const id of ids) {
    try {
      await chrome.tabs.remove(id);
    } catch {
      /* tab already gone */
    }
  }
  batchTabIds.clear();
  await clearBatchTabs();
  return InmoBatch.progress(next);
}

/**
 * Wait for the given tab to signal AUTO_CAPTURE_DONE, or time out. Resolves
 * true on capture, false on timeout/stop. Registers a per-tab resolver so
 * several waits can be outstanding at once (bounded concurrency, issue #318).
 */
function waitForCaptureSignal(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      batchWaiters.delete(tabId);
      resolve(ok);
    };
    batchWaiters.set(tabId, finish);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Open one detail URL, wait for its capture, then close the tab.
 *
 * `backgroundTabs` (issue #410, opt-in, default false) decides focus:
 *   • false → `active:true`  — the SAFE default. The tab is focused, so Chrome
 *     never throttles its render and the content script's auto-capture fires
 *     reliably. The cost is that each launch steals the operator's focus.
 *   • true  → `active:false` — the tab opens UNFOCUSED (no focus theft). A new
 *     tab's initial load + render generally still happens, and Chrome throttles
 *     long-running background TIMERS rather than the first paint, so for
 *     fast-rendering portals this lifts real parallelism. It is opt-in because
 *     reliability on JS-heavy SPAs can't be guaranteed from the APIs alone — the
 *     operator enables it and watches the N/M captured ratio. See D-043.
 */
async function captureOnePage(url, backgroundTabs) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: !backgroundTabs });
  } catch {
    return false;
  }
  batchTabIds.add(tab.id);
  // Persist the open-tab set BEFORE the (up to 30 s) wait — that's exactly the
  // window in which Chrome may evict the worker, and a respawned one must be
  // able to find and close every open tab.
  await persistBatchTabs();
  const ok = await waitForCaptureSignal(tab.id, BATCH_CAPTURE_TIMEOUT_MS);
  try {
    await chrome.tabs.remove(tab.id);
  } catch {
    /* tab already closed */
  }
  batchTabIds.delete(tab.id);
  await persistBatchTabs();
  return ok;
}

/**
 * Drive ONE page end to end: open its tab (active or background per config),
 * wait for the capture (or timeout), close it, then record the outcome against
 * that exact slot. Settles
 * may land OUT OF ORDER across the concurrent tabs, so we address the slot by
 * `index` rather than a moving pointer. recordResultAt ignores a stopped queue
 * and flips to `done` only when nothing is left pending or in flight.
 */
async function driveOnePage(index, url, backgroundTabs) {
  const ok = await captureOnePage(url, backgroundTabs);
  // Atomic: two tabs settling in the same tick would otherwise interleave this
  // get-modify-set and lose one's slot flip (issue #321).
  await updateBatchState((state) => InmoBatch.recordResultAt(state, index, ok));
}

/**
 * The bounded-concurrency driver. Re-entrancy-guarded so PAUSE→RESUME (or a
 * duplicate START) never runs two loops. Keeps up to `state.concurrency` tabs in
 * flight (the operator-configured value, clamped — issue #410): it launches the
 * next pending URL, STAGGERS by a jittered delay (base+spread from config), and
 * tops the pool back up whenever a tab settles. Re-reads the persisted state
 * around every launch so a pause/stop takes effect promptly — in-flight pages
 * always finish cleanly (their tabs close in `captureOnePage`), we never orphan
 * a half-captured tab. The `finally` drains any still-open tabs so none leak
 * past the loop's exit (e.g. after a pause with tabs mid-capture).
 *
 * The pacing config (base/spread) and background-tab mode are read ONCE per
 * loop attach; a PAUSE/RESUME re-enters the loop and re-reads them, so a config
 * change takes effect on the next run without a mid-run surprise.
 */
async function runBatchLoop() {
  if (batchLooping) return;
  batchLooping = true;
  const inflight = new Map(); // index -> Promise (the driveOnePage in progress)
  try {
    // issue #554 review N6: getBatchConfig() (a chrome.storage.sync read) is
    // now INSIDE the try — it used to sit between `batchLooping = true` and
    // the try, so a rejection there (e.g. an evicted/invalidated extension
    // context) skipped the finally entirely and left `batchLooping` stuck
    // true forever, which makes isBatchActive() permanently report "active"
    // and wedges the pending-search queue with no recovery path at all.
    const cfg = await getBatchConfig();
    for (;;) {
      let state = await getBatchState();

      // Top the in-flight pool up to the cap, launching staggered by a jittered
      // pace. Each launch flips a slot to `inflight` and persists it first, so
      // an eviction mid-launch is recoverable.
      while (InmoBatch.isActive(state) && inflight.size < state.concurrency) {
        // Atomic launch: re-read, pick the next pending slot, flip it to
        // inflight, and persist — all inside the serializer so a concurrently
        // settling driveOnePage can't clobber the flip (issue #321). Re-reading
        // fresh here also means launchNext always sees the latest slots.
        const launch = await runBatchStateExclusive(async () => {
          const cur = await getBatchState();
          const next = InmoBatch.launchNext(cur);
          if (next.index !== -1) await setBatchState(next.state);
          return next;
        });
        if (launch.index === -1) break; // nothing pending / cap reached
        state = launch.state;
        const idx = launch.index;
        const p = driveOnePage(idx, launch.url, cfg.backgroundTabs).finally(() =>
          inflight.delete(idx),
        );
        inflight.set(idx, p);
        // Jittered stagger (WAF safety — never a simultaneous burst). BASE grows
        // with how many pages have settled so long sweeps space out; the
        // configured minimum base is preserved at the start (default 2s + spread
        // → [2s, 7s)). Base+spread are the operator's dials (issue #410). D-043.
        const done = InmoBatch.progress(state).done;
        await sleep(
          InmoBatch.jitterDelay(
            InmoBatch.paceBaseMs(done, cfg.paceBaseMs),
            cfg.paceSpreadMs,
          ),
        );
        state = await getBatchState(); // re-read for a pause/stop landing mid-stagger
      }

      // Nothing more to launch and nothing open → paused/stopped/done: exit and
      // let `finally` drain. Otherwise wait for at least one tab to settle, then
      // re-evaluate (a settle frees a concurrency slot).
      if (inflight.size === 0) break;
      await Promise.race(inflight.values());
    }
  } finally {
    // Ensure every open tab settles + closes before the loop exits, so a pause
    // (or an early break) never leaves a tab leaked.
    await Promise.allSettled(inflight.values());
    batchLooping = false;
    // issue #554: the loop just stopped driving (done, paused, or stopped) —
    // if that means a natural completion (not a pause), advanceQueueIfIdle's
    // own isBatchActive() check tells the difference and pops the next queued
    // search. Best-effort: never let a queue-advance failure escape the loop.
    try {
      await advanceQueueIfIdle();
    } catch {
      /* best-effort — the watchdog tick will retry */
    }
  }
}

// ── MV3 eviction recovery: watchdog re-attach ─────────────────────────────
//
// If the persisted queue is `running` but no in-memory loop is driving it (the
// worker was evicted and respawned), re-attach: close the tab orphaned at
// eviction time, then restart the driver from the persisted index. Idempotent
// and cheap — a no-op when the loop is already alive or the queue is
// paused/done, so it's safe to call from the alarm, onStartup/onInstalled, and
// every popup open.
// In-memory re-entrancy guard for reattachIfStranded itself (issue #554
// review N1/B1): the watchdog alarm, onStartup/onInstalled, and every popup
// open can all call this within the same worker close together. Without this
// guard, two overlapping calls could both read the same "nothing live yet"
// snapshot (stranded-enumeration / advance-queue checks) before either one's
// first `await` commits anything — a narrow window, but a real one now that
// this function can also POP the pending-search queue.
let reattaching = false;

async function reattachIfStranded() {
  if (batchLooping || reattaching) return; // loop alive, or already re-attaching
  reattaching = true;
  try {
    let state = await getBatchState();
    if (InmoBatch.shouldReattach(state, batchLooping)) {
      // Close every tab orphaned at eviction time (their ids were persisted).
      const persistedTabIds = await readBatchTabs();
      const orphans = InmoBatch.orphanTabsToClose(state, batchLooping, persistedTabIds);
      for (const id of orphans) {
        try {
          await chrome.tabs.remove(id);
        } catch {
          /* tab already gone */
        }
      }
      batchTabIds.clear();
      await clearBatchTabs();

      // Those in-flight slots referred to the tabs we just closed — reset
      // them to pending so the restarted driver re-launches them (capture is
      // idempotent).
      state = await updateBatchState((s) => InmoBatch.resetInflightToPending(s));
      runBatchLoop(); // resumes from the persisted slots; its own finally
      // will advance the pending-search queue (issue #554) once THIS run
      // completes.
      return;
    }

    // No stranded CAPTURE queue. A stranded manual ENUMERATION (issue #554,
    // generalizing #516's auto-only recoverStrandedHarvest below) is the
    // other way a run can die mid-flight without a loop to resume it: worker
    // evicted between results pages leaves BATCH_ENUM_KEY set with nothing
    // walking it, which would make isBatchActive() report "active" forever
    // and wedge both this run AND anything queued behind it. Recover it
    // exactly like any other enumeration failure (startBatch's own fallback)
    // — fall through to capturing whatever was already seeded.
    //
    // issue #554 review N1: EXCLUDE the case where Auto is mid-HARVEST — that
    // is `recoverStrandedHarvest`'s (autoTick's) job, which does the
    // additional auto-specific work (recording the task run so staleness
    // advances, then cooling down) this generic path knows nothing about. Two
    // independent recoveries racing for the SAME stranded enum state — one
    // generic, one auto-aware — is exactly the kind of double-action this
    // guard exists to prevent; deferring to the auto-aware one here keeps the
    // generalization honest rather than merely "usually fine".
    const enumState = await getEnumState();
    const batchActive = InmoBatch.isActive(await getBatchState());
    const auto = await getAutoState();
    const autoHarvesting =
      !!auto && auto.enabled === true && auto.status === InmoBatch.AUTO_STATUS.HARVESTING;
    if (
      !autoHarvesting &&
      InmoBatch.shouldRecoverStrandedEnumeration(
        enumState != null,
        enumRunning,
        batchLooping,
        batchActive,
      )
    ) {
      // Claim the recovery in-memory BEFORE any further await, mirroring
      // runEnumerationThenCapture's own contract (issue #554 review B1): the
      // enum claim stays PERSISTED (not cleared here) until runCaptureQueue's
      // atomic handoff clears it, so isBatchActive() reads true for the
      // whole recovery, and `enumRunning` stops a second concurrent
      // recovery attempt from double-acting on the same stranded state.
      enumRunning = true;
      try {
        const persistedTabIds = await readBatchTabs();
        for (const id of persistedTabIds) {
          try {
            await chrome.tabs.remove(id);
          } catch {
            /* tab already gone */
          }
        }
        batchTabIds.clear();
        await clearBatchTabs();
        const discovered =
          typeof enumState.discovered === 'number' ? enumState.discovered : 0;
        const portal = enumState.portal;
        if (portal) {
          await runCaptureQueue(portal, discovered); // atomically clears the enum claim
        } else {
          // Defensive: an enum state with no portal can't be recovered into a
          // capture queue — just drop the dangling claim.
          await clearEnumState();
        }
      } finally {
        enumRunning = false;
      }
      return; // that run's own completion will advance the queue in turn
    }

    // Nothing at all is running. A queued search may still be waiting to
    // start — e.g. the worker died in the exact gap between "the run just
    // finished" and "advanceQueueIfIdle got to run" (issue #554).
    // Best-effort, no-op when something IS active or the queue is empty.
    await advanceQueueIfIdle().catch(() => {
      /* best-effort — the next watchdog tick retries */
    });
  } finally {
    reattaching = false;
  }
}

// Arm the watchdog alarm (idempotent) and try an immediate re-attach. Runs on
// every worker spawn (top-level) and on the explicit lifecycle events.
function ensureBatchWatchdog() {
  try {
    chrome.alarms.create(BATCH_ALARM, { periodInMinutes: BATCH_ALARM_PERIOD_MIN });
  } catch {
    /* alarms unavailable — popup-open recovery still works */
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // The periodic watchdog both re-attaches a stranded batch AND ticks the auto
  // driver (its eviction-safe net); the one-shot AUTO_ALARM ticks it promptly
  // after the inter-batch cooldown. Both funnel into the same idempotent tick.
  if (alarm.name === BATCH_ALARM) {
    reattachIfStranded();
    autoTick();
    // Piggyback the presence heartbeat on the ~30s watchdog tick (#509).
    sendHeartbeat();
  }
  if (alarm.name === AUTO_ALARM) autoTick();
});
chrome.runtime.onStartup.addListener(() => {
  ensureBatchWatchdog();
  reattachIfStranded();
  autoTick();
  sendHeartbeat();
});
chrome.runtime.onInstalled.addListener(() => {
  ensureBatchWatchdog();
  reattachIfStranded();
  autoTick();
  sendHeartbeat();
});
// Top-level: fires whenever the worker (re)spawns, including after an eviction
// that no lifecycle event covers. The auto driver's top-level tick is at the end
// of the auto block below (its state consts must be initialised first).
ensureBatchWatchdog();
reattachIfStranded();
// Announce presence to the dashboard on every worker (re)spawn (#509).
sendHeartbeat();

// ═══ Auto-capture continuous driver (issue #424; v2 discover→harvest #516) ═══
//
// Auto mode leaves the capture page open and, without the operator clicking per
// batch, drives the FULL discovery → harvest → capture loop. v1 only drained the
// already-known worklist (GET /api/etl/worklist?pending=1), so a due connector
// with an empty pending set made auto idle and NEW listings were never found. v2
// asks the server for the ONE next unit each cooldown:
//   1. GET /api/etl/auto-plan[?portal=][&force=1] → runAutoBatch dispatches it:
//        • harvest — open the most-DUE profile×connector search task, ENUMERATE
//          every results page, SEED the discovered detail URLs, CAPTURE them
//          (reusing the exact enumerate+capture machinery the manual "Capturar
//          todas" flow uses), then POST the task run so staleness advances
//          (else the task stays due and auto re-harvests it forever),
//        • drain — no due task, but leftover pending detail URLs exist → run the
//          bounded-concurrency capture queue over them (v1's behaviour),
//        • idle — nothing due, nothing pending → slow-poll for new work.
//      `force=1` (the popup "Forzar" toggle) ignores staleness — round-robin
//      every task and drain the full pending set.
//   2. the EXISTING bounded-concurrency capture queue runs the capture (so the
//      concurrency cap + WAF-safe jittered stagger are unchanged); a harvest is
//      at most ONE unit per cooldown (it fans out into a whole batch),
//   3. on completion, schedule the NEXT unit via chrome.alarms after the
//      configured cooldown (NOT setTimeout — that dies with an evicted worker),
//   4. repeat until Auto is turned off.
//
// MV3 survival: the whole loop is data-driven, split across TWO storage areas
// (issue #587). The OPERATOR'S INTENT — `{enabled, portal, force}` — persists
// in chrome.storage.local (survives a full browser restart, not just a worker
// eviction); everything that describes an in-flight RUN (status, batchesDone,
// lastBatchAt, harvestTask, the cached batchSize/timeoutSec) stays in
// chrome.storage.session (survives eviction, wiped on browser close — and
// that's fine, since the tabs/enumeration it describes are gone too on a real
// restart). `getAutoState()`/`setAutoState()` compose/decompose the two via
// `InmoBatch.composeAutoState`/`autoIntentFromState`, so every other function
// in this file still sees the one full auto-state shape it always did.
// Without this split, `onStartup` read a wiped session key as "no auto" and
// silently disarmed the alarm — the actual bug behind "vuelva a ejecutar"
// (issue #587): the owner turns Auto on, closes the browser, and it comes
// back OFF with no signal. Scheduling itself is unchanged: alarm-driven, never
// setTimeout (that dies with an evicted worker). If the worker is evicted
// mid-CAPTURE, the top-level reattach restarts the capture loop and the
// periodic BATCH_ALARM tick completes the unit; if evicted mid-ENUMERATION (no
// resumable state), recoverStrandedHarvest closes the orphan tab, clears the
// stranded enum, and finishes the unit (recording the task run) — both read
// their state from chrome.storage.session, which eviction (unlike a restart)
// does not wipe, so they are unaffected by this split. The persisted
// harvestTask lets completion record the run even across an eviction. The
// single-driver guard (batchLooping / enum state / batch state) means Auto and a
// manual batch never double-run.

// Durable half (issue #587): the operator's intent, chrome.storage.local.
const AUTO_INTENT_KEY = 'inmoAutoIntent';
// Volatile half: the in-flight run state, chrome.storage.session — same key
// auto's whole record used before #587 (the pre-split value, if any lingers
// from before this change, is harmless: it's read as the run-state half only).
const AUTO_KEY = 'inmoAuto';
// One-shot alarm that fires after the inter-batch cooldown to start the next
// batch. Chrome clamps any alarm sooner than ~30 s up to 30 s, which is why the
// configured timeout floor (batch.js MIN_AUTO_TIMEOUT_SEC) is 30 s — a smaller
// value would silently become 30 s and misrepresent the real wait.
const AUTO_ALARM = 'inmoAutoNext';
// In-memory re-entrancy guard so the periodic and one-shot alarms (or a rapid
// START_AUTO) can't run two ticks at once.
let autoTicking = false;

async function getAutoIntent() {
  const o = await chrome.storage.local.get(AUTO_INTENT_KEY);
  return o[AUTO_INTENT_KEY] || null;
}
async function setAutoIntent(intent) {
  await chrome.storage.local.set({ [AUTO_INTENT_KEY]: intent });
}
async function getAutoSession() {
  const o = await chrome.storage.session.get(AUTO_KEY);
  return o[AUTO_KEY] || null;
}
async function setAutoSession(session) {
  await chrome.storage.session.set({ [AUTO_KEY]: session });
}

/**
 * Patch ONLY the volatile run-state half of the auto record — never the
 * durable intent (issue #613 review B1). Every mid-cycle status update
 * (PLANNING/HARVESTING/RUNNING/WAITING/EMPTY, harvestTask, batchesDone,
 * lastBatchAt, totalPending) must go through this, never `setAutoState`,
 * because those call sites hold a SNAPSHOT of `auto` taken before an
 * `await` (often a network round trip in `fetchAutoPlan`). If that snapshot
 * flowed into `setAutoState({ ...auto, ... })` it would rewrite the durable
 * intent too — including a stale `enabled:true` — so a Stop that landed
 * during the same window would be silently undone the instant the in-flight
 * cycle's write lands, and (post-#587) that undo now persists in
 * chrome.storage.local across every future restart, not just until the next
 * browser close. Only `startAuto`/`stopAuto`/`setAutoForce` — the three
 * functions that legitimately change what the operator asked for — may call
 * `setAutoState`/write intent.
 */
async function setAutoRunState(patch) {
  const session = (await getAutoSession()) || {};
  await setAutoSession({ ...session, ...patch });
}

/**
 * Compose the full auto state (issue #587) — see InmoBatch.composeAutoState.
 * The live chrome.storage.sync knobs are only fetched when the session copy
 * doesn't already have its own cached batchSize/timeoutSec (a fresh start or a
 * post-restart rehydration) — avoids an extra storage round trip on every one
 * of getAutoState()'s many callers once a run is under way.
 */
async function getAutoState() {
  const [intent, session] = await Promise.all([getAutoIntent(), getAutoSession()]);
  if (!intent || intent.enabled !== true) return null;
  const needsConfig =
    !session ||
    typeof session.batchSize !== 'number' ||
    typeof session.timeoutSec !== 'number';
  const config = needsConfig ? await getAutoConfig() : null;
  return InmoBatch.composeAutoState(intent, session, config);
}
/**
 * Persist a full auto state (issue #587): the durable intent half to
 * chrome.storage.local, the volatile run-state half to chrome.storage.session.
 * `state` null/disabled (e.g. `stopAuto`) durably clears the intent, so a
 * restart comes back OFF, not just this session.
 */
async function setAutoState(state) {
  await Promise.all([
    setAutoIntent(InmoBatch.autoIntentFromState(state)),
    setAutoSession(
      state
        ? {
            status: state.status,
            harvestTask: state.harvestTask,
            lastBatchAt: state.lastBatchAt,
            batchesDone: state.batchesDone,
            totalPending: state.totalPending,
            batchSize: state.batchSize,
            timeoutSec: state.timeoutSec,
          }
        : null,
    ),
  ]);
}

/** Operator's auto knobs (issue #424/#434) from chrome.storage.sync, clamped by batch.js. */
async function getAutoConfig() {
  const c = await chrome.storage.sync.get([
    'autoBatchSize',
    'autoBatchTimeoutSec',
    'autoForce',
  ]);
  return {
    batchSize: InmoBatch.clampAutoBatchSize(c.autoBatchSize),
    timeoutSec: InmoBatch.clampAutoTimeoutSec(c.autoBatchTimeoutSec),
    // "Forzar" (issue #434): re-capture even not-due / already-done listings.
    // Opt-in — only true when explicitly enabled; default is due-only capture.
    force: c.autoForce === true,
  };
}

/** Arm the one-shot next-batch alarm `timeoutSec` from now (idempotent overwrite). */
function scheduleAutoAlarm(timeoutSec) {
  try {
    const secs = InmoBatch.clampAutoTimeoutSec(timeoutSec);
    chrome.alarms.create(AUTO_ALARM, { when: Date.now() + secs * 1000 });
  } catch {
    /* alarms unavailable — the periodic BATCH_ALARM tick still drives auto */
  }
}
async function disarmAutoAlarm() {
  try {
    await chrome.alarms.clear(AUTO_ALARM);
  } catch {
    /* nothing armed */
  }
}

/**
 * When is the next auto-plan poll due (ms epoch), per the live alarm — issue
 * #587's popup status line ("próxima comprobación HH:MM"). Reads the ACTUAL
 * scheduled alarm rather than deriving it from `lastBatchAt + timeoutSec`, so
 * the popup shows the truth even the instant after a restart (before the
 * first re-plan has run and set a fresh `lastBatchAt`) or while a unit is
 * actively in flight (no alarm armed — `null`, which the popup reads as "now").
 */
async function getNextAutoCheckAt() {
  try {
    const alarm = await chrome.alarms.get(AUTO_ALARM);
    return alarm ? alarm.scheduledTime : null;
  } catch {
    return null; // alarms unavailable — the popup falls back to "—"
  }
}

/** True while a capture batch (auto or manual) is in flight — the single-driver guard. */
async function isBatchActive() {
  if (batchLooping) return true;
  if ((await getEnumState()) != null) return true;
  const s = await getBatchState();
  return InmoBatch.isActive(s) || (!!s && s.status === InmoBatch.STATUSES.PAUSED);
}

/**
 * Ask the server for the ONE next auto unit (issue #516): a `harvest` (open the
 * most-due profile×connector search task → enumerate → seed → capture), a
 * `drain` (capture the already-discovered pending detail URLs), or `idle`.
 * `force` (issue #434 "Forzar"): `force=1` ignores staleness (round-robin every
 * task; drain returns the full pending set). Returns the parsed unit; throws on
 * a transport/HTTP error so the caller can back off one timeout.
 */
async function fetchAutoPlan(portal, force) {
  const { apiUrl, apiKey } = await getApiConfig();
  const params = new URLSearchParams();
  if (portal) params.set('portal', portal);
  if (force) params.set('force', '1');
  const qs = params.toString();
  const response = await fetch(
    `${apiUrl}/api/etl/auto-plan${qs ? `?${qs}` : ''}`,
    { headers: { 'x-admin-key': apiKey } },
  );
  if (!response.ok) throw new Error(`auto-plan: ${response.status}`);
  return response.json();
}

/**
 * Record (upsert) a capture task run so the staleness ledger advances (issue
 * #516) — the extension counterpart to the /captura button's POST
 * (ConnectorSection.tsx). Without this, a harvested-but-not-recorded task stays
 * "due" and auto would re-harvest it forever. Best-effort: a failure is logged
 * by the caller and never blocks the cooldown. Uses the admin-key channel — the
 * key only lives in this worker — like every other write here.
 */
async function postCaptureTaskRun(profileId, taskId) {
  const { apiUrl, apiKey } = await getApiConfig();
  const response = await fetch(
    `${apiUrl}/api/profiles/${profileId}/capture-task-runs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
      body: JSON.stringify({ taskId }),
    },
  );
  if (!response.ok) throw new Error(`capture-task-run: ${response.status}`);
  return response.json();
}

/** Turn Auto ON: persist enabled state, then kick the first batch immediately. */
async function startAuto(portal) {
  const { batchSize, timeoutSec, force } = await getAutoConfig();
  const state = InmoBatch.makeAutoState({
    enabled: true,
    portal,
    batchSize,
    timeoutSec,
    force,
    status: InmoBatch.AUTO_STATUS.IDLE,
  });
  await setAutoState(state);
  await disarmAutoAlarm();
  // Fire-and-forget so the popup gets a prompt response; autoTick guards re-entry.
  autoTick();
  return getAutoProgress();
}

/**
 * Turn Auto OFF. Deliberately does NOT stop the in-flight batch — "OFF = parar
 * tras el lote en curso" (issue #424). The current batch drains normally; no new
 * batch is scheduled. Clears the one-shot alarm.
 */
async function stopAuto() {
  const auto = await getAutoState();
  if (auto) {
    // issue #613 review note: `status: STOPPED` here is written to
    // chrome.storage.session but is now UNREACHABLE via any reader —
    // `composeAutoState`/`getAutoState` return `null` once the durable intent
    // is disabled (below), regardless of what the session half says. Kept
    // (harmless, inert) rather than special-cased away; `AUTO_STATUS.STOPPED`
    // remains meaningful raw-storage-inspection context, just not something
    // the popup can ever render.
    await setAutoState({ ...auto, enabled: false, status: InmoBatch.AUTO_STATUS.STOPPED });
  }
  await disarmAutoAlarm();
  return getAutoProgress();
}

/** Combined auto + current-batch progress for the popup. */
async function getAutoProgress() {
  const auto = await getAutoState();
  const batch = InmoBatch.progress(await getBatchState());
  // The pending-search queue (issue #554) rides along here too, so the popup
  // shows it consistently whether or not Auto is on.
  const q = await queueSummary();
  // issue #587: the popup's status line needs the ACTUAL armed alarm (not a
  // derived estimate) so a silently-dead scheduler is visibly distinguishable
  // from a genuinely idle one — surfaced whether or not Auto is on (an armed
  // alarm with Auto off would itself be a bug worth seeing).
  const nextCheckAt = await getNextAutoCheckAt();
  // issue #634: the popup's armed-status line must never say "armed" while a
  // block is active (D-134's truthful-state principle) — surfaced whether or
  // not Auto is on, same reasoning as nextCheckAt above.
  const blocked = await activeBlockSummary();
  if (!auto) {
    // No live auto state: surface the persisted "Forzar" preference so the
    // popup's checkbox reflects it even before Auto is turned on (issue #434).
    const { force } = await getAutoConfig();
    return {
      enabled: false,
      status: InmoBatch.AUTO_STATUS.IDLE,
      force,
      lastBatchAt: null,
      nextCheckAt,
      blocked,
      batch,
      ...q,
    };
  }
  return {
    enabled: auto.enabled === true,
    status: auto.status,
    portal: auto.portal,
    batchesDone: auto.batchesDone,
    totalPending: auto.totalPending,
    batchSize: auto.batchSize,
    timeoutSec: auto.timeoutSec,
    force: auto.force === true,
    // The harvest unit in flight (issue #516) so the popup can label
    // "descubriendo <portal>" vs a plain drain batch.
    harvestTask: auto.harvestTask || null,
    // Issue #705: a prospective-site unit in flight, so the status line can say
    // WHY Auto isn't draining the listing queue right now.
    spikeUnit: auto.spikeUnit === true,
    // issue #587: when the last unit ran / when the next poll is due, so the
    // popup can show "Auto: ON — próxima comprobación HH:MM" / "última tanda
    // hace X" instead of a bare toggle a dead scheduler is indistinguishable
    // from a live one.
    lastBatchAt: auto.lastBatchAt,
    nextCheckAt,
    blocked,
    ...q,
    batch,
  };
}

/**
 * Set the "Forzar" preference (issue #434): persist it in chrome.storage.sync
 * (survives everything, like the other auto knobs) AND, if Auto is currently
 * running, update the live state so the very next batch respects it without
 * needing a stop/start. Returns fresh progress.
 */
async function setAutoForce(force) {
  const f = force === true;
  await chrome.storage.sync.set({ autoForce: f });
  const auto = await getAutoState();
  if (auto) await setAutoState({ ...auto, force: f });
  return getAutoProgress();
}

/**
 * Run ONE harvest unit end to end (issue #516): open the task's search URL,
 * enumerate every results page (rendered, in-session — reuses the SAME machinery
 * the manual "Capturar todas" flow uses), seed each page's detail URLs, then
 * build + run the bounded-concurrency capture queue over the portal's pending
 * set. Awaitable — resolves only once the capture queue has drained (or was
 * stopped) — so the caller can then record the task run and cool down.
 *
 * The map→listing normalisation (#506 `toListingUrl`) happens inside
 * enumerateResultsPages, so the server hands us the resolved search URL verbatim.
 */
/**
 * Run ONE harvest unit end to end. The CALLER (runAutoBatch) must have
 * ALREADY atomically claimed the run (persisted the 'enumerating' state
 * inside `runBatchStateExclusive`) — mirrors `beginRun`'s contract for the
 * manual path (issue #554). This function never re-claims; it only drives.
 *
 * issue #554 review B1: `enumRunning` spans the WHOLE handoff — the page
 * walk AND the capture-queue build — not just the walk, exactly like
 * `runEnumerationThenCapture`. Before this, `clearEnumState()` ran (in this
 * function's own finally) BEFORE the network `fetchPendingUrls` call below,
 * leaving a window where `isBatchActive()` read false for the whole request
 * — the same clobbering shape the manual path had, just reachable only while
 * Auto is harvesting.
 */
async function runAutoHarvest(portal, searchUrl) {
  // Piggyback capture-to-infer, exactly like startBatch (best-effort).
  await saveSearchUrlExample(searchUrl);
  enumRunning = true;
  try {
    let discoveredCount = 0;
    try {
      // page1Urls = [] → the walk renders + seeds page 1 itself (no popup harvest).
      await enumerateResultsPages(portal, searchUrl, []);
      const enumState = await getEnumState(); // read before the handoff clears it
      if (enumState && typeof enumState.discovered === 'number') {
        discoveredCount = enumState.discovered;
      }
    } catch {
      /* fall through — capture whatever was seeded so far */
    }
    // Build + run the capture queue over everything just seeded. Concurrency
    // + pacing come from the SAME operator config the manual path uses.
    // runCaptureQueue atomically clears the enum claim as part of persisting
    // the capture state (issue #554 review B1) and resolves once the batch
    // drains, so the caller (runAutoBatch) can await task-run bookkeeping.
    try {
      await runCaptureQueue(portal, discoveredCount);
    } catch (err) {
      // A failure here must not strand the claim (issue #554 review N5).
      await clearEnumState().catch(() => {});
      throw err; // preserve Auto's existing error-propagation contract
    }
  } finally {
    enumRunning = false;
  }
}

/**
 * Drive ONE auto unit (issue #516): ask the server for the next unit
 * (harvest / drain / idle) and execute it, then begin the cooldown.
 *   • harvest → open the most-due search task and run discovery→seed→capture
 *     (runAutoHarvest), persisting the in-flight task so an eviction can still
 *     record the run; onAutoBatchComplete POSTs the task run so staleness advances.
 *   • drain   → run the bounded-concurrency queue over the returned pending URLs
 *     (v1's behaviour).
 *   • idle    → keep Auto ON and slow-poll for new work.
 * Guards against starting on top of a live batch. On a backend error it backs
 * off for one timeout. Kept the name `runAutoBatch` — it is still "run the next
 * auto unit" and is wired to the same alarm-tick 'start' action.
 */
/**
 * Back off one cooldown and let Auto retry next tick — shared by the backend
 * hiccup path and the two "lost the claim race" paths below (issue #554
 * review N7).
 */
async function deferAutoTick(auto, timeoutSec) {
  await setAutoRunState({
    status: InmoBatch.AUTO_STATUS.WAITING,
    lastBatchAt: Date.now(),
  });
  scheduleAutoAlarm(timeoutSec);
}

async function runAutoBatch() {
  const auto = await getAutoState();
  if (!auto || auto.enabled !== true) return;
  if (await isBatchActive()) return; // single-driver guard (courtesy — the real guard is below)

  // Mark PLANNING before the network call so an eviction during the fetch is
  // recoverable (nextAutoAction maps a stranded PLANNING → re-plan). Run-state
  // only (issue #613 review B1) — `auto` here is a snapshot that predates the
  // `fetchAutoPlan` await below; writing it through `setAutoState` would also
  // rewrite the durable intent with a possibly-stale `enabled`.
  await setAutoRunState({ status: InmoBatch.AUTO_STATUS.PLANNING });

  let plan;
  try {
    plan = await fetchAutoPlan(auto.portal, auto.force === true);
  } catch {
    // Backend hiccup: back off one timeout and try again (Auto stays ON).
    await deferAutoTick(auto, auto.timeoutSec);
    return;
  }

  // Prospective-site unit (issue #705) — planned FIRST by the server because
  // the operator queued these by hand seconds ago. Capped server-side
  // (SPIKE_UNIT_LIMIT), so it can never hold the real listing drain for more
  // than a couple of ticks. It touches no batch state and no worklist row, so
  // it needs none of the claim/eviction machinery the other two units carry.
  if (plan && plan.kind === 'spike' && Array.isArray(plan.items) && plan.items.length > 0) {
    await setAutoRunState({
      status: InmoBatch.AUTO_STATUS.RUNNING,
      harvestTask: null,
      spikeUnit: true,
      totalPending: plan.items.length,
    });
    try {
      await runAutoSpike(plan.items);
    } finally {
      await setAutoRunState({ spikeUnit: false });
    }
    await onAutoBatchComplete();
    return;
  }

  if (plan && plan.kind === 'harvest' && plan.task && plan.task.url) {
    const task = plan.task;
    // issue #554 review N7: the `isBatchActive()` check above is only a
    // courtesy early-exit — `fetchAutoPlan` is a network round trip, during
    // which a manually queued search (or a stranded-run recovery) could have
    // claimed the run. Re-check AND claim (persist the 'enumerating' state)
    // atomically inside the same critical section startBatch/advanceQueueIfIdle
    // use, so the two claim paths can never both succeed.
    const claimed = await runBatchStateExclusive(async () => {
      if (await isBatchActive()) return false;
      await setEnumState({
        status: 'enumerating',
        portal: task.portal,
        discovered: 0,
        page: 1,
      });
      return true;
    });
    if (!claimed) {
      // Something else claimed the run in the gap between our guard and now
      // — defer to it, exactly like a backend hiccup.
      await deferAutoTick(auto, auto.timeoutSec);
      return;
    }
    // Persist the in-flight harvest task BEFORE any work so a mid-harvest
    // eviction can still POST the task run on completion (else re-harvest forever).
    // Run-state only (issue #613 review B1) — see the PLANNING mark above.
    await setAutoRunState({
      status: InmoBatch.AUTO_STATUS.HARVESTING,
      harvestTask: {
        profileId: task.profileId,
        taskId: task.taskId,
        portal: task.portal,
        url: task.url,
      },
    });
    await runAutoHarvest(task.portal, task.url);
    await onAutoBatchComplete();
    return;
  }

  if (plan && plan.kind === 'drain' && Array.isArray(plan.urls) && plan.urls.length > 0) {
    const urls = plan.urls.filter((u) => typeof u === 'string');
    const { concurrency } = await getBatchConfig();
    // auto.portal is null when Auto is unrestricted ("drain every portal") —
    // makeBatchState correctly stores portal:null for that case, and
    // handleBlockDetected's cross-portal guard (issue #634 review B4) falls
    // back to pausing on any block for a run it can't attribute to one portal.
    const state = InmoBatch.makeBatchState(urls, concurrency, undefined, auto.portal);
    // Same atomic re-check-and-claim as the harvest branch above (issue #554
    // review N7) — the persisted RUNNING batch state itself is what signals
    // "active" to any concurrent claimant from here on.
    const claimed = await runBatchStateExclusive(async () => {
      if (await isBatchActive()) return false;
      await setBatchState(state);
      return true;
    });
    if (!claimed) {
      await deferAutoTick(auto, auto.timeoutSec);
      return;
    }
    // Run-state only (issue #613 review B1) — see the PLANNING mark above.
    await setAutoRunState({
      status: InmoBatch.AUTO_STATUS.RUNNING,
      harvestTask: null,
      totalPending: urls.length,
    });
    await runBatchLoop(); // resolves when the batch finishes (or was paused/stopped)
    await onAutoBatchComplete();
    return;
  }

  // idle (nothing due, nothing pending) — keep Auto ON and slow-poll.
  const retry =
    plan && typeof plan.retryAfterSec === 'number' && plan.retryAfterSec > 0
      ? plan.retryAfterSec
      : auto.timeoutSec;
  // Run-state only (issue #613 review B1) — see the PLANNING mark above.
  await setAutoRunState({
    status: InmoBatch.AUTO_STATUS.EMPTY,
    harvestTask: null,
    lastBatchAt: Date.now(),
    totalPending: 0,
  });
  scheduleAutoAlarm(retry);
}

/**
 * A unit finished under Auto: for a HARVESTING unit, record the task run first
 * (issue #516) so the staleness ledger advances and the task stops being "due";
 * then count the unit and begin the cooldown before the next. Idempotent — only
 * acts while status is RUNNING or HARVESTING, so the inline call and a
 * watchdog-detected completion can't double-count (the status flip to WAITING
 * makes a second call a no-op). No-op once Auto is off.
 */
async function onAutoBatchComplete() {
  const auto = await getAutoState();
  if (!auto || auto.enabled !== true) return;
  if (
    auto.status !== InmoBatch.AUTO_STATUS.RUNNING &&
    auto.status !== InmoBatch.AUTO_STATUS.HARVESTING
  ) {
    return;
  }
  // Record the harvest task run (staleness advances). Best-effort: a failure
  // must not wedge the cooldown — the task simply stays due and is retried.
  if (auto.status === InmoBatch.AUTO_STATUS.HARVESTING && auto.harvestTask) {
    try {
      await postCaptureTaskRun(auto.harvestTask.profileId, auto.harvestTask.taskId);
    } catch {
      /* best-effort — the next plan will re-surface the due task */
    }
  }
  // Run-state only (issue #613 review B1) — see the PLANNING mark above.
  await setAutoRunState({
    status: InmoBatch.AUTO_STATUS.WAITING,
    harvestTask: null,
    batchesDone: auto.batchesDone + 1,
    lastBatchAt: Date.now(),
  });
  scheduleAutoAlarm(auto.timeoutSec);
}

/**
 * Recover a HARVEST unit stranded by an MV3 worker eviction (issue #516).
 *
 * The capture queue survives eviction (persisted slots + reattachIfStranded),
 * but the results-page ENUMERATION phase has no resumable state — so an eviction
 * mid-enumeration leaves `BATCH_ENUM_KEY` set with no live walk, which would make
 * isBatchActive() report "active" forever and wedge auto. This detects that
 * (status HARVESTING, nothing live: not looping, not enumerating, no active
 * capture queue), closes the orphaned enumeration tab, clears the stranded enum
 * state, and FINISHES the unit — recording the task run so staleness advances
 * (never re-harvest the same task forever) and cooling down. When the eviction
 * happened during CAPTURE instead (queue still `running`), it defers to
 * reattachIfStranded, which resumes the queue; a later tick then completes it.
 * Idempotent and cheap — a no-op unless a harvest is genuinely stranded.
 */
async function recoverStrandedHarvest() {
  if (batchLooping || enumRunning) return; // something live is driving it
  const auto = await getAutoState();
  if (!auto || auto.enabled !== true) return;
  if (auto.status !== InmoBatch.AUTO_STATUS.HARVESTING) return;
  const batch = await getBatchState();
  if (InmoBatch.isActive(batch)) return; // capture stranded → reattachIfStranded owns it
  const persisted = await readBatchTabs();
  for (const id of persisted) {
    try {
      await chrome.tabs.remove(id);
    } catch {
      /* tab already gone */
    }
  }
  batchTabIds.clear();
  await clearBatchTabs();
  await clearEnumState();
  await onAutoBatchComplete(); // records the task run (if any) + begins cooldown
}

/**
 * The alarm-driven heartbeat of the auto loop. Reads the pure decision
 * (InmoBatch.nextAutoAction) from the persisted state + live facts and performs
 * the side effect. Re-entrancy-guarded; safe to call from both alarms and every
 * lifecycle event.
 */
async function autoTick() {
  if (autoTicking) return;
  autoTicking = true;
  try {
    // First heal a harvest stranded by an eviction (issue #516) — must run
    // BEFORE isBatchActive() so a stranded enumeration can't defer forever.
    await recoverStrandedHarvest();
    const auto = await getAutoState();
    if (!auto || auto.enabled !== true) {
      await disarmAutoAlarm();
      return;
    }
    const batchActive = await isBatchActive();
    const action = InmoBatch.nextAutoAction(auto, { batchActive, now: Date.now() });
    if (action === 'idle') {
      await disarmAutoAlarm();
    } else if (action === 'complete') {
      await onAutoBatchComplete();
    } else if (action === 'start') {
      await runAutoBatch();
    }
    // 'defer' / 'wait': nothing to do — the periodic BATCH_ALARM (and the armed
    // AUTO_ALARM) will re-tick.
  } finally {
    autoTicking = false;
  }
}

// Top-level auto tick: resumes an in-progress auto run after a worker respawn
// (its state consts above are now initialised, so no TDZ).
autoTick();

async function getApiConfig() {
  const config = await chrome.storage.sync.get(['apiUrl', 'apiKey']);
  return {
    apiUrl: (config.apiUrl || 'http://localhost:4000').replace(/\/+$/, ''),
    apiKey: config.apiKey || '',
  };
}

/**
 * Server-mediated presence heartbeat (issue #509). The extension can NOT inject
 * into the dashboard origin, so the dashboard can only know the extension is
 * installed + configured by receiving this ping. Fire-and-forget: sent on worker
 * spawn and on the periodic watchdog tick; a failure (dashboard down, key not
 * set yet) is swallowed so it never interferes with capture work. Skipped when
 * no API key is configured — an unconfigured extension is, correctly, "not
 * linked".
 */
async function sendHeartbeat() {
  try {
    const { apiUrl, apiKey } = await getApiConfig();
    if (!apiKey) return; // not configured yet — nothing to report
    const version = chrome.runtime.getManifest().version;
    await fetch(`${apiUrl}/api/extension/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
      body: JSON.stringify({ version }),
    });
  } catch {
    /* best-effort — never let a heartbeat failure surface or block capture */
  }
}

/**
 * Submit captured HTML for parsing. This does NOT return the parsed
 * result — the inmo-tool backend processes captures asynchronously in a
 * separate service (etl/capture.py's poll loop, see the dashboard route's
 * own docstring for why). Returns {success, capture_id}; the caller
 * (popup.js) polls CHECK_CAPTURE_STATUS with that id for the real result.
 */
async function handleExtraction({ url, html, renderWaitMs }) {
  const { apiUrl, apiKey } = await getApiConfig();

  const response = await fetch(`${apiUrl}/api/extension/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
    // renderWaitMs (issue #700) is omitted, not sent as null, when the caller
    // didn't time this capture (manual/forced capture never waits for render).
    // The route treats absent and null identically, so this is presentational
    // only — but it keeps "we didn't measure" out of the wire format.
    body: JSON.stringify(
      typeof renderWaitMs === 'number' ? { url, html, renderWaitMs } : { url, html },
    ),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  return response.json();
}

async function handleCheckStatus(captureId) {
  const { apiUrl, apiKey } = await getApiConfig();

  const response = await fetch(`${apiUrl}/api/extension/capture/${captureId}`, {
    headers: { 'x-admin-key': apiKey },
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  if (data.property_url) {
    // The status route returns a relative path; resolve it against
    // apiUrl so popup.js's "Ver en Inmo-Tool" link works regardless of
    // where the dashboard is actually hosted.
    data.property_url = `${apiUrl}${data.property_url}`;
  }
  return data;
}

// ═══ Diagnostics: "forzar captura + diagnóstico" (issue #671) ══════════════
//
// A DIAGNOSTIC channel, never an ingest path: sendDiagnostic POSTs to
// /api/extension/diagnostic — a dedicated route/table `/api/extension/capture`
// never touches and etl/capture.py's poller never reads (see the route's own
// docstring and the D-153 record for this feature). Works on ANY page —
// content-script.js's CAPTURE_DIAGNOSTIC handler degrades every field to
// null/false for a page detect.js doesn't recognise, by construction.
//
// ┌───────────────────────────────────────────────────────────────────────┐
// │ NETWORK CAPTURE IS PARKED — DO NOT WIRE A UI ENTRY POINT TO IT (#684) │
// └───────────────────────────────────────────────────────────────────────┘
// The functions below (armNetworkRecording / recordNetworkEntry /
// disarmNetworkRecording) and their ARM_NETWORK_RECORDING /
// STOP_NETWORK_RECORDING / NETWORK_ENTRY handlers are RETAINED but
// UNREACHABLE: the popup's "Grabar red y recargar" button was removed before
// #675 merged, so nothing in the shipped extension can arm a recording, and
// `disarmNetworkRecording` therefore always returns null (SEND_DIAGNOSTIC
// posts `network: null`).
//
// They are parked rather than deleted because the pure redaction module
// (network-recorder.js) and its tests are sound and worth rebuilding on. The
// LIFECYCLE is not:
//   - `disarmNetworkRecording` bails on `!networkBuffers.has(tabId)` BEFORE
//     unregistering, and that Map dies with the MV3 service worker (~30s
//     idle) — so on the happy path the recorder is never torn down;
//   - `registerContentScripts` omits `persistAcrossSessions:false` (defaults
//     to TRUE) and no onStartup/respawn sweep clears `inmo-diag-*`;
//   - `matches` is origin-scoped, so every tab on the origin is wrapped.
// Full analysis, redaction audit and exit criteria: issue #684. Read it
// before touching any of this — the existing background test currently
// ASSERTS the broken disarm behaviour and has to be inverted first.

const networkBuffers = new Map(); // tabId -> raw entry[] (pre-cap)

async function getArmedRecordings() {
  const { diagArmed } = await chrome.storage.session.get('diagArmed');
  return diagArmed && typeof diagArmed === 'object' ? diagArmed : {};
}

async function setArmedRecordings(armed) {
  await chrome.storage.session.set({ diagArmed: armed });
}

function networkScriptIds(tabId) {
  const base = `inmo-diag-${tabId}`;
  return [`${base}-main`, `${base}-relay`];
}

/**
 * Register the MAIN-world fetch/XHR recorder + its ISOLATED-world relay for
 * `origin`, scoped to exactly that origin — never `<all_urls>` — so a
 * recording session only ever sees traffic for the page being diagnosed. The
 * host permission for `origin` must ALREADY be granted: `chrome.permissions
 * .request` requires a real user-activation signal, which only the popup (an
 * extension PAGE) has — a service worker does not, so requesting it here
 * would silently fail. popup.js requests it directly, then sends this.
 */
async function armNetworkRecording(tabId, origin) {
  if (tabId == null || !origin) {
    return { success: false, error: { message: 'Falta la pestaña o el origen.' } };
  }
  let has = false;
  try {
    has = await chrome.permissions.contains({ origins: [origin + '/*'] });
  } catch (err) {
    return { success: false, error: { message: err.message } };
  }
  if (!has) {
    return {
      success: false,
      error: { message: 'Falta el permiso de host para grabar red en este origen.' },
    };
  }
  const [mainId, relayId] = networkScriptIds(tabId);
  try {
    // Idempotent re-arm: clear any stale registration for this tab first.
    await chrome.scripting.unregisterContentScripts({ ids: [mainId, relayId] }).catch(() => {});
    await chrome.scripting.registerContentScripts([
      {
        id: mainId,
        matches: [origin + '/*'],
        js: ['network-recorder.js', 'network-recorder-main.js'],
        world: 'MAIN',
        runAt: 'document_start',
        allFrames: false,
      },
      {
        id: relayId,
        matches: [origin + '/*'],
        js: ['network-recorder-relay.js'],
        world: 'ISOLATED',
        runAt: 'document_start',
        allFrames: false,
      },
    ]);
  } catch (err) {
    return { success: false, error: { message: err.message } };
  }
  networkBuffers.set(tabId, []);
  const armed = await getArmedRecordings();
  armed[tabId] = { origin, armedAt: Date.now() };
  await setArmedRecordings(armed);
  return { success: true };
}

/** Current recording state for `tabId`, for the popup's status line. */
function getNetworkRecordingState(tabId) {
  const entries = networkBuffers.get(tabId);
  return { armed: networkBuffers.has(tabId), entryCount: entries ? entries.length : 0 };
}

/** Buffer one relayed entry. Drops it silently if `tabId` isn't armed (a
 * disarm race, or a stray message from a stale page) — never throws. */
function recordNetworkEntry(tabId, entry) {
  if (tabId == null || !networkBuffers.has(tabId) || !entry) return;
  const list = networkBuffers.get(tabId);
  list.push(entry);
  // Independent of the storage-time cap (NR.MAX_ENTRIES) applied at flush —
  // just keeps this in-memory buffer itself from growing unboundedly between
  // flushes on a very chatty page.
  const HARD_CAP = 1000;
  if (list.length > HARD_CAP) list.shift();
}

/**
 * Unregister the dynamic content scripts for `tabId` and return its buffered
 * entries, redaction-capped to NR.MAX_ENTRIES (keeping the MOST RECENT —
 * network-recorder.js `capEntries`). Returns null when nothing was armed for
 * this tab. ALWAYS safe to call, even with nothing armed — SEND_DIAGNOSTIC
 * calls this unconditionally so a recorder can never outlive the diagnostic
 * send it exists for.
 */
async function disarmNetworkRecording(tabId) {
  if (tabId == null || !networkBuffers.has(tabId)) return null;
  const raw = networkBuffers.get(tabId) || [];
  networkBuffers.delete(tabId);
  const [mainId, relayId] = networkScriptIds(tabId);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [mainId, relayId] });
  } catch {
    /* best-effort — a stale registration only ever matches this one origin
       and reinstalling on next arm overwrites it; must not block sending */
  }
  try {
    const armed = await getArmedRecordings();
    if (armed[tabId]) {
      delete armed[tabId];
      await setArmedRecordings(armed);
    }
  } catch {
    /* storage.session best-effort */
  }
  const NR = self.InmoNetworkRecorder;
  if (!NR) return { entries: raw, droppedCount: 0 };
  return NR.capEntries(raw);
}

/**
 * POST the diagnostic payload to the dashboard's dedicated route. `network`
 * is null when no recording was armed for this tab's session, or
 * `{entries, droppedCount}` (already redacted/capped) otherwise.
 */
async function sendDiagnostic({ url, html, title, diagnostic, network }) {
  const { apiUrl, apiKey } = await getApiConfig();
  const response = await fetch(`${apiUrl}/api/extension/diagnostic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
    body: JSON.stringify({ url, html, title, diagnostic, network }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }
  return response.json();
}

// ═══ Prospective-site capture ("sitios en evaluación", issue #705) ═════════
//
// The queue half of the owner's ask: while Auto is already polling, hand the
// extension pages from a site inmo-tool does NOT support yet, so a connector
// author gets a real rendered sample. NOTHING here fetches the candidate site
// — a tab is opened in the operator's own browser and whatever it renders is
// read out of the DOM, exactly like the #675 "Forzar captura + diagnóstico"
// button. That is what makes this path usable on the WAF-protected sites we
// have deliberately refused to build against (D-026/D-027/D-033).
//
// The page goes to POST /api/extension/diagnostic, never
// /api/extension/capture: there is no connector, so nothing could normalise
// it, and it must never become a `listing` or an ingestion failure.

/** Origin (scheme://host[:port]) of `url`, or null when it doesn't parse. */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Is the extension allowed to inject into `origin`?
 *
 * `manifest.json` pre-declares only localhost + the four capture portals, so a
 * candidate site is covered exclusively by `optional_host_permissions`
 * (`http(s)://*​/*`) — which Chrome grants only from a real user gesture on an
 * extension PAGE. The service worker has no user-activation signal (the same
 * constraint `armNetworkRecording` documents), so it can only ever CHECK here;
 * the popup's "Permitir sitios en evaluación" button does the asking.
 */
async function hasSpikePermission(origin) {
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin + '/*'] });
  } catch {
    return false;
  }
}

/** The queue's current state, for the popup's permission prompt. */
async function fetchSpikeQueue() {
  const { apiUrl, apiKey } = await getApiConfig();
  const response = await fetch(`${apiUrl}/api/etl/spike-queue`, {
    headers: { 'x-admin-key': apiKey },
  });
  if (!response.ok) throw new Error(`spike queue: ${response.status}`);
  return response.json();
}

/**
 * Which pending spike origins still lack a host permission. Drives the popup's
 * prompt: it appears only when there is something to grant, and disappears
 * once granted, so it is never a permanent nag.
 */
async function spikeOriginsNeedingPermission() {
  let data;
  try {
    data = await fetchSpikeQueue();
  } catch {
    return [];
  }
  const origins = Array.isArray(data.pendingOrigins) ? data.pendingOrigins : [];
  const needed = [];
  for (const origin of origins) {
    if (!(await hasSpikePermission(origin))) needed.push(origin);
  }
  return needed;
}

/**
 * Tell the server this request was opened and no page came back. The server
 * counts attempts and, at its own limit, files the row as `unreachable` —
 * never `failed`. Best-effort: losing this report only means the row is
 * retried once more, which is strictly safer than dropping it.
 */
async function reportSpikeAttempt(id) {
  try {
    const { apiUrl, apiKey } = await getApiConfig();
    await fetch(`${apiUrl}/api/etl/spike-queue/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
      body: JSON.stringify({ attempt: true }),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Open ONE prospective-site URL, read the rendered page, send it to the
 * diagnostic channel, close the tab. Returns true when a page was sent.
 *
 * Tab lifecycle mirrors `captureOnePage`/`renderAndHarvest`: created ACTIVE so
 * Chrome doesn't throttle the render (D-043's reasoning is unchanged by the
 * host being unknown), closed unconditionally in the `finally`, and registered
 * in `batchTabIds` so a worker eviction still cleans it up.
 *
 * Readiness is deliberately NOT `isRenderReady`: that consults the portal's
 * `readySelectors`, and a candidate site has no portal entry, so it could only
 * ever fall through to the generic heuristic. Waiting for the load event plus
 * one jittered dwell is both honest about what we know and enough for the job
 * — a half-rendered page is still a useful diagnostic, and "this site renders
 * nothing without further interaction" is itself the answer a spike wants.
 */
async function captureSpikePage(url) {
  const origin = originOf(url);
  if (!(await hasSpikePermission(origin))) return false;

  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: true });
  } catch {
    return false;
  }
  batchTabIds.add(tab.id);
  await persistBatchTabs();
  try {
    if (!(await waitTabComplete(tab.id, BATCH_CAPTURE_TIMEOUT_MS))) return false;
    // One dwell for late client-side rendering, jittered like every other
    // page-to-page pause in this file (WAF-safe pacing, D-043) even though
    // nothing here is a request to the site.
    const cfg = await getBatchConfig();
    await sleep(InmoBatch.jitterDelay(cfg.paceBaseMs, cfg.paceSpreadMs));

    // Same on-demand injection the popup's force-diagnostic button uses — the
    // manifest's static content_scripts never match a candidate site's host.
    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_DIAGNOSTIC' });
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['detect.js', 'diagnostic.js', 'content-script.js'],
      });
      res = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_DIAGNOSTIC' });
    }
    if (!res || !res.html) return false;

    await sendDiagnostic({
      url: res.url || url,
      html: res.html,
      title: res.title,
      diagnostic: res.diagnostic,
      network: null,
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      /* tab already closed */
    }
    batchTabIds.delete(tab.id);
    await persistBatchTabs();
  }
}

/**
 * Run one `spike` auto unit: capture each queued page in turn, paced, reporting
 * the ones that produced nothing so the server can eventually file them as
 * `unreachable`.
 *
 * Strictly sequential — no concurrency knob. The unit is at most a handful of
 * pages from a site we know nothing about; opening several of its tabs at once
 * is neither needed nor polite.
 *
 * A capture that DOES land needs no report: the diagnostic route correlates it
 * to its queue row by the canonical match key.
 */
async function runAutoSpike(items) {
  const cfg = await getBatchConfig();
  for (const item of items) {
    if (!item || typeof item.url !== 'string') continue;
    const sent = await captureSpikePage(item.url);
    if (!sent) await reportSpikeAttempt(item.id);
    await sleep(InmoBatch.jitterDelay(cfg.paceBaseMs, cfg.paceSpreadMs));
  }
}

// ═══ CommonJS export for tests (issue #554 review N8) ══════════════════════
//
// background.js is the imperative shell around Chrome's extension APIs and
// has never been unit-tested (batch.js carries the pure logic and IS
// tested — see its own module header). The #554 review found a real
// concurrency bug (B1) in exactly this wiring — the atomic-claim-vs-network
// handoff between startBatch/advanceQueueIfIdle/runCaptureQueue/
// reattachIfStranded — which no predicate-only test could have caught. This
// export is ADDITIVE ONLY (a real Chrome service worker has no `module`
// global, so this block never runs there) and exposes just enough of the
// wiring for dashboard/__tests__/extension-background-batch-queue.test.ts to
// drive it against a stubbed chrome/fetch, including reproducing B1's
// interleaving directly. Keep this list narrow — export what a test needs to
// observe or drive, not the whole file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    startBatch,
    advanceQueueIfIdle,
    runCaptureQueue,
    stopBatch,
    reattachIfStranded,
    isBatchActive,
    runBatchLoop,
    getBatchState,
    setBatchState,
    getEnumState,
    setEnumState,
    clearEnumState,
    getSearchQueue,
    setSearchQueue,
    getAutoState,
    setAutoState,
    // issue #587: durable-intent rehydration (restart recovery + popup status).
    getAutoIntent,
    getAutoSession,
    // issue #613 review B1: run-state-only writer, so tests can prove a
    // Stop mid-cycle can't be resurrected by an in-flight run-state update.
    setAutoRunState,
    startAuto,
    stopAuto,
    autoTick,
    runAutoBatch,
    deferAutoTick,
    recoverStrandedHarvest,
    getAutoProgress,
    getNextAutoCheckAt,
    // Block/challenge episodes (issue #634)
    handleBlockDetected,
    tryReportBlockEpisode,
    clearBlockIfActive,
    getBlockState,
    setBlockState,
    isPortalBlocked,
    activeBlockSummary,
    enumerationStopped,
    // Prospective-site capture (issue #705)
    runAutoSpike,
    captureSpikePage,
    hasSpikePermission,
    spikeOriginsNeedingPermission,
    reportSpikeAttempt,
    runEnumerationThenCapture,
    runBatchStateExclusive,
    // Diagnostics / network capture (issue #671)
    armNetworkRecording,
    disarmNetworkRecording,
    recordNetworkEntry,
    getNetworkRecordingState,
    sendDiagnostic,
    networkBuffers,
  };
}
