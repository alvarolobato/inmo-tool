/**
 * popup.js — Main popup logic.
 *
 * Two modes, chosen on open:
 *   - Detail page → capture THIS page (unchanged single-capture flow): send
 *     HTML to the capture endpoint and poll for the parsed result.
 *   - Listing/search page (or a batch run already in progress) → batch capture
 *     (issue #262): harvest the detail links, seed the worklist, and drive a
 *     fully-automated bounded-concurrency queue (several tabs at a time, #318)
 *     in the background service worker, showing live N/M progress with
 *     stop/resume. The operator clicks once.
 *
 * Forked from property_web_scraper's popup.js — see NOTICE.md. Haul
 * creation/history/limit-reached/no-key states are removed: there is
 * exactly one backend, always configured, no account model.
 */

const $ = (sel) => document.querySelector(sel);

const states = {
  loading: $('#state-loading'),
  unsupported: $('#state-unsupported'),
  error: $('#state-error'),
  results: $('#state-results'),
  batch: $('#state-batch'),
  guide: $('#state-guide'),
  validation: $('#state-validation'),
};

let extractedData = null;

// Processing happens in a separate backend service on its own poll cycle
// (etl/capture.py, ~10s interval, see the capture API route's docstring)
// — a human waiting in this popup shouldn't wait unboundedly for it.
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 20000;
// How often the popup re-reads batch progress from the service worker while a
// run is live.
const BATCH_POLL_MS = 1000;

function showState(name) {
  Object.entries(states).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function init() {
  showState('loading');

  // If a batch run is already in flight (popup reopened mid-run), show it
  // immediately — regardless of what tab is active now.
  try {
    const prog = await chrome.runtime.sendMessage({ type: 'GET_BATCH_STATE' });
    if (
      prog &&
      (prog.status === 'running' ||
        prog.status === 'paused' ||
        prog.status === 'enumerating')
    ) {
      enterBatchMode(null, prog);
      return;
    }
  } catch {
    /* no worker / no state — fall through to per-tab detection */
  }

  // If Auto mode is ON (draining the worklist unattended), show its panel
  // regardless of the active tab so the operator can watch progress / turn it off.
  try {
    const auto = await chrome.runtime.sendMessage({ type: 'GET_AUTO_STATE' });
    if (auto && auto.enabled) {
      enterBatchMode(null, auto.batch || null);
      renderAutoStatus(auto);
      return;
    }
  } catch {
    /* no worker / no state — fall through */
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    showError('No se pudo acceder a la pestaña actual');
    return;
  }

  if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) {
    showState('unsupported');
    return;
  }

  // Validation mode (issue #478 P3): if this tab was opened from "Validar
  // filtros", show the pin panel instead of the capture flows — capture is
  // suppressed while validating, so there's nothing to capture here.
  try {
    const validation = await chrome.runtime.sendMessage({
      type: 'GET_VALIDATION_STATE',
      tabId: tab.id,
    });
    if (validation && validation.active) {
      enterValidationMode(tab, validation);
      return;
    }
  } catch {
    /* no worker / no state — fall through to normal detection */
  }

  // Ask the content script to classify the page and (for a listing page)
  // harvest the detail links. Inject it first if it isn't loaded yet.
  let page;
  try {
    page = await detectPage(tab);
  } catch {
    page = null;
  }

  if (page?.isListing) {
    enterBatchMode({ tab, portal: page.portal, detailUrls: page.detailUrls || [] }, null);
    return;
  }

  // Guided capture (issue #237): a SUPPORTED portal page that is neither a
  // detail nor a search page (home / saved search / filter form). Don't
  // blind-capture it (the backend can't parse a non-listing page and would
  // error) — guide the owner with their worklist progress and a shortcut to
  // the next pending listing. A supported-portal DETAIL page still falls
  // through to the single-capture path below.
  if (page?.role === 'other' && page?.supportedPortal) {
    await enterGuideMode(tab, page.supportedPortal);
    return;
  }

  // On the Inmo-Tool dashboard itself (e.g. the /captura page) there is nothing
  // to single-capture — this is the natural home for the Auto toggle (issue
  // #424: "leave the capture page open"). Show the auto hub instead of trying to
  // capture the dashboard page.
  if (await isDashboardTab(tab)) {
    await enterAutoHub();
    return;
  }

  // Unsupported host (a portal not yet wired, or Cimenta2's SPA) keeps the
  // universal manual-capture escape hatch: capture whatever tab we're on.
  await runSingleCapture(tab);
}

/** True when `tab` is on the configured Inmo-Tool dashboard origin. */
async function isDashboardTab(tab) {
  try {
    const { apiUrl } = await chrome.storage.sync.get(['apiUrl']);
    const dashOrigin = new URL(apiUrl || 'http://localhost:4000').origin;
    return new URL(tab.url).origin === dashOrigin;
  } catch {
    return false;
  }
}

/**
 * The Auto hub (issue #424): a home for the Auto toggle when the operator opens
 * the popup on the dashboard rather than a portal listing page. No single-batch
 * context — just start/stop Auto and watch its progress.
 */
async function enterAutoHub() {
  enterBatchMode(null, null);
  $('#batch-title').textContent = 'Captura automática';
  $('#batch-sub').textContent =
    'Activa el modo Auto para vaciar toda la lista de captura, lote a lote.';
  $('#batch-start-btn').classList.add('hidden');
  $('#batch-progress').classList.add('hidden');
  hideBatchControls();
  let auto = null;
  try {
    auto = await chrome.runtime.sendMessage({ type: 'GET_AUTO_STATE' });
  } catch {
    /* no worker */
  }
  renderAutoStatus(auto);
  if (auto && auto.enabled) startBatchPolling();
}

// ─── Guided capture (supported portal, non-capturable page) ─────

/**
 * Guide the owner from a supported-portal page they can't directly capture.
 * Fetches that portal's worklist progress via the background worker (which
 * holds the admin key) and shows N/M captured plus an "open the next pending
 * listing" shortcut. Keeps a "Capturar esta página igualmente" escape hatch so
 * manual capture of the current page is always reachable.
 */
async function enterGuideMode(tab, portal) {
  showState('guide');
  const cap = portal.charAt(0).toUpperCase() + portal.slice(1);
  $('#guide-title').textContent = `Estás en ${cap}`;
  $('#guide-sub').textContent = 'Cargando tu progreso de captura…';
  $('#guide-open-next-btn').classList.add('hidden');
  $('#guide-capture-anyway-btn').onclick = () => runSingleCapture(tab);

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'GET_WORKLIST_PROGRESS', portal });
  } catch {
    res = null;
  }

  const prog = res?.success ? res.progress : null;
  if (prog && prog.total > 0) {
    $('#guide-sub').textContent =
      `${cap}: ${prog.captured}/${prog.total} capturadas · ${prog.pending} pendientes.`;
  } else {
    $('#guide-sub').textContent =
      `Aún no hay anuncios de ${cap} en tu lista de captura. ` +
      'Abre una página de resultados para detectarlos, o captura este anuncio.';
  }

  if (prog?.nextUrl) {
    const btn = $('#guide-open-next-btn');
    btn.textContent = `Abrir siguiente pendiente (${prog.pending})`;
    btn.classList.remove('hidden');
    btn.onclick = () => {
      chrome.tabs.create({ url: prog.nextUrl, active: true });
      window.close();
    };
  }
}

// ─── Validation mode (issue #478 P3) ────────────────────────────

/**
 * Show the validation panel for a tab opened from "Validar filtros". Displays
 * which (connector × profile) is being validated and offers to pin the tab's
 * CURRENT URL as that connector's filter (the owner may have tuned it on the
 * portal) or to exit validation mode. The admin key lives only in the worker,
 * so pinning goes through SAVE_VALIDATION_URL (never a PUT from here).
 */
function enterValidationMode(tab, state) {
  showState('validation');
  const cap = String(state.connector || '')
    .replace(/^./, (c) => c.toUpperCase());
  $('#validation-title').textContent = 'Modo validación';
  $('#validation-sub').textContent =
    `Validando ${cap || 'conector'} para el perfil #${state.profileId}.`;
  const status = $('#validation-status');
  status.classList.add('hidden');
  status.textContent = '';

  const saveBtn = $('#validation-save-btn');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Usar esta URL como filtro';
  saveBtn.onclick = () => onSaveValidationUrl(tab);

  $('#validation-exit-btn').onclick = () => onExitValidation(tab);
}

/** Pin the active tab's current URL as the connector filter via the worker. */
async function onSaveValidationUrl(tab) {
  const btn = $('#validation-save-btn');
  const status = $('#validation-status');
  btn.disabled = true;
  btn.textContent = 'Guardando…';
  status.classList.add('hidden');

  // Re-read the tab's CURRENT url — the owner may have navigated/tuned since the
  // popup opened. The worker strips the signal + validates + attaches the key.
  let currentUrl = tab.url;
  try {
    const fresh = await chrome.tabs.get(tab.id);
    if (fresh && fresh.url) currentUrl = fresh.url;
  } catch {
    /* fall back to the url we already have */
  }

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'SAVE_VALIDATION_URL',
      tabId: tab.id,
      url: currentUrl,
    });
  } catch (err) {
    res = { success: false, error: { message: err.message } };
  }

  if (res && res.success) {
    status.textContent = 'Filtro guardado ✓';
    btn.textContent = 'Guardar de nuevo';
  } else {
    status.textContent =
      (res && res.error && res.error.message) || 'No se pudo guardar el filtro';
    btn.textContent = 'Usar esta URL como filtro';
  }
  status.classList.remove('hidden');
  btn.disabled = false;
}

/** Exit validation mode for this tab, then re-run detection for it. */
async function onExitValidation(tab) {
  try {
    await chrome.runtime.sendMessage({ type: 'END_VALIDATION', tabId: tab.id });
  } catch {
    /* ignore — re-init handles the rest */
  }
  init();
}

async function detectPage(tab) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'DETECT_PAGE' });
  } catch {
    // Content script not loaded yet — inject detect.js + content-script.js.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['detect.js', 'content-script.js'],
    });
    return chrome.tabs.sendMessage(tab.id, { type: 'DETECT_PAGE' });
  }
}

// ─── Single-page capture (detail page) ──────────────────────────

async function runSingleCapture(tab) {
  showState('loading');
  let captured;
  try {
    captured = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_HTML' });
  } catch {
    // Content script not loaded (e.g. extension just installed) — inject it.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-script.js'],
      });
      captured = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_HTML' });
    } catch {
      showError('No se pudo capturar la página. Recarga y vuelve a intentarlo.');
      return;
    }
  }

  if (!captured?.html) {
    showError('No se recibió contenido HTML de la página');
    return;
  }

  let submitResult;
  try {
    submitResult = await chrome.runtime.sendMessage({
      type: 'EXTRACT',
      url: captured.url,
      html: captured.html,
    });
  } catch (err) {
    showError(err.message || 'La llamada a la API falló');
    return;
  }

  if (!submitResult?.success || !submitResult.capture_id) {
    showError(submitResult?.error?.message || 'No se pudo enviar la captura');
    return;
  }

  await pollForResult(submitResult.capture_id);
}

async function pollForResult(captureId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let status;
    try {
      status = await chrome.runtime.sendMessage({
        type: 'CHECK_CAPTURE_STATUS',
        captureId,
      });
    } catch (err) {
      showError(err.message || 'No se pudo consultar el estado');
      return;
    }

    if (!status?.success && status?.status !== 'failed') {
      showError(status?.error?.message || 'No se pudo consultar el estado');
      return;
    }

    if (status.status === 'failed') {
      showError(status.error?.message || 'La extracción falló');
      return;
    }

    if (status.status === 'done') {
      extractedData = status;
      renderResults(status);
      return;
    }

    // Issue #292: the backend recognised this as a SEARCH/results listing
    // page, not a detail page — a clean outcome, not a failure. Its detail
    // links were harvested into the batch-capture worklist. Show it in the
    // (neutral 📋) batch state as an informational message, with no live run
    // to drive.
    if (status.status === 'listing') {
      showListingResult(status.detail_links ?? 0);
      return;
    }

    // Still 'pending' — wait and check again.
    await sleep(POLL_INTERVAL_MS);
  }

  showError(
    'Todavía procesando — puede tardar unos segundos más de lo normal. ' +
      'Revisa el dashboard de Inmo-Tool en breve.',
  );
}

// Issue #292: render a captured listing/search page as a clean, neutral
// outcome (not the ⚠️ error state). Reuses the 📋 batch panel but hides the
// live-run progress bar and its action buttons — there is nothing to drive,
// the detail links are already queued in the batch worklist.
function showListingResult(detailLinks) {
  showState('batch');
  $('#batch-title').textContent = 'Página de resultados';
  $('#batch-sub').textContent =
    detailLinks > 0
      ? `${detailLinks} anuncio(s) añadidos a la lista de captura por lotes.`
      : 'No se encontraron enlaces de detalle en esta página.';
  $('#batch-progress').classList.add('hidden');
  const actions = document.querySelector('.batch-actions');
  if (actions) actions.classList.add('hidden');
  const hint = document.querySelector('.batch-hint');
  if (hint) hint.classList.add('hidden');
}

// ─── Batch capture (listing page) ───────────────────────────────

// The batch context when starting a fresh run (null once a run is live and the
// popup was reopened to watch it).
let batchContext = null;
let batchPollTimer = null;

/**
 * Enter batch mode. `ctx` ({ tab, portal, detailUrls }) is present when the
 * operator is on a fresh listing page; `existingProgress` is present when a run
 * is already going and we're just attaching the progress view.
 */
function enterBatchMode(ctx, existingProgress) {
  batchContext = ctx;
  showState('batch');

  $('#batch-start-btn').onclick = onStartBatch;
  $('#batch-pause-btn').onclick = () => sendBatchControl('PAUSE_BATCH');
  $('#batch-resume-btn').onclick = () => sendBatchControl('RESUME_BATCH');
  $('#batch-stop-btn').onclick = () => sendBatchControl('STOP_BATCH');
  $('#batch-auto-btn').onclick = onToggleAuto;
  $('#batch-force-chk').onchange = onToggleForce;

  // Capturar URL de búsqueda (issue #475): only meaningful on an Idealista
  // results page, where "Dibuja tu zona" encodes the polygon into `shape=`.
  setupSearchUrlCapture(ctx?.tab || null);

  // Modo observación (issue #488): the passive search-URL observer toggle.
  setupObserveToggle();

  if (existingProgress) {
    renderBatchProgress(existingProgress);
    startBatchPolling();
    return;
  }

  const startBtn = $('#batch-start-btn');
  const n = ctx?.detailUrls?.length || 0;
  $('#batch-title').textContent = 'Página de resultados';
  $('#batch-sub').textContent =
    n > 0
      ? `${n} anuncio(s) detectado(s) en esta página.`
      : 'No se han detectado anuncios en esta página.';
  startBtn.textContent = n > 0 ? `Capturar todas (${n})` : 'Capturar todas';
  startBtn.disabled = n === 0;
  startBtn.classList.remove('hidden');
  $('#batch-progress').classList.add('hidden');
  hideBatchControls();
}

async function onStartBatch() {
  if (!batchContext) return;
  const startBtn = $('#batch-start-btn');
  startBtn.disabled = true;
  startBtn.textContent = 'Iniciando…';

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'START_BATCH',
      portal: batchContext.portal,
      urls: batchContext.detailUrls,
      // The search-results page URL we're mining. Piggybacks capture-to-infer
      // (issue #293): the background worker also saves this as a learned
      // search-URL example. No separate UI — starting a batch already is an
      // explicit owner action on a search page worth mining.
      searchUrl: batchContext.tab?.url || null,
    });
  } catch (err) {
    showError(err.message || 'No se pudo iniciar la captura por lotes');
    return;
  }

  if (!res?.started) {
    showError(res?.error?.message || 'No se pudo iniciar la captura por lotes');
    return;
  }

  startBtn.classList.add('hidden');
  $('#batch-progress').classList.remove('hidden');
  // A batch first ENUMERATES every results page (issue #362) before capturing;
  // reflect that phase so the operator sees discovery, not a frozen 0/0.
  if (res.enumerating) {
    $('#batch-sub').textContent = 'Descubriendo anuncios en todas las páginas…';
    renderBatchProgress({
      total: res.total || 0,
      done: 0,
      captured: 0,
      failed: 0,
      status: 'enumerating',
      discovered: res.total || 0,
    });
  } else {
    $('#batch-sub').textContent = 'Capturando anuncios en varias pestañas…';
    renderBatchProgress({ total: res.total, done: 0, captured: 0, failed: 0, status: 'running' });
  }
  startBatchPolling();
}

async function sendBatchControl(type) {
  let prog;
  try {
    prog = await chrome.runtime.sendMessage({ type });
  } catch {
    return;
  }
  if (prog) renderBatchProgress(prog);
  if (type === 'STOP_BATCH') stopBatchPolling();
}

function startBatchPolling() {
  stopBatchPolling();
  batchPollTimer = setInterval(async () => {
    // Read the auto state first: it carries the current-batch progress AND the
    // auto counters (N lotes hechos, pendientes), so one message covers both.
    let auto;
    try {
      auto = await chrome.runtime.sendMessage({ type: 'GET_AUTO_STATE' });
    } catch {
      auto = null;
    }
    renderAutoStatus(auto);

    // While Auto is ON keep polling even between batches (status may be
    // 'waiting'/'empty' with no live batch). Otherwise fall back to the plain
    // batch-progress read and stop once the manual batch is done.
    if (auto && auto.enabled) {
      if (auto.batch) renderBatchProgress(auto.batch);
      return;
    }
    let prog;
    try {
      prog = await chrome.runtime.sendMessage({ type: 'GET_BATCH_STATE' });
    } catch {
      return;
    }
    if (prog) renderBatchProgress(prog);
    if (prog && prog.status === 'done') stopBatchPolling();
  }, BATCH_POLL_MS);
}

// ─── Auto mode (issue #424) ─────────────────────────────────────

/** Human label for each auto status. */
const AUTO_STATUS_LABELS = {
  running: 'capturando lote',
  waiting: 'esperando al siguiente lote',
  empty: 'lista vacía — esperando trabajo nuevo',
  stopped: 'deteniéndose tras el lote en curso',
  idle: 'iniciando…',
};

/**
 * Render the Auto toggle + status line from a GET_AUTO_STATE response. When Auto
 * is ON the button offers to stop and the line shows the counters (batches done,
 * total pending, phase); when OFF it offers to start and the line hides.
 */
function renderAutoStatus(auto) {
  const btn = $('#batch-auto-btn');
  const line = $('#batch-auto-status');
  if (!btn || !line) return;

  // Reflect the persisted "Forzar" preference (issue #434) — the background
  // always surfaces `force` (from the live auto state or, when Auto is off, the
  // stored preference), so the checkbox stays in sync across popup opens.
  const forceChk = $('#batch-force-chk');
  if (forceChk && auto && typeof auto.force === 'boolean') {
    forceChk.checked = auto.force;
  }

  if (auto && auto.enabled) {
    btn.textContent = 'Auto: detener';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-secondary');
    const phase = AUTO_STATUS_LABELS[auto.status] || auto.status || '';
    const batches = auto.batchesDone || 0;
    const pending =
      typeof auto.totalPending === 'number' ? auto.totalPending : '—';
    const batchLine =
      auto.batch && auto.batch.total > 0
        ? ` · lote ${auto.batch.done || 0}/${auto.batch.total}`
        : '';
    line.textContent =
      `Auto activo · ${batches} lote(s) hechos · ${pending} pendientes` +
      `${batchLine} · ${phase}`;
    line.classList.remove('hidden');
  } else {
    btn.textContent = 'Auto: capturar toda la lista';
    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-primary');
    line.classList.add('hidden');
  }
}

/**
 * Toggle "Forzar" (issue #434): persist the preference in the background
 * (chrome.storage.sync) and, if Auto is running, update the live state so the
 * next batch respects it. Re-renders from the returned progress.
 */
async function onToggleForce() {
  const chk = $('#batch-force-chk');
  if (!chk) return;
  let auto = null;
  try {
    auto = await chrome.runtime.sendMessage({
      type: 'SET_AUTO_FORCE',
      force: chk.checked,
    });
  } catch {
    /* ignore — next poll refreshes state */
  }
  if (auto) renderAutoStatus(auto);
}

/** Toggle Auto mode on/off. */
async function onToggleAuto() {
  const btn = $('#batch-auto-btn');
  btn.disabled = true;
  let auto;
  try {
    auto = await chrome.runtime.sendMessage({ type: 'GET_AUTO_STATE' });
  } catch {
    auto = null;
  }
  const enabled = !!(auto && auto.enabled);
  try {
    if (enabled) {
      auto = await chrome.runtime.sendMessage({ type: 'STOP_AUTO' });
    } else {
      // Drain the WHOLE worklist (all portals) — portal:null. The start button
      // and per-batch controls are irrelevant in auto mode.
      auto = await chrome.runtime.sendMessage({ type: 'START_AUTO', portal: null });
      $('#batch-start-btn').classList.add('hidden');
      $('#batch-progress').classList.remove('hidden');
      startBatchPolling();
    }
  } catch {
    /* ignore — next poll refreshes state */
  }
  btn.disabled = false;
  renderAutoStatus(auto);
}

function stopBatchPolling() {
  if (batchPollTimer) {
    clearInterval(batchPollTimer);
    batchPollTimer = null;
  }
}

function hideBatchControls() {
  $('#batch-pause-btn').classList.add('hidden');
  $('#batch-resume-btn').classList.add('hidden');
  $('#batch-stop-btn').classList.add('hidden');
}

// ─── Capturar URL de búsqueda (issue #475, part of #471) ────────

/**
 * Reveal + wire the "Capturar URL de búsqueda" button when `tab` is an
 * Idealista results page (the drawn-zone `shape=` grammar is Idealista's). On
 * any other page (or none) the button stays hidden — nothing to capture. Uses
 * the shared pure helper (self.InmoSearchUrl) so the host check is identical to
 * the background worker's re-validation.
 */
function setupSearchUrlCapture(tab) {
  const wrap = $('#capture-search-url-wrap');
  const status = $('#capture-search-url-status');
  const btn = $('#capture-search-url-btn');
  status.classList.add('hidden');
  status.textContent = '';
  const isIdealista =
    !!tab && !!tab.url && self.InmoSearchUrl.isIdealistaUrl(tab.url);
  if (!isIdealista) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  btn.disabled = false;
  btn.textContent = 'Capturar URL de búsqueda';
  btn.onclick = () => onCaptureSearchUrl(tab);
}

// ─── Modo observación (issue #488, part of #471) ────────────────

// The passive observer defaults ON (mirrors content-script.js OBSERVE_DEFAULT);
// an absent stored value reads as enabled.
const OBSERVE_MODE_DEFAULT = true;

/**
 * Load + wire the "modo observación" toggle. Reflects the stored
 * chrome.storage.sync `observeMode` preference (default ON) and persists any
 * change so the content-script observer picks it up on the next page.
 */
async function setupObserveToggle() {
  const chk = $("#observe-mode-chk");
  if (!chk) return;
  let enabled = OBSERVE_MODE_DEFAULT;
  try {
    const cfg = await chrome.storage.sync.get("observeMode");
    enabled = cfg.observeMode === undefined ? OBSERVE_MODE_DEFAULT : !!cfg.observeMode;
  } catch {
    /* storage unavailable — fall back to the default */
  }
  chk.checked = enabled;
  chk.onchange = async () => {
    try {
      await chrome.storage.sync.set({ observeMode: chk.checked });
    } catch {
      /* best-effort — the next open re-reads the stored value */
    }
  };
}

/** Send the active tab's Idealista results URL to the dashboard to persist. */
async function onCaptureSearchUrl(tab) {
  const btn = $('#capture-search-url-btn');
  const status = $('#capture-search-url-status');
  const payload = self.InmoSearchUrl.buildSearchUrlCapture({
    url: tab.url,
    title: tab.title,
  });
  if (!payload) {
    status.textContent = 'La pestaña activa no es una URL de búsqueda de Idealista.';
    status.classList.remove('hidden');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Capturando…';
  status.classList.add('hidden');
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'CAPTURE_SEARCH_URL', payload });
  } catch (err) {
    res = { success: false, error: { message: err.message } };
  }
  if (res && res.success) {
    status.textContent = 'URL capturada ✓';
    btn.textContent = 'Capturar de nuevo';
  } else {
    status.textContent = (res && res.error && res.error.message) || 'No se pudo capturar la URL';
    btn.textContent = 'Capturar URL de búsqueda';
  }
  status.classList.remove('hidden');
  btn.disabled = false;
}

function renderBatchProgress(prog) {
  const total = prog.total || 0;
  const done = prog.done || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  $('#batch-progress').classList.remove('hidden');

  const startBtn = $('#batch-start-btn');
  const pauseBtn = $('#batch-pause-btn');
  const resumeBtn = $('#batch-resume-btn');
  const stopBtn = $('#batch-stop-btn');

  // Enumeration phase (issue #362): pages are still being discovered, so there
  // is no total to divide by yet — show the growing discovered count and a
  // pulsing indeterminate bar. Only Stop is offered (Pause/Resume act on the
  // capture queue, which hasn't been built yet).
  if (prog.status === 'enumerating') {
    const discovered = prog.discovered ?? total;
    $('#batch-title').textContent = 'Página de resultados';
    $('#batch-sub').textContent = 'Descubriendo anuncios en todas las páginas…';
    $('#batch-bar-fill').style.width = '100%';
    $('#batch-count').textContent = `${discovered} anuncio(s) encontrados…`;
    startBtn.classList.add('hidden');
    pauseBtn.classList.add('hidden');
    resumeBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    return;
  }

  $('#batch-bar-fill').style.width = `${pct}%`;

  const failedNote = prog.failed > 0 ? ` · ${prog.failed} fallida(s)` : '';
  $('#batch-count').textContent = `${done}/${total} capturadas${failedNote}`;

  if (prog.status === 'done') {
    startBtn.classList.add('hidden');
    hideBatchControls();
    $('#batch-title').textContent = 'Captura por lotes completada';
    $('#batch-sub').textContent = `${prog.captured} capturada(s), ${prog.failed} fallida(s).`;
    return;
  }

  startBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  if (prog.status === 'paused') {
    pauseBtn.classList.add('hidden');
    resumeBtn.classList.remove('hidden');
    $('#batch-sub').textContent = 'En pausa.';
  } else {
    resumeBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    $('#batch-sub').textContent = 'Capturando anuncios en varias pestañas…';
  }
}

// ─── Results / errors (single capture) ──────────────────────────

function showError(msg) {
  $('#error-message').textContent = msg;
  showState('error');
}

$('#retry-btn').addEventListener('click', init);

function renderResults(data) {
  const title = data.title || 'Anuncio de propiedad';
  $('#result-title').textContent = title.length > 60 ? title.slice(0, 57) + '…' : title;

  $('#result-price').textContent = data.price || 'Precio no disponible';

  const extracted = data.fields_extracted || 0;
  const available = data.fields_available || 0;
  const ratePercent = available > 0 ? Math.round((extracted / available) * 100) : 0;
  $('#result-rate').textContent = `${extracted}/${available} campos extraídos (${ratePercent}%)`;

  const link = $('#view-property-link');
  if (data.property_url) {
    link.href = data.property_url;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }

  showState('results');
}

$('#copy-json-btn').addEventListener('click', async () => {
  if (!extractedData) return;
  await navigator.clipboard.writeText(JSON.stringify(extractedData, null, 2));
  const btn = $('#copy-json-btn');
  const original = btn.innerHTML;
  btn.innerHTML = '✓ Copiado';
  setTimeout(() => {
    btn.innerHTML = original;
  }, 2000);
});

init();
