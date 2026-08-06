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
        };
      }
      return InmoBatch.progress(await getBatchState());
    })()
      .then(sendResponse)
      .catch(() => sendResponse(InmoBatch.progress(null)));
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
// A fully-automated BOUNDED-CONCURRENCY queue (issue #262 + #318, D-043). The
// operator clicks "Capturar todas (N)" once on a listing page; from there this
// worker:
//   1. seeds the harvested detail URLs into capture_worklist (added_via
//      'derived'), then loads the portal's PENDING set as the queue,
//   2. opens up to BATCH_CONCURRENCY URLs at a time, each in a NEW tab it
//      ACTIVATES itself — an active tab renders normally (background tabs are
//      throttled, which is why an unbounded wall of tabs never works, see the
//      issue), so the content script's existing auto-capture (issue #254) fires
//      and posts the capture,
//   3. STAGGERS launches by a JITTERED delay (WAF safety — never a simultaneous
//      burst), waits for each tab's AUTO_CAPTURE_DONE (or a timeout), closes the
//      tab, and keeps the in-flight pool topped up to the cap.
// Progress lives in chrome.storage.session so a reopened popup (or a respawned
// worker) can render N/M with stop/resume.
//
// Why the cap is small (see D-043): WAF safety (idealista CAPTCHA / aliseda
// `Disallow: /`) AND Chrome background-tab render throttling — only the ACTIVE
// tab renders reliably, so the jittered stagger gives each tab a foreground
// window to render+capture before the next launch steals focus. Past a small N,
// later in-flight tabs sit throttled in the background and time out, so MORE
// concurrency HURTS reliability. N=3 (cap 5) is the balance.
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
// Watchdog alarm that recovers a stranded run without any user action.
const BATCH_ALARM = 'inmoBatchWatchdog';
// 0.5 min = 30 s, Chrome's minimum periodic-alarm interval. Short enough to
// recover an unattended run promptly, long enough not to churn. (A popup open
// recovers instantly via GET_BATCH_STATE; this is the no-user-present net.)
const BATCH_ALARM_PERIOD_MIN = 0.5;
// How many detail tabs may be open at once. Kept small and CAPPED (batch.js
// clamps to MAX_CONCURRENCY) — WAF safety + Chrome background-tab render
// throttling. See D-043 for why more isn't better.
const BATCH_CONCURRENCY = 3;
// Stagger between one tab LAUNCH and the next: a randomised dwell whose BASE
// lengthens as the run gets long (InmoBatch.paceBaseMs) — the mandatory 4–9 s
// minimum holds at the start, and 100+ listing sweeps space out. The spread
// stays constant. This is the pacing guarantee that keeps the N tabs from
// opening simultaneously. See D-043 for the tradeoff.
const BATCH_PACE_SPREAD_MS = 5000;
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
/** True once the run was stopped mid-enumeration (enum state cleared). */
async function enumerationStopped() {
  return (await getEnumState()) == null;
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
 */
async function startBatch({ portal, urls, searchUrl }) {
  // Piggyback capture-to-infer: also learn this search page's URL grammar.
  await saveSearchUrlExample(searchUrl);
  const page1 = Array.isArray(urls) ? urls : [];
  if (page1.length > 0) {
    await seedWorklist(page1);
  }
  // Enter the enumeration phase so a reopened popup shows discovery progress.
  await setEnumState({
    status: 'enumerating',
    portal,
    discovered: page1.length,
    page: 1,
  });
  // Walk the remaining results pages, then build + run the capture queue.
  // Fire-and-forget: on any enumeration failure we still fall through to
  // capturing whatever was seeded (page 1 at minimum), never leaving the run
  // wedged in the enumeration phase.
  runEnumerationThenCapture(portal, searchUrl, page1).catch(async () => {
    await clearEnumState();
    await runCaptureQueue(portal);
  });
  return { started: true, enumerating: true, total: page1.length };
}

/** Enumerate every results page, then hand off to the capture queue. */
async function runEnumerationThenCapture(portal, searchUrl, page1Urls) {
  try {
    await enumerateResultsPages(portal, searchUrl, page1Urls);
  } finally {
    await clearEnumState();
    await runCaptureQueue(portal);
  }
}

/** Build the capture queue from the portal's pending set and fire the loop. */
async function runCaptureQueue(portal) {
  const pending = await fetchPendingUrls(portal);
  const state = InmoBatch.makeBatchState(pending, BATCH_CONCURRENCY);
  await setBatchState(state);
  runBatchLoop(); // fire-and-forget; drives tabs until paused/stopped/done
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
  const D = self.InmoDetect;
  const seen = new Set(
    (page1Urls || []).map((u) => D.matchKey(u)).filter(Boolean),
  );
  let current = D.stripCaptureSignal(searchUrl);
  let tabId = null;
  try {
    for (let page = 1; page <= D.RESULTS_PAGE_CAP; page++) {
      if (await enumerationStopped()) break;
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
      await sleep(
        InmoBatch.jitterDelay(InmoBatch.paceBaseMs(page - 1), BATCH_PACE_SPREAD_MS),
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

/** Stop the run: mark done, unblock every in-flight wait, close all open tabs. */
async function stopBatch() {
  // Clearing the enumeration state signals any in-progress results-page walk to
  // bail on its next iteration (issue #362); its reused tab is in batchTabIds
  // (and persisted), so the tab close below reaps it.
  await clearEnumState();
  const next = await updateBatchState((state) => InmoBatch.stop(state));
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

/** Open+activate one detail URL, wait for its capture, then close the tab. */
async function captureOnePage(url) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: true });
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
 * Drive ONE page end to end: open+activate its tab, wait for the capture (or
 * timeout), close it, then record the outcome against that exact slot. Settles
 * may land OUT OF ORDER across the concurrent tabs, so we address the slot by
 * `index` rather than a moving pointer. recordResultAt ignores a stopped queue
 * and flips to `done` only when nothing is left pending or in flight.
 */
async function driveOnePage(index, url) {
  const ok = await captureOnePage(url);
  // Atomic: two tabs settling in the same tick would otherwise interleave this
  // get-modify-set and lose one's slot flip (issue #321).
  await updateBatchState((state) => InmoBatch.recordResultAt(state, index, ok));
}

/**
 * The bounded-concurrency driver. Re-entrancy-guarded so PAUSE→RESUME (or a
 * duplicate START) never runs two loops. Keeps up to BATCH_CONCURRENCY tabs in
 * flight: it launches the next pending URL, STAGGERS by a jittered delay, and
 * tops the pool back up whenever a tab settles. Re-reads the persisted state
 * around every launch so a pause/stop takes effect promptly — in-flight pages
 * always finish cleanly (their tabs close in `captureOnePage`), we never orphan
 * a half-captured tab. The `finally` drains any still-open tabs so none leak
 * past the loop's exit (e.g. after a pause with tabs mid-capture).
 */
async function runBatchLoop() {
  if (batchLooping) return;
  batchLooping = true;
  const inflight = new Map(); // index -> Promise (the driveOnePage in progress)
  try {
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
        const p = driveOnePage(idx, launch.url).finally(() => inflight.delete(idx));
        inflight.set(idx, p);
        // Jittered stagger (WAF safety — never a simultaneous burst). BASE grows
        // with how many pages have settled so long sweeps space out (4–9 s
        // minimum preserved at the start). D-043.
        const done = InmoBatch.progress(state).done;
        await sleep(InmoBatch.jitterDelay(InmoBatch.paceBaseMs(done), BATCH_PACE_SPREAD_MS));
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
  let state = await getBatchState();
  if (!InmoBatch.shouldReattach(state, batchLooping)) return;

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

  // Those in-flight slots referred to the tabs we just closed — reset them to
  // pending so the restarted driver re-launches them (capture is idempotent).
  state = await updateBatchState((s) => InmoBatch.resetInflightToPending(s));
  runBatchLoop(); // resumes from the persisted slots
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
