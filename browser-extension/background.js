/**
 * background.js — Service worker for the extension.
 * Handles API communication, badge logic, and the batch-capture queue.
 *
 * Forked from property_web_scraper's chrome-extensions/property-scraper/ —
 * see NOTICE.md. The haul/multi-tenant machinery (CREATE_HAUL, haul_id,
 * haul-history.js) is removed: this extension talks to exactly one
 * self-hosted inmo-tool backend, not an anonymous multi-tenant SaaS.
 *
 * Batch capture (issue #262): the pure queue logic lives in batch.js
 * (self.InmoBatch); this worker drives the chrome-tab lifecycle around it —
 * open+activate a detail tab, wait for the content script's AUTO_CAPTURE_DONE,
 * close it, wait a jittered pace, advance. See the "Batch capture" section
 * below and D-043.
 */

// Pure queue state machine (makeBatchState/currentUrl/recordResult/…). Classic
// MV3 worker → synchronous importScripts at top level.
importScripts("batch.js");

/**
 * Supported capture hosts are BACKEND-DRIVEN (issue #237): the dashboard's
 * GET /api/extension/config returns the current list (mirroring the ETL's
 * capture connectors), so adding a new portal lights up the badge with no
 * extension redeploy. This list only gates the cosmetic ✓ badge — capture
 * itself works on any http(s) tab (popup.js injects the content script on
 * demand) — so a stale cache or a failed fetch degrades gracefully to this
 * hardcoded default.
 */
const DEFAULT_CAPTURE_HOSTS = ['idealista.com', 'alisedainmobiliaria.com', 'altamirainmuebles.com'];
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
    handleExtraction(msg).then(sendResponse).catch((err) => {
      sendResponse({ success: false, error: { message: err.message } });
    });
    return true; // async response
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

  // Auto-capture (issue #254) fired in the content script — flash the toolbar
  // badge for that tab so the auto-capture is never silent. Cosmetic only; no
  // response needed. ALSO the advance signal for a batch run (issue #262): if
  // this is the tab the batch loop is currently waiting on, unblock it.
  if (msg.type === 'AUTO_CAPTURE_DONE') {
    const tabId = _sender.tab && _sender.tab.id;
    if (tabId != null) {
      chrome.action.setBadgeText({ tabId, text: '✓' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#22c55e' });
      chrome.action.setTitle({ tabId, title: 'Inmo-Tool — Capturado automáticamente' });
      if (batchWaitFinish && tabId === batchWaitTabId) batchWaitFinish(true);
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
    getBatchState().then((s) => sendResponse(InmoBatch.progress(s))).catch(() =>
      sendResponse(InmoBatch.progress(null)),
    );
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
});

// ═══ Batch capture ══════════════════════════════════════════════════════════
//
// A fully-automated sequential queue (issue #262, D-043). The operator clicks
// "Capturar todas (N)" once on a listing page; from there this worker:
//   1. seeds the harvested detail URLs into capture_worklist (added_via
//      'derived'), then loads the portal's PENDING set as the queue,
//   2. opens each URL in a NEW tab it ACTIVATES itself — an active tab renders
//      normally (background tabs are throttled, which is why a 40-tab bomb
//      never works, see the issue), so the content script's existing
//      auto-capture (issue #254) fires and posts the capture,
//   3. waits for that tab's AUTO_CAPTURE_DONE (or a timeout), closes the tab,
//      waits a JITTERED delay (WAF safety — never a fixed metronome), advances.
// Progress lives in chrome.storage.session so a reopened popup (or a
// respawned worker) can render N/M with stop/resume.
//
// MV3 eviction: the driver loop is in-memory. Chrome can evict the worker
// mid-run (e.g. a slow/CAPTCHA page emitting no events for ~30 s). The queue
// STATE survives (storage.session), and a watchdog (chrome.alarms +
// onStartup/onInstalled, plus every popup open) re-attaches the loop from the
// persisted index and closes the tab that was orphaned at eviction time. The
// open tab id is persisted too, so a respawned worker can find and close it.

const BATCH_KEY = 'inmoBatch';
// The tab the loop currently has open, persisted so a respawned worker can
// reconcile (close) it after an eviction rather than leaking it.
const BATCH_TAB_KEY = 'inmoBatchTab';
// Watchdog alarm that recovers a stranded run without any user action.
const BATCH_ALARM = 'inmoBatchWatchdog';
// 0.5 min = 30 s, Chrome's minimum periodic-alarm interval. Short enough to
// recover an unattended run promptly, long enough not to churn. (A popup open
// recovers instantly via GET_BATCH_STATE; this is the no-user-present net.)
const BATCH_ALARM_PERIOD_MIN = 0.5;
// Pace between closing one tab and opening the next: a randomised dwell whose
// BASE lengthens as the run gets long (InmoBatch.paceBaseMs) — the mandatory
// 4–9 s minimum holds at the start, and 100+ listing sweeps space out. The
// spread stays constant. Long enough not to read as a burst to the portal's
// WAF; short enough to keep the awaited loop alive under the MV3 ~30 s
// idle-kill (each iteration also spends several seconds opening + capturing a
// tab). See D-043 for the tradeoff.
const BATCH_PACE_SPREAD_MS = 5000;
// Give one page this long to render + auto-capture before counting it failed
// and moving on (mirrors the content script's own MAX_WAIT_MS, plus slack for
// tab creation).
const BATCH_CAPTURE_TIMEOUT_MS = 30000;

// Transient (not persisted): the tab the loop is currently driving, the
// resolver that unblocks the current wait, and a re-entrancy guard so only one
// loop runs at a time.
let batchTabId = null;
let batchWaitTabId = null;
let batchWaitFinish = null;
let batchLooping = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBatchState() {
  const o = await chrome.storage.session.get(BATCH_KEY);
  return o[BATCH_KEY] || null;
}

async function setBatchState(state) {
  await chrome.storage.session.set({ [BATCH_KEY]: state });
}

/** Persist / read / clear the currently-open batch tab id (eviction recovery). */
async function persistBatchTab(tabId) {
  await chrome.storage.session.set({ [BATCH_TAB_KEY]: tabId });
}
async function readBatchTab() {
  const o = await chrome.storage.session.get(BATCH_TAB_KEY);
  const id = o[BATCH_TAB_KEY];
  return typeof id === 'number' ? id : null;
}
async function clearBatchTab() {
  await chrome.storage.session.remove(BATCH_TAB_KEY);
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
 * Learn the search-results page's OWN URL as a capture-to-infer example
 * (issue #293). Fire-and-forget: a failure here must never block the batch —
 * saving the URL grammar is a side-benefit of mining, not a precondition.
 */
async function saveSearchUrlExample(searchUrl) {
  if (!searchUrl) return;
  try {
    const { apiUrl, apiKey } = await getApiConfig();
    await fetch(`${apiUrl}/api/extension/search-url-example`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
      body: JSON.stringify({ url: searchUrl }),
    });
  } catch {
    /* best-effort: never let a learned-example save disrupt the capture run */
  }
}

/**
 * Begin a batch run for one portal. Seeds the harvested URLs, then builds the
 * queue from the portal's current pending set (so already-captured listings are
 * skipped and any pre-existing pending rows are swept too). Fires the loop.
 */
async function startBatch({ portal, urls, searchUrl }) {
  // Piggyback capture-to-infer: also learn this search page's URL grammar.
  await saveSearchUrlExample(searchUrl);
  if (Array.isArray(urls) && urls.length > 0) {
    await seedWorklist(urls);
  }
  const pending = await fetchPendingUrls(portal);
  const state = InmoBatch.makeBatchState(pending);
  await setBatchState(state);
  runBatchLoop(); // fire-and-forget; drives tabs until paused/stopped/done
  return { started: true, total: pending.length };
}

/** Apply a pure state transition (pause/resume) and return fresh progress. */
async function mutateBatch(fn) {
  const state = await getBatchState();
  const next = fn(state);
  await setBatchState(next);
  return InmoBatch.progress(next);
}

/** Stop the run: mark done, unblock any in-flight wait, close the open tab. */
async function stopBatch() {
  const state = await getBatchState();
  const next = InmoBatch.stop(state);
  await setBatchState(next);
  if (batchWaitFinish) batchWaitFinish(false);
  // Close whichever tab is open — the in-memory id on the fast path, or the
  // persisted id if a respawned worker is stopping a run it didn't start.
  const openTab = batchTabId != null ? batchTabId : await readBatchTab();
  if (openTab != null) {
    try {
      await chrome.tabs.remove(openTab);
    } catch {
      /* tab already gone */
    }
    batchTabId = null;
  }
  await clearBatchTab();
  return InmoBatch.progress(next);
}

/**
 * Wait for the given tab to signal AUTO_CAPTURE_DONE, or time out. Resolves
 * true on capture, false on timeout/stop. Only one wait is ever outstanding
 * (the queue is strictly sequential).
 */
function waitForCaptureSignal(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      batchWaitFinish = null;
      batchWaitTabId = null;
      resolve(ok);
    };
    batchWaitTabId = tabId;
    batchWaitFinish = finish;
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/** Open+activate one detail URL, wait for its capture, then close the tab. */
async function captureOnePage(url) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: true });
  } catch {
    return false;
  }
  batchTabId = tab.id;
  // Persist the open tab id BEFORE the (up to 30 s) wait — that's exactly the
  // window in which Chrome may evict the worker, and a respawned one must be
  // able to find and close this tab.
  await persistBatchTab(tab.id);
  const ok = await waitForCaptureSignal(tab.id, BATCH_CAPTURE_TIMEOUT_MS);
  try {
    await chrome.tabs.remove(tab.id);
  } catch {
    /* tab already closed */
  }
  if (batchTabId === tab.id) batchTabId = null;
  await clearBatchTab();
  return ok;
}

/**
 * The sequential driver. Re-entrancy-guarded so PAUSE→RESUME (or a duplicate
 * START) never runs two loops. Re-reads the persisted state each iteration so
 * a pause/stop that lands DURING a page's capture takes effect the moment that
 * page settles — the current page always finishes cleanly, we never orphan a
 * half-captured tab.
 */
async function runBatchLoop() {
  if (batchLooping) return;
  batchLooping = true;
  try {
    for (;;) {
      let state = await getBatchState();
      if (!InmoBatch.isActive(state)) break;
      const url = InmoBatch.currentUrl(state);
      if (!url) break;

      const ok = await captureOnePage(url);

      // The wait may have been ended by STOP — re-read before recording.
      const after = await getBatchState();
      if (!after || after.status === InmoBatch.STATUSES.DONE) break;

      // Record the page we just processed. It IS done regardless of a pause
      // that arrived mid-capture, so advance the pointer + counts on a
      // running clone, then re-apply the pause if the queue isn't finished.
      const wasPaused = after.status === InmoBatch.STATUSES.PAUSED;
      const recorded = InmoBatch.recordResult(
        { ...after, status: InmoBatch.STATUSES.RUNNING },
        ok,
      );
      const finalState =
        wasPaused && recorded.status !== InmoBatch.STATUSES.DONE
          ? { ...recorded, status: InmoBatch.STATUSES.PAUSED }
          : recorded;
      await setBatchState(finalState);

      if (finalState.status !== InmoBatch.STATUSES.RUNNING) break; // paused/done
      // Gentle backoff: the dwell BASE grows with how many pages we've done, so
      // long sweeps space out (4–9 s minimum preserved at the start). D-043.
      const done = finalState.captured + finalState.failed;
      await sleep(InmoBatch.jitterDelay(InmoBatch.paceBaseMs(done), BATCH_PACE_SPREAD_MS));
    }
  } finally {
    batchLooping = false;
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
async function reattachIfStranded() {
  if (batchLooping) return; // loop alive — nothing stranded
  const state = await getBatchState();
  if (!InmoBatch.shouldReattach(state, batchLooping)) return;

  const persistedTabId = await readBatchTab();
  const orphan = InmoBatch.orphanTabToClose(state, batchLooping, persistedTabId);
  if (orphan != null) {
    try {
      await chrome.tabs.remove(orphan);
    } catch {
      /* tab already gone */
    }
    await clearBatchTab();
  }
  runBatchLoop(); // resumes from the persisted index
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
  if (alarm.name === BATCH_ALARM) reattachIfStranded();
});
chrome.runtime.onStartup.addListener(() => {
  ensureBatchWatchdog();
  reattachIfStranded();
});
chrome.runtime.onInstalled.addListener(() => {
  ensureBatchWatchdog();
  reattachIfStranded();
});
// Top-level: fires whenever the worker (re)spawns, including after an eviction
// that no lifecycle event covers.
ensureBatchWatchdog();
reattachIfStranded();

async function getApiConfig() {
  const config = await chrome.storage.sync.get(['apiUrl', 'apiKey']);
  return {
    apiUrl: (config.apiUrl || 'http://localhost:4000').replace(/\/+$/, ''),
    apiKey: config.apiKey || '',
  };
}

/**
 * Submit captured HTML for parsing. This does NOT return the parsed
 * result — the inmo-tool backend processes captures asynchronously in a
 * separate service (etl/capture.py's poll loop, see the dashboard route's
 * own docstring for why). Returns {success, capture_id}; the caller
 * (popup.js) polls CHECK_CAPTURE_STATUS with that id for the real result.
 */
async function handleExtraction({ url, html }) {
  const { apiUrl, apiKey } = await getApiConfig();

  const response = await fetch(`${apiUrl}/api/extension/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': apiKey },
    body: JSON.stringify({ url, html }),
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
