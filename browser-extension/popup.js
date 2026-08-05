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
    if (prog && (prog.status === 'running' || prog.status === 'paused')) {
      enterBatchMode(null, prog);
      return;
    }
  } catch {
    /* no worker / no state — fall through to per-tab detection */
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

  await runSingleCapture(tab);
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
  $('#batch-sub').textContent = 'Capturando anuncios en varias pestañas…';
  $('#batch-progress').classList.remove('hidden');
  renderBatchProgress({ total: res.total, done: 0, captured: 0, failed: 0, status: 'running' });
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

function renderBatchProgress(prog) {
  const total = prog.total || 0;
  const done = prog.done || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  $('#batch-progress').classList.remove('hidden');
  $('#batch-bar-fill').style.width = `${pct}%`;

  const failedNote = prog.failed > 0 ? ` · ${prog.failed} fallida(s)` : '';
  $('#batch-count').textContent = `${done}/${total} capturadas${failedNote}`;

  const startBtn = $('#batch-start-btn');
  const pauseBtn = $('#batch-pause-btn');
  const resumeBtn = $('#batch-resume-btn');
  const stopBtn = $('#batch-stop-btn');

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
