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
    return { success: false, error: { message: 'La pestaña activa no es una URL de búsqueda de Idealista.' } };
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
  // Concurrency comes from the operator's config (clamped), issue #410.
  const { concurrency } = await getBatchConfig();
  const state = InmoBatch.makeBatchState(pending, concurrency);
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
  const cfg = await getBatchConfig();
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
  // The periodic watchdog both re-attaches a stranded batch AND ticks the auto
  // driver (its eviction-safe net); the one-shot AUTO_ALARM ticks it promptly
  // after the inter-batch cooldown. Both funnel into the same idempotent tick.
  if (alarm.name === BATCH_ALARM) {
    reattachIfStranded();
    autoTick();
  }
  if (alarm.name === AUTO_ALARM) autoTick();
});
chrome.runtime.onStartup.addListener(() => {
  ensureBatchWatchdog();
  reattachIfStranded();
  autoTick();
});
chrome.runtime.onInstalled.addListener(() => {
  ensureBatchWatchdog();
  reattachIfStranded();
  autoTick();
});
// Top-level: fires whenever the worker (re)spawns, including after an eviction
// that no lifecycle event covers. The auto driver's top-level tick is at the end
// of the auto block below (its state consts must be initialised first).
ensureBatchWatchdog();
reattachIfStranded();

// ═══ Auto-capture continuous driver (issue #424) ════════════════════════════
//
// Auto mode leaves the capture page open and drains the WHOLE worklist without
// the operator clicking per batch:
//   1. fetch the next ≤N pending URLs, prioritised (due-first then oldest) by
//      GET /api/etl/worklist?pending=1&limit=N&dueOnly=1 — see runAutoBatch /
//      the route. By default (`dueOnly=1`, issue #434) only portals whose
//      connector staleness window has elapsed are returned; the "Forzar" toggle
//      requests `dueOnly=0` to re-capture even not-due / already-done listings.
//      When nothing is due the set is empty → Auto idles until the next tick
//      (respecting the inter-batch timeout), it never spins,
//   2. run the EXISTING bounded-concurrency capture queue over them (so the
//      concurrency cap + WAF-safe jittered stagger are unchanged),
//   3. on completion, schedule the NEXT batch via chrome.alarms after the
//      configured cooldown (NOT setTimeout — that dies with an evicted worker),
//   4. repeat until Auto is turned off or the worklist empties (then it
//      slow-polls in case new work arrives).
//
// MV3 survival: the whole loop is data-driven. The auto state (enabled, status,
// batchesDone, lastBatchAt) lives in chrome.storage.session (survives eviction);
// scheduling is entirely alarm-driven. If the worker is evicted mid-batch, the
// top-level reattach restarts the capture loop and the periodic BATCH_ALARM tick
// detects the finished batch and schedules the next one — the same discipline as
// reattachIfStranded. The single-driver guard (batchLooping / batch state) means
// Auto and a manual batch never double-run.

const AUTO_KEY = 'inmoAuto';
// One-shot alarm that fires after the inter-batch cooldown to start the next
// batch. Chrome clamps any alarm sooner than ~30 s up to 30 s, which is why the
// configured timeout floor (batch.js MIN_AUTO_TIMEOUT_SEC) is 30 s — a smaller
// value would silently become 30 s and misrepresent the real wait.
const AUTO_ALARM = 'inmoAutoNext';
// In-memory re-entrancy guard so the periodic and one-shot alarms (or a rapid
// START_AUTO) can't run two ticks at once.
let autoTicking = false;

async function getAutoState() {
  const o = await chrome.storage.session.get(AUTO_KEY);
  return o[AUTO_KEY] || null;
}
async function setAutoState(state) {
  await chrome.storage.session.set({ [AUTO_KEY]: state });
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

/** True while a capture batch (auto or manual) is in flight — the single-driver guard. */
async function isBatchActive() {
  if (batchLooping) return true;
  if ((await getEnumState()) != null) return true;
  const s = await getBatchState();
  return InmoBatch.isActive(s) || (!!s && s.status === InmoBatch.STATUSES.PAUSED);
}

/**
 * Fetch the next ≤N pending URLs (prioritised) from the worklist endpoint.
 * `force` (issue #434): false → `dueOnly=1` (only portals whose staleness window
 * has elapsed — the default); true → `dueOnly=0` (the whole pending set, so
 * already-done / not-due listings are re-captured).
 */
async function fetchNextPending(portal, limit, force) {
  const { apiUrl, apiKey } = await getApiConfig();
  const params = new URLSearchParams({
    pending: '1',
    limit: String(limit),
    dueOnly: force ? '0' : '1',
  });
  if (portal) params.set('portal', portal);
  const response = await fetch(`${apiUrl}/api/etl/worklist?${params.toString()}`, {
    headers: { 'x-admin-key': apiKey },
  });
  if (!response.ok) throw new Error(`worklist pending: ${response.status}`);
  const data = await response.json();
  return {
    urls: Array.isArray(data.urls) ? data.urls.filter((u) => typeof u === 'string') : [],
    totalPending:
      typeof data.totalPending === 'number' ? data.totalPending : undefined,
  };
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
    await setAutoState({ ...auto, enabled: false, status: InmoBatch.AUTO_STATUS.STOPPED });
  }
  await disarmAutoAlarm();
  return getAutoProgress();
}

/** Combined auto + current-batch progress for the popup. */
async function getAutoProgress() {
  const auto = await getAutoState();
  const batch = InmoBatch.progress(await getBatchState());
  if (!auto) {
    // No live auto state: surface the persisted "Forzar" preference so the
    // popup's checkbox reflects it even before Auto is turned on (issue #434).
    const { force } = await getAutoConfig();
    return { enabled: false, status: InmoBatch.AUTO_STATUS.IDLE, force, batch };
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
 * Start one auto batch: fetch the next ≤N pending URLs, build + run the
 * bounded-concurrency queue, then (inline, fast path) begin the cooldown. Guards
 * against starting on top of a live batch. On an empty worklist it keeps Auto ON
 * and slow-polls; on a backend error it backs off for one timeout.
 */
async function runAutoBatch() {
  const auto = await getAutoState();
  if (!auto || auto.enabled !== true) return;
  if (await isBatchActive()) return; // single-driver guard

  let next;
  try {
    next = await fetchNextPending(auto.portal, auto.batchSize, auto.force === true);
  } catch {
    // Backend hiccup: back off one timeout and try again (Auto stays ON).
    await setAutoState({
      ...auto,
      status: InmoBatch.AUTO_STATUS.WAITING,
      lastBatchAt: Date.now(),
    });
    scheduleAutoAlarm(auto.timeoutSec);
    return;
  }

  const urls = next.urls || [];
  if (!InmoBatch.shouldContinueAuto(auto, urls.length)) {
    // Worklist drained (or Auto turned off mid-fetch). Keep Auto ON and
    // slow-poll for new work — re-check on the next cooldown alarm.
    await setAutoState({
      ...auto,
      status: InmoBatch.AUTO_STATUS.EMPTY,
      lastBatchAt: Date.now(),
      totalPending: next.totalPending ?? 0,
    });
    scheduleAutoAlarm(auto.timeoutSec);
    return;
  }

  // Build + run the capture queue over this batch. Concurrency + pacing come
  // from the SAME operator config (#410/#411) the manual path uses.
  const { concurrency } = await getBatchConfig();
  await setBatchState(InmoBatch.makeBatchState(urls, concurrency));
  await setAutoState({
    ...auto,
    status: InmoBatch.AUTO_STATUS.RUNNING,
    totalPending: next.totalPending ?? auto.totalPending,
  });
  await runBatchLoop(); // resolves when the batch finishes (or was paused/stopped)
  await onAutoBatchComplete();
}

/**
 * A batch finished under Auto: count it and begin the cooldown before the next.
 * Idempotent — only acts while status is RUNNING, so the inline call and a
 * watchdog-detected completion can't double-count. No-op once Auto is off.
 */
async function onAutoBatchComplete() {
  const auto = await getAutoState();
  if (!auto || auto.enabled !== true) return;
  if (auto.status !== InmoBatch.AUTO_STATUS.RUNNING) return;
  await setAutoState({
    ...auto,
    status: InmoBatch.AUTO_STATUS.WAITING,
    batchesDone: auto.batchesDone + 1,
    lastBatchAt: Date.now(),
  });
  scheduleAutoAlarm(auto.timeoutSec);
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
